import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { request } from "undici";
import {
  consoleCommandSchema,
  createServerSchema,
  filePathSchema,
  updateServerSchema,
  writeFileSchema,
} from "@cofemine/shared";
import { prisma } from "../db.js";
import { requireUser } from "../auth/context.js";
import { assertServerPermission, requireGlobalPermission } from "../auth/rbac.js";
import { writeAudit } from "../audit/service.js";
import { NodeClient } from "../nodes/node-client.js";
import {
  createServerRecord,
  provisionServerOnNode,
  readCurseforgeApiKey,
  reconcileAndReprovision,
} from "./service.js";
import { readDownloadProxy } from "../integrations/download-proxy.js";
import { resetWatchdogState } from "./install-watchdog.js";
import { reconcileMany } from "./status.js";

/** Parse the CSV-of-numeric-modIds form that itzg expects in
 *  CF_EXCLUDE_MODS. Permissive on whitespace and stray empty
 *  entries (some pack manifests carry trailing commas). */
function parseExcludedIds(csv: string | undefined): Set<string> {
  if (!csv) return new Set();
  return new Set(
    csv
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s))
  );
}

function serializeExcludedIds(set: Set<string>): string {
  return [...set].filter((s) => /^\d+$/.test(s)).join(",");
}

/** Fetch CF mod metadata for a list of numeric ids in a single
 *  /v1/mods POST. Returns enriched objects in the order ids were
 *  given; ids with no CF match come back as `{ modId }` only. */
type CfExcludedEntry = {
  modId: number;
  name?: string;
  slug?: string;
  icon?: string | null;
  pageUrl?: string;
};
async function curseforgeBulkLookup(
  ids: string[],
  apiKey: string,
  log?: { warn: (obj: unknown, msg?: string) => void }
): Promise<CfExcludedEntry[]> {
  const numeric = [...new Set(ids.map((s) => Number(s)))].filter((n) =>
    Number.isFinite(n)
  );
  if (numeric.length === 0) return [];
  try {
    const res = await request("https://api.curseforge.com/v1/mods", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({ modIds: numeric }),
    });
    if (res.statusCode >= 400) {
      await res.body.dump().catch(() => {});
      return numeric.map((modId) => ({ modId }));
    }
    const body = (await res.body.json()) as any;
    const byId = new Map<number, any>();
    for (const m of body?.data ?? []) {
      if (typeof m?.id === "number") byId.set(m.id, m);
    }
    return numeric.map((modId) => {
      const m = byId.get(modId);
      if (!m) return { modId };
      return {
        modId,
        name: (m.name as string) ?? undefined,
        slug: (m.slug as string) ?? undefined,
        icon: (m.logo?.url as string | undefined) ?? null,
        pageUrl:
          (m.links?.websiteUrl as string | undefined) ??
          (m.slug
            ? `https://www.curseforge.com/minecraft/mc-mods/${m.slug}`
            : undefined),
      };
    });
  } catch (err) {
    log?.warn({ err }, "curseforge bulk lookup failed");
    return numeric.map((modId) => ({ modId }));
  }
}

export async function serversRoutes(app: FastifyInstance): Promise<void> {
  // List servers visible to the user.
  app.get("/", async (req) => {
    const user = requireUser(req);
    // OWNER/ADMIN see all; OPERATOR/VIEWER see only servers they are members of.
    const canSeeAll = user.role === "OWNER" || user.role === "ADMIN";
    const where = canSeeAll
      ? {}
      : { memberships: { some: { userId: user.id } } };
    const servers = await prisma.server.findMany({
      where,
      include: { node: true },
      orderBy: { createdAt: "desc" },
    });
    // Reconcile DB-held status with the live container state on each
    // node before returning. Without this the server row stays stuck
    // on "starting" forever because nothing else flips it back to
    // "running" once the container actually finishes booting.
    const live = await reconcileMany(
      servers.map((s) => ({
        id: s.id,
        nodeId: s.nodeId,
        status: s.status,
      }))
    );
    return servers.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      type: s.type,
      version: s.version,
      status: live[s.id] ?? s.status,
      memoryMb: s.memoryMb,
      ports: s.ports,
      node: { id: s.node.id, name: s.node.name, status: s.node.status },
      lastStartedAt: s.lastStartedAt,
      createdAt: s.createdAt,
    }));
  });

  app.get("/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.view");
    const server = await prisma.server.findUnique({
      where: { id },
      include: { node: true, template: true },
    });
    if (!server) return reply.code(404).send({ error: "Not found" });
    // Same status-reconcile pass as the list endpoint, scoped to one
    // server. Pulls the container's current docker state from the
    // agent and rewrites DB if it diverged from what we had.
    const reconciled = await reconcileMany([
      { id: server.id, nodeId: server.nodeId, status: server.status },
    ]);
    return { ...server, status: reconciled[server.id] ?? server.status };
  });

  app.post(
    "/",
    { preHandler: requireGlobalPermission("server.create") },
    async (req, reply) => {
      const body = createServerSchema.parse(req.body);
      const server = await createServerRecord(body);
      try {
        await provisionServerOnNode(server.id);
      } catch (err) {
        // Clean up the DB row if the agent couldn't provision.
        await prisma.server.delete({ where: { id: server.id } }).catch(() => {});
        throw err;
      }
      await writeAudit(req, {
        action: "server.create",
        resource: server.id,
        metadata: { name: server.name, type: server.type, version: server.version },
      });
      return reply.code(201).send({ id: server.id });
    }
  );

  app.patch("/:id", async (req) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.edit");
    const body = updateServerSchema.parse(req.body);
    const updated = await prisma.server.update({
      where: { id },
      data: body as any,
    });
    await writeAudit(req, { action: "server.update", resource: id });
    return { ok: true, server: updated };
  });

  app.delete("/:id", async (req) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.delete");
    const server = await prisma.server.findUnique({ where: { id } });
    if (!server) return { ok: true };
    try {
      const client = await NodeClient.forId(server.nodeId);
      await client.call("DELETE", `/servers/${server.id}`);
    } catch (err) {
      req.log.warn({ err }, "agent delete failed; continuing with DB cleanup");
    }
    await prisma.server.delete({ where: { id } });
    resetWatchdogState(id);
    await writeAudit(req, { action: "server.delete", resource: id });
    return { ok: true };
  });

  // Manual "repair": reprovision the container with env recomputed from
  // current integration secrets (picks up CF_API_KEY / MODRINTH config
  // that changed after create). /data is preserved.
  app.post("/:id/repair", async (req) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.edit");
    const result = await reconcileAndReprovision(id);
    await writeAudit(req, {
      action: "server.repair",
      resource: id,
      metadata: { envChanged: result.changed },
    });
    return { ok: true, ...result };
  });

  // Toggle the per-server "route modpack install through the download
  // proxy" flag and reprovision the container so the new JAVA_TOOL_OPTIONS
  // take effect. Useful after an install has failed with a CDN timeout:
  // flip on → Start → install tunnels through the proxy. Once the server
  // boots cleanly, flip off to keep MC's own traffic direct.
  const toggleProxySchema = z.object({ enabled: z.boolean() });
  app.post("/:id/install-proxy", async (req) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.edit");
    const body = toggleProxySchema.parse(req.body);
    // If the user is turning this ON, make sure there's actually a proxy
    // to route through. Without the check the flag would flip silently
    // and the "Retry via proxy" button would appear to do nothing.
    if (body.enabled) {
      const proxy = await readDownloadProxy();
      if (!proxy) {
        const err = new Error(
          "Download proxy is not configured. Set host/port in Integrations → Download proxy first."
        );
        (err as any).statusCode = 409;
        throw err;
      }
    }
    const server = await prisma.server.findUniqueOrThrow({ where: { id } });
    const env = { ...((server.env as Record<string, string> | null) ?? {}) };
    if (body.enabled) {
      env["__COFEMINE_INSTALL_PROXY"] = "1";
    } else {
      delete env["__COFEMINE_INSTALL_PROXY"];
    }
    await prisma.server.update({
      where: { id },
      data: { env: env as unknown as object },
    });
    const result = await reconcileAndReprovision(id);
    await writeAudit(req, {
      action: "server.install-proxy.toggle",
      resource: id,
      metadata: { enabled: body.enabled },
    });
    return { ok: true, ...result };
  });

  // Lifecycle actions proxied to the agent.
  for (const action of ["start", "stop", "restart", "kill"] as const) {
    app.post(`/:id/${action}`, async (req) => {
      const { id } = req.params as { id: string };
      await assertServerPermission(req, id, "server.control");
      const server = await prisma.server.findUniqueOrThrow({ where: { id } });
      // Auto-heal: for modpack-source servers, make sure the container
      // has the current CF_API_KEY / MODRINTH config baked in. If the
      // user added the CF key *after* creating the server, or we
      // extended the injected env in a panel upgrade, reprovision
      // transparently here so Start actually boots.
      if (
        action === "start" &&
        (server.type === "CURSEFORGE" || server.type === "MODRINTH")
      ) {
        const env = (server.env as Record<string, string> | null) ?? {};
        const needsCfKey =
          server.type === "CURSEFORGE" && !env.CF_API_KEY;
        if (needsCfKey) {
          req.log.info(
            { id },
            "auto-reprovisioning before start (missing CF_API_KEY)"
          );
          await reconcileAndReprovision(id).catch((err) =>
            req.log.warn({ err }, "auto-reprovision failed; attempting start anyway")
          );
        }
      }
      const client = await NodeClient.forId(server.nodeId);
      await client.call("POST", `/servers/${id}/${action}`);
      const newStatus =
        action === "start"
          ? "starting"
          : action === "stop"
            ? "stopping"
            : action === "restart"
              ? "starting"
              : "stopped";
      await prisma.server.update({
        where: { id },
        data: {
          status: newStatus,
          lastStartedAt: action === "start" ? new Date() : undefined,
        },
      });
      // Reset the install-watchdog attempt counter whenever the user
      // explicitly (re)starts or stops the server so we get a fresh
      // proxy-retry budget on the next install session.
      if (action === "start" || action === "restart" || action === "stop") {
        resetWatchdogState(id);
      }
      await writeAudit(req, { action: `server.${action}`, resource: id });
      return { ok: true };
    });
  }

  app.post("/:id/command", async (req) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.control");
    const body = consoleCommandSchema.parse(req.body);
    const server = await prisma.server.findUniqueOrThrow({ where: { id } });
    const client = await NodeClient.forId(server.nodeId);
    await client.call("POST", `/servers/${id}/command`, body);
    await writeAudit(req, {
      action: "server.command",
      resource: id,
      metadata: { command: body.command },
    });
    return { ok: true };
  });

  app.post("/:id/clone", async (req, reply) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.view");
    const source = await prisma.server.findUniqueOrThrow({ where: { id } });
    const cloneName = `${source.name}-clone`;

    // Clones inherit the source's host ports — if the source is still
    // running (or any other server on the node claims the same port),
    // `docker run` fails with "port is already allocated" the moment
    // the clone tries to start. Pre-shift the host ports to the next
    // free ones on this node so start just works.
    const srcPorts = Array.isArray(source.ports)
      ? (source.ports as Array<{
          host: number;
          container: number;
          protocol: "tcp" | "udp";
        }>)
      : [];
    const peers = await prisma.server.findMany({
      where: { nodeId: source.nodeId, id: { not: source.id } },
      select: { ports: true },
    });
    const busy = new Set<string>();
    for (const p of peers) {
      const arr = Array.isArray(p.ports) ? (p.ports as any[]) : [];
      for (const pp of arr) {
        if (pp && typeof pp.host === "number" && typeof pp.protocol === "string") {
          busy.add(`${pp.protocol}:${pp.host}`);
        }
      }
    }
    // Always treat the source's live ports as busy — the source might be
    // running even if no other row claims them.
    for (const pp of srcPorts) busy.add(`${pp.protocol}:${pp.host}`);
    const clonePorts = srcPorts.map((pp) => {
      let host = pp.host;
      while (busy.has(`${pp.protocol}:${host}`)) host += 1;
      busy.add(`${pp.protocol}:${host}`);
      return { ...pp, host };
    });

    const cloned = await prisma.server.create({
      data: {
        name: cloneName,
        description: source.description,
        nodeId: source.nodeId,
        type: source.type,
        version: source.version,
        memoryMb: source.memoryMb,
        cpuLimit: source.cpuLimit,
        ports: clonePorts as any,
        env: source.env as any,
        eulaAccepted: source.eulaAccepted,
        templateId: source.templateId,
        status: "stopped",
      },
    });
    try {
      await provisionServerOnNode(cloned.id);
      // ask agent to copy /data
      const client = await NodeClient.forId(source.nodeId);
      await client.call("POST", `/servers/${cloned.id}/restore-from`, {
        sourceId: source.id,
      });
    } catch (err) {
      await prisma.server.delete({ where: { id: cloned.id } }).catch(() => {});
      throw err;
    }
    await writeAudit(req, {
      action: "server.clone",
      resource: cloned.id,
      metadata: { source: source.id },
    });
    return reply.code(201).send({ id: cloned.id });
  });

  // Files
  app.get("/:id/files", async (req) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.view");
    const path = (req.query as { path?: string }).path ?? "";
    if (path) filePathSchema.parse(path);
    const server = await prisma.server.findUniqueOrThrow({ where: { id } });
    const client = await NodeClient.forId(server.nodeId);
    return client.call("GET", `/servers/${id}/files?path=${encodeURIComponent(path)}`);
  });

  app.put("/:id/files", async (req) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.edit");
    const body = writeFileSchema.parse(req.body);
    const server = await prisma.server.findUniqueOrThrow({ where: { id } });
    const client = await NodeClient.forId(server.nodeId);
    await client.call("PUT", `/servers/${id}/files`, body);
    await writeAudit(req, {
      action: "server.files.write",
      resource: id,
      metadata: { path: body.path },
    });
    return { ok: true };
  });

  app.delete("/:id/files", async (req) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.edit");
    const path = (req.query as { path?: string }).path ?? "";
    filePathSchema.parse(path);
    const server = await prisma.server.findUniqueOrThrow({ where: { id } });
    const client = await NodeClient.forId(server.nodeId);
    await client.call("DELETE", `/servers/${id}/files?path=${encodeURIComponent(path)}`);
    await writeAudit(req, {
      action: "server.files.delete",
      resource: id,
      metadata: { path },
    });
    return { ok: true };
  });

  app.get("/:id/properties", async (req) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.view");
    const server = await prisma.server.findUniqueOrThrow({ where: { id } });
    const client = await NodeClient.forId(server.nodeId);
    return client.call("GET", `/servers/${id}/properties`);
  });

  app.put("/:id/properties", async (req) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.edit");
    const server = await prisma.server.findUniqueOrThrow({ where: { id } });
    const client = await NodeClient.forId(server.nodeId);
    await client.call("PUT", `/servers/${id}/properties`, req.body);
    await writeAudit(req, { action: "server.properties.update", resource: id });
    return { ok: true };
  });

  app.get("/:id/stats", async (req) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.view");
    const server = await prisma.server.findUniqueOrThrow({ where: { id } });
    const client = await NodeClient.forId(server.nodeId);
    return client.call("GET", `/servers/${id}/stats`);
  });

  app.get("/:id/players", async (req) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.view");
    const server = await prisma.server.findUniqueOrThrow({ where: { id } });
    const client = await NodeClient.forId(server.nodeId);
    return client.call("GET", `/servers/${id}/players`);
  });

  app.get("/:id/installed-content", async (req) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.view");
    const server = await prisma.server.findUniqueOrThrow({ where: { id } });
    const client = await NodeClient.forId(server.nodeId);
    // Pass the CurseForge API key via header so the agent can use it to
    // look up icons / names for jars that aren't on Modrinth. The key
    // only leaves the API over the internal agent channel, never reaches
    // the browser.
    //
    // For CURSEFORGE modpack servers, also force a CF lookup on every
    // jar (not just the unresolved ones). The Content tab's "exclude
    // from pack" button needs the numeric CF modId to write into
    // CF_EXCLUDE_MODS — without this header, popular mods like
    // Waystones resolve via Modrinth, the agent skips the CF call
    // for them, and the Ban button never appears.
    const cfKey = await readCurseforgeApiKey();
    const extra: Record<string, string> = {};
    if (cfKey) extra["x-cf-api-key"] = cfKey;
    if (server.type === "CURSEFORGE") extra["x-cf-resolve-all"] = "1";
    return client.call(
      "GET",
      `/servers/${id}/installed-content`,
      undefined,
      Object.keys(extra).length > 0 ? extra : undefined
    );
  });

  app.delete("/:id/installed-content", async (req) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.edit");
    const q = req.query as { type?: string; name?: string };
    const server = await prisma.server.findUniqueOrThrow({ where: { id } });
    const client = await NodeClient.forId(server.nodeId);
    await client.call(
      "DELETE",
      `/servers/${id}/installed-content?type=${encodeURIComponent(q.type ?? "")}&name=${encodeURIComponent(q.name ?? "")}`
    );
    await writeAudit(req, {
      action: "server.content.delete",
      resource: id,
      metadata: { type: q.type, name: q.name },
    });
    return { ok: true };
  });

  // ---------- CurseForge modpack exclusions ----------
  //
  // CF_EXCLUDE_MODS is a comma-separated list of numeric modIds that
  // itzg's auto-installer skips on the next pack install. We surface
  // it as three operations:
  //
  //   POST   /:id/cf-exclusions/exclude   { type, filename, modId }
  //     → add the mod to the list AND delete the existing jar from
  //       disk in one go (the user just clicked Trash on a CF-modpack
  //       server and wants the mod gone for good, not just locally).
  //   GET    /:id/cf-exclusions
  //     → enriched view of the current list (modId → {name, slug, icon})
  //       so the dedicated Exclusions tab can render proper cards.
  //   DELETE /:id/cf-exclusions/:modId
  //     → remove from the list. We do NOT auto-reinstall the jar; the
  //       next CF install / repair brings it back naturally.
  //
  // All three only make sense on type=CURSEFORGE servers. We hard-fail
  // with 409 on other server types so the UI never has to filter.

  app.post("/:id/cf-exclusions/exclude", async (req) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.edit");
    const body = z
      .object({
        type: z.enum(["mods", "plugins", "datapacks"]),
        filename: z.string().min(1),
        modId: z.number().int().positive(),
      })
      .parse(req.body);
    const server = await prisma.server.findUniqueOrThrow({ where: { id } });
    if (server.type !== "CURSEFORGE") {
      const err = new Error("This server is not a CurseForge modpack");
      (err as any).statusCode = 409;
      throw err;
    }
    const env = ((server.env as Record<string, string> | null) ?? {}) as Record<
      string,
      string
    >;
    const existing = parseExcludedIds(env.CF_EXCLUDE_MODS);
    existing.add(String(body.modId));
    const nextEnv = { ...env, CF_EXCLUDE_MODS: serializeExcludedIds(existing) };
    await prisma.server.update({
      where: { id },
      data: { env: nextEnv as unknown as object },
    });
    // Delete the file on the agent side. If it's already gone (race
    // with a parallel delete), don't fail the exclusion — the env
    // change is the more important half.
    try {
      const client = await NodeClient.forId(server.nodeId);
      await client.call(
        "DELETE",
        `/servers/${id}/installed-content?type=${encodeURIComponent(
          body.type
        )}&name=${encodeURIComponent(body.filename)}`
      );
    } catch (err) {
      // Log but don't throw — env update already committed.
      req.log.warn({ err }, "exclude-mod: file delete failed (non-fatal)");
    }
    // Reprovision so CF_EXCLUDE_MODS lands in the running container's
    // env for the next install attempt.
    await reconcileAndReprovision(id);
    await writeAudit(req, {
      action: "server.cf-exclusions.add",
      resource: id,
      metadata: { modId: body.modId, filename: body.filename },
    });
    return { ok: true, excluded: [...existing] };
  });

  app.get("/:id/cf-exclusions", async (req) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.view");
    const server = await prisma.server.findUniqueOrThrow({ where: { id } });
    const env = ((server.env as Record<string, string> | null) ?? {}) as Record<
      string,
      string
    >;
    const ids = [...parseExcludedIds(env.CF_EXCLUDE_MODS)];
    if (ids.length === 0) return { excluded: [] };
    const cfKey = await readCurseforgeApiKey();
    if (!cfKey) {
      // No CF integration → can't enrich names. Return the bare ids
      // so the UI can still show "modId 12345" placeholders.
      return {
        excluded: ids.map((modId) => ({ modId: Number(modId) })),
      };
    }
    const enriched = await curseforgeBulkLookup(ids, cfKey, req.log);
    return { excluded: enriched };
  });

  app.delete("/:id/cf-exclusions/:modId", async (req) => {
    const { id, modId } = req.params as { id: string; modId: string };
    await assertServerPermission(req, id, "server.edit");
    const server = await prisma.server.findUniqueOrThrow({ where: { id } });
    if (server.type !== "CURSEFORGE") {
      const err = new Error("This server is not a CurseForge modpack");
      (err as any).statusCode = 409;
      throw err;
    }
    const env = ((server.env as Record<string, string> | null) ?? {}) as Record<
      string,
      string
    >;
    const set = parseExcludedIds(env.CF_EXCLUDE_MODS);
    set.delete(String(modId));
    const nextEnv = { ...env };
    const ser = serializeExcludedIds(set);
    if (ser) nextEnv.CF_EXCLUDE_MODS = ser;
    else delete nextEnv.CF_EXCLUDE_MODS;
    await prisma.server.update({
      where: { id },
      data: { env: nextEnv as unknown as object },
    });
    await reconcileAndReprovision(id);
    await writeAudit(req, {
      action: "server.cf-exclusions.remove",
      resource: id,
      metadata: { modId },
    });
    return { ok: true, excluded: [...set] };
  });

  // ---------- Loader version override ----------
  //
  // Lets the user pin a specific NeoForge / Forge / Fabric / Quilt
  // loader version on an already-existing server, including modpack
  // servers (CURSEFORGE / MODRINTH) that bake their own version into
  // the pack manifest. itzg supports this:
  //   • For CURSEFORGE: NEOFORGE_VERSION + CF_OVERRIDE_LOADER_VERSION=true
  //   • For Modrinth: setting NEOFORGE_VERSION etc. is enough — itzg
  //     applies the override after the pack's loader is determined.
  //   • For native loaders (FORGE / NEOFORGE / FABRIC / QUILT server
  //     types): just the version env var.
  //
  // We don't try to validate the version exists upstream — the meta
  // route already populates the dropdown from canonical sources, so
  // garbage input would only come from a handcrafted call.

  app.post("/:id/loader-version", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await assertServerPermission(req, id, "server.edit");
    } catch (err) {
      // Already a 403/401 with a message — let it through unchanged.
      throw err;
    }
    const body = z
      .object({
        // null clears the override (server falls back to the pack /
        // image default).
        loader: z
          .enum(["neoforge", "forge", "fabric", "quilt"])
          .nullable(),
        version: z.string().min(1).max(64).nullable(),
        // The installer needs the MC version for Forge / Fabric / Quilt
        // — mavens shape the URL as `<mcVersion>-<loaderVersion>`.
        // Optional because for NeoForge we can derive it from the
        // loader version itself.
        mcVersion: z.string().min(1).max(32).optional(),
      })
      .parse(req.body);
    // Wrap the rest in an explicit try so any unexpected throw —
    // Prisma constraint, agent network blip, archiver init failure —
    // gets logged with full stack on the panel side AND propagated
    // to the client with a non-empty message. Without this the user
    // saw a bare "Internal Server Error" with nothing to act on.
    try {
    const server = await prisma.server.findUniqueOrThrow({ where: { id } });
    const env = ((server.env as Record<string, string> | null) ?? {}) as Record<
      string,
      string
    >;
    // Strip every loader-version key first, so switching loader (e.g.
    // forge → neoforge) doesn't leave the previous one as a stale
    // override. itzg picks one based on TYPE / pack manifest, but a
    // stale FORGE_VERSION + NEOFORGE_VERSION pair has bitten people
    // before.
    const loaderKeys = [
      "NEOFORGE_VERSION",
      "FORGE_VERSION",
      "FABRIC_LOADER_VERSION",
      "QUILT_LOADER_VERSION",
      "CF_OVERRIDE_LOADER_VERSION",
      // Strip the force-sync flag too — once the loader is correctly
      // installed we don't want to re-download the entire pack on
      // every restart. The next override-apply re-sets it.
      "CF_FORCE_SYNCHRONIZE",
      // Legacy from the previous attempt — strip if still present.
      "CF_FORCE_REINSTALL_MODLOADER",
    ];
    const next: Record<string, string> = { ...env };
    for (const k of loaderKeys) delete next[k];
    if (body.loader && body.version) {
      const map: Record<string, string> = {
        neoforge: "NEOFORGE_VERSION",
        forge: "FORGE_VERSION",
        fabric: "FABRIC_LOADER_VERSION",
        quilt: "QUILT_LOADER_VERSION",
      };
      next[map[body.loader]!] = body.version;
      // CF needs an explicit opt-in to override the pack-shipped
      // loader version. Setting it for non-CF servers is a no-op,
      // so cheaper to set unconditionally than to gate.
      next.CF_OVERRIDE_LOADER_VERSION = "true";
    }
    await prisma.server.update({
      where: { id },
      data: { env: next as unknown as object },
    });
    // Run the loader installer directly in a one-shot container.
    // This is the ONLY safe path for CF modpack servers — letting
    // itzg / mc-image-helper redo the install (via CF_FORCE_SYNCHRONIZE)
    // wipes any mods the user added on top of the pack and resets every
    // mod to its pack-default version, which is exactly NOT what
    // someone changing the loader version wants. The installer touches
    // run.sh + libraries/net/<loader>/ only; /data/mods, /data/world,
    // /data/config etc. are untouched.
    if (body.loader && body.version) {
      try {
        const client = await NodeClient.forId(server.nodeId);
        await client.call("POST", `/servers/${id}/install-modloader`, {
          loader: body.loader,
          version: body.version,
          mcVersion: body.mcVersion ?? null,
        });
      } catch (err) {
        req.log.warn({ err }, "loader installer call failed");
        const e = err as Error & { statusCode?: number };
        const wrapped = new Error(
          `Loader installer failed: ${e.message ?? "unknown error"}. Server env was updated, but the loader was NOT reinstalled — your mods are untouched.`
        );
        (wrapped as any).statusCode = e.statusCode ?? 500;
        throw wrapped;
      }
    }
    await reconcileAndReprovision(id);
    await writeAudit(req, {
      action: "server.loader-version.set",
      resource: id,
      metadata: { loader: body.loader, version: body.version },
    });
    return { ok: true, env: next };
    } catch (err) {
      // Log the full error with stack on the panel side so we can
      // tell from `docker logs cofemine-api-1` why the request failed
      // — the user only saw "Internal Server Error" before this guard.
      req.log.error(
        { err, serverId: id, loader: body.loader, version: body.version },
        "loader-version POST failed"
      );
      const e = err as Error & { statusCode?: number };
      const status = e.statusCode ?? 500;
      const message =
        (e.message && e.message.length > 0
          ? e.message
          : "loader-version request failed without a message");
      return reply.code(status).send({ error: message });
    }
  });

  app.get("/:id/loader-version", async (req) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.view");
    const server = await prisma.server.findUniqueOrThrow({ where: { id } });
    const env = ((server.env as Record<string, string> | null) ?? {}) as Record<
      string,
      string
    >;
    // Whichever of the four version env vars is currently set wins.
    // We prefer the "current loader's" var when it's clear (FORGE /
    // NEOFORGE / FABRIC / QUILT server types) but for modpacks the
    // first non-empty wins.
    const candidates: Array<{ loader: string; key: string }> = [
      { loader: "neoforge", key: "NEOFORGE_VERSION" },
      { loader: "forge", key: "FORGE_VERSION" },
      { loader: "fabric", key: "FABRIC_LOADER_VERSION" },
      { loader: "quilt", key: "QUILT_LOADER_VERSION" },
    ];
    for (const c of candidates) {
      if (env[c.key]) {
        return { loader: c.loader, version: env[c.key]! };
      }
    }
    return { loader: null, version: null };
  });

  // ---------- Client modpack manager ----------
  //
  // Per-server staging area for jars that should ship to friends as
  // part of the .mrpack export but NOT live in /data/mods (shaders,
  // minimaps, Iris/Sodium, Distant Horizons, JEI client extras, etc.).
  // The agent stores them at /data/.cofemine-client/mods/, hidden from
  // itzg's mod scanner so they never get loaded by the server JVM.
  //
  // Side metadata for every mod (server + client) lives in
  // /data/.cofemine-client/sides.json and is consulted by the .mrpack
  // export to set per-file env.client / env.server. "auto" = use the
  // mod's Modrinth client_side / server_side metadata.

  app.get("/:id/client-mods", async (req) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.view");
    const server = await prisma.server.findUniqueOrThrow({ where: { id } });
    const client = await NodeClient.forId(server.nodeId);
    return client.call("GET", `/servers/${id}/client-mods`);
  });

  app.post("/:id/client-mods", async (req) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.edit");
    const body = z
      .object({
        filename: z.string().min(1).max(256),
        contentBase64: z.string().min(1),
      })
      .parse(req.body);
    const server = await prisma.server.findUniqueOrThrow({ where: { id } });
    const client = await NodeClient.forId(server.nodeId);
    const res = await client.call(
      "POST",
      `/servers/${id}/client-mods`,
      body
    );
    await writeAudit(req, {
      action: "server.client-mods.upload",
      resource: id,
      metadata: { name: body.filename },
    });
    return res;
  });

  app.delete("/:id/client-mods", async (req) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.edit");
    const q = req.query as { name?: string };
    const server = await prisma.server.findUniqueOrThrow({ where: { id } });
    const client = await NodeClient.forId(server.nodeId);
    await client.call(
      "DELETE",
      `/servers/${id}/client-mods?name=${encodeURIComponent(q.name ?? "")}`
    );
    await writeAudit(req, {
      action: "server.client-mods.delete",
      resource: id,
      metadata: { name: q.name },
    });
    return { ok: true };
  });

  app.get("/:id/sides", async (req) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.view");
    const server = await prisma.server.findUniqueOrThrow({ where: { id } });
    const client = await NodeClient.forId(server.nodeId);
    return client.call("GET", `/servers/${id}/sides`);
  });

  app.put("/:id/sides", async (req) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.edit");
    const server = await prisma.server.findUniqueOrThrow({ where: { id } });
    const client = await NodeClient.forId(server.nodeId);
    return client.call("PUT", `/servers/${id}/sides`, req.body);
  });

  /**
   * Stream the agent's .mrpack export through to the browser. The
   * agent generates a ZIP on the fly — server mods + uploaded client
   * mods, each placed in the appropriate overrides path based on the
   * sides.json metadata. We don't buffer here; the response is piped
   * straight from agent → panel → browser.
   */
  app.get("/:id/export-mrpack", async (req, reply) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.view");
    const server = await prisma.server.findUniqueOrThrow({ where: { id } });
    const node = await prisma.node.findUniqueOrThrow({
      where: { id: server.nodeId },
    });
    // Derive loader + loaderVersion from env so the .mrpack manifest
    // tells the importer which loader profile to create. Falls back
    // to the server's stored MC version + a "no loader" pack (vanilla)
    // if nothing is set.
    const env = ((server.env as Record<string, string> | null) ?? {}) as Record<
      string,
      string
    >;
    let loader: string | null = null;
    let loaderVersion: string | null = null;
    if (env.NEOFORGE_VERSION) {
      loader = "neoforge";
      loaderVersion = env.NEOFORGE_VERSION;
    } else if (env.FORGE_VERSION) {
      loader = "forge";
      loaderVersion = env.FORGE_VERSION;
    } else if (env.FABRIC_LOADER_VERSION) {
      loader = "fabric";
      loaderVersion = env.FABRIC_LOADER_VERSION;
    } else if (env.QUILT_LOADER_VERSION) {
      loader = "quilt";
      loaderVersion = env.QUILT_LOADER_VERSION;
    }
    const params = new URLSearchParams();
    params.set("packName", server.name);
    params.set("mcVersion", server.version);
    if (loader) params.set("loader", loader);
    if (loaderVersion) params.set("loaderVersion", loaderVersion);

    const { Agent: UndiciAgent, request: undiciRequest } = await import("undici");
    const dispatcher = new UndiciAgent({
      connections: 4,
      bodyTimeout: 10 * 60_000, // 10 min — big modpacks zip up slowly
    });
    const target = `${node.host.replace(/\/$/, "")}/servers/${id}/export-mrpack?${params.toString()}`;
    const upstream = await undiciRequest(target, {
      method: "GET",
      headers: {
        authorization: `Bearer ${process.env[
          `AGENT_TOKEN_${node.name.toUpperCase()}`
        ] ?? process.env.AGENT_TOKEN ?? ""}`,
      },
      dispatcher,
      headersTimeout: 30_000,
      bodyTimeout: 10 * 60_000,
    });
    if (upstream.statusCode >= 400) {
      reply.code(upstream.statusCode);
      return reply.send(upstream.body);
    }
    // Mirror critical headers + stream body straight through.
    for (const h of ["content-type", "content-disposition"] as const) {
      const v = upstream.headers[h];
      if (v) reply.header(h, Array.isArray(v) ? v[0]! : v);
    }
    reply.code(upstream.statusCode);
    return reply.send(upstream.body);
  });

  app.get("/:id/crash-reports", async (req) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.view");
    const server = await prisma.server.findUniqueOrThrow({ where: { id } });
    const client = await NodeClient.forId(server.nodeId);
    return client.call("GET", `/servers/${id}/crash-reports`);
  });

  app.get("/:id/crash-reports/:name", async (req) => {
    const { id, name } = req.params as { id: string; name: string };
    await assertServerPermission(req, id, "server.view");
    const server = await prisma.server.findUniqueOrThrow({ where: { id } });
    const client = await NodeClient.forId(server.nodeId);
    return client.call(
      "GET",
      `/servers/${id}/crash-reports/${encodeURIComponent(name)}`
    );
  });

  app.delete("/:id/crash-reports/:name", async (req) => {
    const { id, name } = req.params as { id: string; name: string };
    await assertServerPermission(req, id, "server.edit");
    const server = await prisma.server.findUniqueOrThrow({ where: { id } });
    const client = await NodeClient.forId(server.nodeId);
    await client.call(
      "DELETE",
      `/servers/${id}/crash-reports/${encodeURIComponent(name)}`
    );
    await writeAudit(req, {
      action: "server.crash-report.delete",
      resource: id,
      metadata: { name },
    });
    return { ok: true };
  });

  app.get("/:id/install-failures", async (req) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.view");
    const server = await prisma.server.findUniqueOrThrow({ where: { id } });
    const client = await NodeClient.forId(server.nodeId);
    return client.call("GET", `/servers/${id}/install-failures`);
  });

  app.get("/:id/icon", async (req, reply) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.view");
    const server = await prisma.server.findUniqueOrThrow({ where: { id } });
    const client = await NodeClient.forId(server.nodeId);
    try {
      return await client.call<{ data: string }>("GET", `/servers/${id}/icon`);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number })?.statusCode;
      if (status === 404) return reply.code(404).send({ data: null });
      throw err;
    }
  });

  // Server icon — 64x64 PNG that itzg exposes to clients via
  // /data/server-icon.png. We accept a base64 data URL from the browser,
  // forward it to the agent which writes the file directly.
  app.post("/:id/icon", async (req) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.edit");
    const body = z
      .object({
        data: z
          .string()
          .regex(
            /^data:image\/png;base64,/,
            "Expected a base64-encoded PNG data URL"
          )
          .max(200_000, "Icon too large (max ~200KB)"),
      })
      .parse(req.body);
    const server = await prisma.server.findUniqueOrThrow({ where: { id } });
    const client = await NodeClient.forId(server.nodeId);
    await client.call("POST", `/servers/${id}/icon`, body);
    await writeAudit(req, { action: "server.icon.set", resource: id });
    return { ok: true };
  });

  app.delete("/:id/icon", async (req) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.edit");
    const server = await prisma.server.findUniqueOrThrow({ where: { id } });
    const client = await NodeClient.forId(server.nodeId);
    await client.call("DELETE", `/servers/${id}/icon`);
    await writeAudit(req, { action: "server.icon.clear", resource: id });
    return { ok: true };
  });

  app.get("/:id/export", async (req) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.view");
    const s = await prisma.server.findUniqueOrThrow({ where: { id } });
    return {
      name: s.name,
      description: s.description,
      type: s.type,
      version: s.version,
      memoryMb: s.memoryMb,
      cpuLimit: s.cpuLimit,
      ports: s.ports,
      env: s.env,
    };
  });

}

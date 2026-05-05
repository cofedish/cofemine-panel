import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
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
import { readDownloadProxy, makeProxyUrl } from "../integrations/download-proxy.js";
import { resetWatchdogState } from "./install-watchdog.js";
import { reconcileMany } from "./status.js";
import { streamMrpack } from "./export-mrpack.js";

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
      // has the current CF_API_KEY / MODRINTH config baked in.
      //
      // Also: on CF/MR servers, the status reconciler / watchdog
      // clears one-shot flags (CF_FORCE_REINSTALL_MODLOADER,
      // __COFEMINE_INSTALL_PROXY) from DB after a successful boot
      // without bouncing the container — so the LIVE container env
      // still has those flags. On the next user-initiated start
      // mc-image-helper would re-trigger a loader reinstall (because
      // the container's env says CF_FORCE_REINSTALL=true) and try
      // to download from neoforged maven without the proxy that DB
      // already cleared from the materialised set. Net effect:
      // ReadTimeout, server fails to start.
      //
      // Cheapest correct fix: reprovision unconditionally on start
      // for modpack servers. It's ~1-2s when the container is
      // stopped, so the user-visible delay is negligible, and it
      // guarantees container.env == materializeEnv(DB.env). Native
      // loader server types (FORGE/NEOFORGE/etc.) don't have these
      // one-shot flags so they keep the lighter just-start path.
      const startEnv = (server.env as Record<string, string> | null) ?? {};
      const needsReprov = startEnv.__COFEMINE_NEEDS_REPROV === "1";
      if (
        action === "start" &&
        (needsReprov ||
          server.type === "CURSEFORGE" ||
          server.type === "MODRINTH")
      ) {
        req.log.info(
          { id, type: server.type, needsReprov },
          "auto-reprovisioning before start to flush stale one-shot env"
        );
        // Clear the one-shot flag BEFORE reprov so the new container
        // doesn't carry it forward.
        if (needsReprov) {
          const next = { ...startEnv };
          delete next.__COFEMINE_NEEDS_REPROV;
          await prisma.server
            .update({
              where: { id },
              data: { env: next as unknown as object },
            })
            .catch(() => {
              /* non-fatal */
            });
        }
        await reconcileAndReprovision(id).catch((err) =>
          req.log.warn(
            { err },
            "auto-reprovision failed; attempting start anyway"
          )
        );
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

  // In-memory tracker for the long-running loader install. The
  // installer can take 30-120s on first run (image pull + maven
  // download + installer execution). Holding the HTTP request open
  // that long ran into idle timeouts somewhere in the Caddy → web →
  // api proxy chain and surfaced as an opaque "Internal Server
  // Error" to the user. So we kick the installer off as a background
  // job, return the request immediately, and let the UI poll for
  // status. State survives only the lifetime of the api process —
  // that's fine: the underlying env update is in DB, so a restart
  // mid-install just means the user sees no toast; the loader still
  // gets installed when the request completes.
  type LoaderJob = {
    state: "running" | "done" | "failed";
    message: string;
    loader: string | null;
    version: string | null;
    startedAt: number;
    finishedAt: number | null;
  };
  const loaderJobs = new Map<string, LoaderJob>();

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
      // The actual env that itzg's start-deployAutoCF script reads
      // for AUTO_CURSEFORGE. Maps to mc-image-helper's
      // --mod-loader-version flag.
      "CF_MOD_LOADER_VERSION",
      "CF_FORCE_REINSTALL_MODLOADER",
      "CF_FORCE_SYNCHRONIZE",
      // Legacy from previous attempts; strip if still present.
      "CF_OVERRIDE_LOADER_VERSION",
    ];
    const next: Record<string, string> = { ...env };
    for (const k of loaderKeys) delete next[k];
    if (body.loader && body.version) {
      // Native loader server types (FORGE / NEOFORGE / FABRIC /
      // QUILT) read the X_VERSION env at boot. Modpack server types
      // (CURSEFORGE / MODRINTH) instead use mc-image-helper which
      // reads CF_MOD_LOADER_VERSION + CF_FORCE_REINSTALL_MODLOADER.
      // Get the wrong env name here and itzg silently ignores the
      // override — the original "21.1.218 still loads" bug.
      const nativeMap: Record<string, string> = {
        neoforge: "NEOFORGE_VERSION",
        forge: "FORGE_VERSION",
        fabric: "FABRIC_LOADER_VERSION",
        quilt: "QUILT_LOADER_VERSION",
      };
      // Set the native env (used by FORGE / NEOFORGE / FABRIC /
      // QUILT server types AND read by some modpack-pack tooling
      // for completeness — harmless on modpack servers since itzg's
      // CF flow ignores it).
      next[nativeMap[body.loader]!] = body.version;
      // Set the CF/modpack-flavoured env. mc-image-helper for
      // AUTO_CURSEFORGE only respects this one — without it the
      // override silently no-ops. Setting it on a non-CF server
      // is harmless (itzg's non-CF flow doesn't read it).
      if (server.type === "CURSEFORGE") {
        next.CF_MOD_LOADER_VERSION = body.version;
        // Tells mc-image-helper to actually re-download / re-install
        // the loader at the version above instead of short-circuiting
        // because "the pack is already installed". Auto-cleared by
        // the status reconciler once the server boots cleanly.
        next.CF_FORCE_REINSTALL_MODLOADER = "true";
        // Re-enable the install-time download proxy. After the first
        // pack install the watchdog flipped this off so MC's runtime
        // traffic (Mojang auth, skins) goes direct, but the loader
        // reinstall we're about to trigger needs maven.neoforged.net
        // and forgecdn — both of which the proxy was originally for.
        // Without this the next start ReadTimeoutEexceptions on the
        // neoforge installer download. The watchdog's success-path
        // flip-off on next boot will turn it off again automatically
        // once the loader install completes.
        if (await readDownloadProxy()) {
          next.__COFEMINE_INSTALL_PROXY = "1";
        }
      }
    }
    await prisma.server.update({
      where: { id },
      data: { env: next as unknown as object },
    });
    // Kick off the installer in the background. The HTTP request
    // returns now; the UI polls GET /:id/loader-version-status to
    // see when it finishes. See the comment on `loaderJobs` for why
    // this had to go async.
    if (body.loader && body.version) {
      const job: LoaderJob = {
        state: "running",
        message: "Installing modloader…",
        loader: body.loader,
        version: body.version,
        startedAt: Date.now(),
        finishedAt: null,
      };
      loaderJobs.set(id, job);
      void (async () => {
        try {
          // Pass the configured download-proxy URL (if any) so the
          // agent's installer-jar download AND the loader installer's
          // own dependency fetches go through the same xray/socks5
          // tunnel that CF mods use. Without this, maven.neoforged.net
          // ETIMEDOUTs from regions where the upstream is blocked
          // direct (Russia → CF/maven over IPv4).
          const proxy = await readDownloadProxy();
          const proxyUrl = proxy ? makeProxyUrl(proxy) : null;
          const client = await NodeClient.forId(server.nodeId);
          // Loader installer can run for several minutes (download
          // installer jar + pull eclipse-temurin image + run
          // installer + chown). Bump both timeouts to 20 min so a
          // slow maven mirror doesn't fail the panel-side call.
          await client.call(
            "POST",
            `/servers/${id}/install-modloader`,
            {
              loader: body.loader,
              version: body.version,
              mcVersion: body.mcVersion ?? null,
              proxyUrl,
            },
            undefined,
            { headersTimeout: 20 * 60_000, bodyTimeout: 20 * 60_000 }
          );
          await reconcileAndReprovision(id);
          job.state = "done";
          job.message = `Modloader ${body.loader} ${body.version} installed.`;
          job.finishedAt = Date.now();
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(
            `[loader-version] background install failed for ${id}:`,
            err instanceof Error ? err.message : err
          );
          job.state = "failed";
          job.message =
            err instanceof Error && err.message
              ? err.message
              : "Installer failed without a message";
          job.finishedAt = Date.now();
        }
      })();
    } else {
      // Override cleared — just reprovision so the env change lands.
      // This is fast (no installer), so we still await it.
      await reconcileAndReprovision(id);
    }
    await writeAudit(req, {
      action: "server.loader-version.set",
      resource: id,
      metadata: { loader: body.loader, version: body.version },
    });
    return reply.code(202).send({
      ok: true,
      async: Boolean(body.loader && body.version),
      env: next,
    });
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

  app.get("/:id/loader-version-status", async (req) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.view");
    const job = loaderJobs.get(id);
    if (!job) return { state: "idle" };
    return job;
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

  // The `kind` query param picks the staging subdir under
  // .cofemine-client/. Default `mods`, also `shaderpacks` and
  // `resourcepacks`. Anything else falls back to `mods` on the agent
  // side.
  const clientKindSchema = z.enum(["mods", "shaderpacks", "resourcepacks"]).default("mods");

  app.get("/:id/client-mods", async (req) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.view");
    const kind = clientKindSchema.parse(
      (req.query as { kind?: string }).kind ?? "mods"
    );
    const server = await prisma.server.findUniqueOrThrow({ where: { id } });
    const client = await NodeClient.forId(server.nodeId);
    return client.call("GET", `/servers/${id}/client-mods?kind=${kind}`);
  });

  app.post("/:id/client-mods", async (req) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.edit");
    const kind = clientKindSchema.parse(
      (req.query as { kind?: string }).kind ?? "mods"
    );
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
      `/servers/${id}/client-mods?kind=${kind}`,
      body
    );
    await writeAudit(req, {
      action: "server.client-mods.upload",
      resource: id,
      metadata: { name: body.filename, kind },
    });
    return res;
  });

  app.delete("/:id/client-mods", async (req) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.edit");
    const q = req.query as { name?: string; kind?: string };
    const kind = clientKindSchema.parse(q.kind ?? "mods");
    const server = await prisma.server.findUniqueOrThrow({ where: { id } });
    const client = await NodeClient.forId(server.nodeId);
    await client.call(
      "DELETE",
      `/servers/${id}/client-mods?kind=${kind}&name=${encodeURIComponent(q.name ?? "")}`
    );
    await writeAudit(req, {
      action: "server.client-mods.delete",
      resource: id,
      metadata: { name: q.name, kind },
    });
    return { ok: true };
  });

  app.delete("/:id/client-mods/all", async (req) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.edit");
    const kind = clientKindSchema.parse(
      (req.query as { kind?: string }).kind ?? "mods"
    );
    const server = await prisma.server.findUniqueOrThrow({ where: { id } });
    const client = await NodeClient.forId(server.nodeId);
    const res = await client.call<{ ok: boolean; removed: number }>(
      "DELETE",
      `/servers/${id}/client-mods/all?kind=${kind}`
    );
    await writeAudit(req, {
      action: "server.client-mods.wipe",
      resource: id,
      metadata: { kind, removed: res.removed },
    });
    return res;
  });

  app.get("/:id/client-mods/auto-detect", async (req) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.view");
    const server = await prisma.server.findUniqueOrThrow({ where: { id } });
    const client = await NodeClient.forId(server.nodeId);
    return client.call("GET", `/servers/${id}/client-mods/auto-detect`);
  });

  app.post("/:id/client-mods/download", async (req) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.edit");
    const body = z
      .object({
        files: z
          .array(
            z.object({
              filename: z.string().min(1).max(256),
              downloadUrl: z.string().url(),
            })
          )
          .min(1)
          .max(200),
      })
      .parse(req.body);
    const server = await prisma.server.findUniqueOrThrow({ where: { id } });
    const proxy = await readDownloadProxy();
    const proxyUrl = proxy ? makeProxyUrl(proxy) : null;
    const clientNode = await NodeClient.forId(server.nodeId);
    const result = await clientNode.call<{
      results: Array<{ filename: string; ok: boolean; error?: string }>;
    }>("POST", `/servers/${id}/client-mods/download`, {
      files: body.files,
      proxyUrl,
    });
    await writeAudit(req, {
      action: "server.client-mods.bulk-download",
      resource: id,
      metadata: { count: body.files.length },
    });
    return result;
  });

  /**
   * Generate or rotate the public pack token for this server.
   * Once set, the URL `/p/<token>.mrpack` (registered separately
   * outside the auth gate) serves the freshly-built client-side
   * modpack with no session auth — designed to be shared with
   * friends. Re-running this endpoint rotates the token (any
   * old links stop working).
   */
  /**
   * Persist (or update) the CurseForge pack reference on the server.
   * Used when the user has detached the server from its CF source —
   * mc-image-helper-driven CF_SLUG/CF_FILE_ID env got dropped, but
   * we still want the .mrpack export to rebuild from the canonical
   * CF pack. Body accepts EITHER {projectId, fileId} directly OR a
   * {slug, fileId} pair which we resolve via CF API.
   */
  app.post("/:id/cf-pack-source", async (req, reply) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.edit");
    const body = z
      .object({
        projectId: z.coerce.number().int().positive().optional(),
        slug: z.string().min(1).max(128).optional(),
        fileId: z.coerce.number().int().positive(),
      })
      .refine((b) => b.projectId || b.slug, {
        message: "Either projectId or slug must be provided",
      })
      .parse(req.body);
    let projectId = body.projectId ?? null;
    if (!projectId && body.slug) {
      const cfKey = await readCurseforgeApiKey();
      if (!cfKey) {
        reply.code(503);
        return reply.send({
          error:
            "CF API key not configured — set it under Integrations or pass projectId directly",
        });
      }
      const url = `https://api.curseforge.com/v1/mods/search?gameId=432&slug=${encodeURIComponent(body.slug)}`;
      const res = await request(url, {
        method: "GET",
        headers: { "x-api-key": cfKey, accept: "application/json" },
        headersTimeout: 15_000,
        bodyTimeout: 15_000,
      });
      if (res.statusCode >= 400) {
        await res.body.dump().catch(() => {});
        reply.code(502);
        return reply.send({ error: `CF search failed (${res.statusCode})` });
      }
      const search = (await res.body.json()) as {
        data?: Array<{ id: number; slug: string }>;
      };
      const match =
        search.data?.find((p) => p.slug === body.slug) ?? search.data?.[0];
      if (!match) {
        reply.code(404);
        return reply.send({ error: `No CF pack matched slug "${body.slug}"` });
      }
      projectId = match.id;
    }
    await prisma.server.update({
      where: { id },
      data: { cfPackProjectId: projectId!, cfPackFileId: body.fileId },
    });
    await writeAudit(req, {
      action: "server.cf-pack-source.set",
      resource: id,
      metadata: { projectId, fileId: body.fileId },
    });
    return { ok: true, projectId, fileId: body.fileId };
  });

  app.post("/:id/public-pack-token", async (req) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.edit");
    const token = randomBytes(16).toString("hex");
    await prisma.server.update({
      where: { id },
      data: { publicPackToken: token },
    });
    await writeAudit(req, {
      action: "server.public-pack-token.rotate",
      resource: id,
    });
    return { ok: true, token };
  });

  app.delete("/:id/public-pack-token", async (req) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.edit");
    await prisma.server.update({
      where: { id },
      data: { publicPackToken: null },
    });
    await writeAudit(req, {
      action: "server.public-pack-token.disable",
      resource: id,
    });
    return { ok: true };
  });

  /**
   * Stream the agent's .mrpack export through to the browser. The
   * agent generates a ZIP on the fly — every jar from /data/mods
   * plus the client-mods staging area, all under overrides/. We don't
   * buffer here; the response is piped straight from agent → panel →
   * browser.
   */
  app.get("/:id/export-mrpack", async (req, reply) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.view");
    const server = await prisma.server.findUniqueOrThrow({ where: { id } });
    const node = await prisma.node.findUniqueOrThrow({
      where: { id: server.nodeId },
    });
    const includeAuto = (req.query as { include_auto_detected?: string })
      .include_auto_detected;
    return streamMrpack(server, node, reply, {
      includeAutoDetected: includeAuto !== "0",
    });
  });

  /**
   * Manually detach a CURSEFORGE / MODRINTH server from its pack
   * source RIGHT NOW (no need to wait for the next boot transition).
   * Same effect as the wizard's "detach after first boot" checkbox,
   * but invokable any time on an already-running pack server.
   *
   * Strips the CF_* and MODRINTH_* env, switches server.type to the
   * native loader. /data/mods + worlds untouched. The next user-initiated
   * restart picks up the new spec via the auto-reprovision pre-start
   * hook.
   */
  app.post("/:id/detach-source", async (req) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.edit");
    const server = await prisma.server.findUniqueOrThrow({ where: { id } });
    if (server.type !== "CURSEFORGE" && server.type !== "MODRINTH") {
      const err = new Error(
        "Server is not a modpack-sourced install — there's nothing to detach from."
      );
      (err as any).statusCode = 409;
      throw err;
    }
    const env = ((server.env as Record<string, string> | null) ?? {}) as Record<
      string,
      string
    >;
    let newType: string = "NEOFORGE";
    let nativeVerKey = "NEOFORGE_VERSION";
    let nativeVer: string | undefined =
      env.NEOFORGE_VERSION ?? env.CF_MOD_LOADER_VERSION;
    if (env.FORGE_VERSION) {
      newType = "FORGE";
      nativeVerKey = "FORGE_VERSION";
      nativeVer = env.FORGE_VERSION;
    } else if (env.FABRIC_LOADER_VERSION) {
      newType = "FABRIC";
      nativeVerKey = "FABRIC_LOADER_VERSION";
      nativeVer = env.FABRIC_LOADER_VERSION;
    } else if (env.QUILT_LOADER_VERSION) {
      newType = "QUILT";
      nativeVerKey = "QUILT_LOADER_VERSION";
      nativeVer = env.QUILT_LOADER_VERSION;
    }
    const dropKeys = [
      "CF_SLUG",
      "CF_PAGE_URL",
      "CF_FILE_ID",
      "CF_API_KEY",
      "CF_MOD_LOADER_VERSION",
      "CF_FORCE_REINSTALL_MODLOADER",
      "CF_FORCE_SYNCHRONIZE",
      "CF_FORCE_INCLUDE_MODS",
      "CF_OVERRIDE_LOADER_VERSION",
      "CF_EXCLUDE_INCLUDE_FILE",
      "MODRINTH_PROJECT",
      "MODRINTH_VERSION",
      "MODRINTH_PROJECTS",
      "MODRINTH_LOADER",
      "MODS",
      "PLUGINS",
      "__COFEMINE_DECOUPLE_AFTER_BOOT",
    ];
    const next: Record<string, string> = { ...env };
    for (const k of dropKeys) delete next[k];
    if (nativeVer) next[nativeVerKey] = nativeVer;
    // For NeoForge / Forge: point itzg at a LOCAL installer jar so
    // it doesn't need maven.neoforged.net at boot. Many users'
    // proxies handle forgecdn.net (CF mod downloads) but timeout on
    // neoforged.net — exact symptom on the user's prod. Download
    // the jar via the agent (uses our SOCKS-aware code path) and
    // wire NEOFORGE_INSTALLER / FORGE_INSTALLER env to the file
    // path inside the container.
    if ((newType === "NEOFORGE" || newType === "FORGE") && nativeVer) {
      try {
        const proxy = await readDownloadProxy();
        const proxyUrl = proxy ? makeProxyUrl(proxy) : null;
        const client = await NodeClient.forId(server.nodeId);
        const dl = await client.call<{ path: string; size: number }>(
          "POST",
          `/servers/${id}/download-loader-installer`,
          {
            loader: newType.toLowerCase() as "neoforge" | "forge",
            version: nativeVer,
            mcVersion: server.version,
            proxyUrl,
          }
        );
        // The agent writes to /var/lib/cofemine/servers/<id>/<name>;
        // inside the MC container that path is /data/<name> via the
        // bind mount. Strip the host prefix.
        const filename = dl.path.split("/").pop();
        if (filename) {
          const envKey =
            newType === "NEOFORGE"
              ? "NEOFORGE_INSTALLER"
              : "FORGE_INSTALLER";
          next[envKey] = `/data/${filename}`;
        }
      } catch (err) {
        req.log.warn(
          { err },
          "detach-source: download-loader-installer failed (will fall back to maven fetch)"
        );
      }
    }
    // Mark the server for a forced reprovision on its next start.
    // The container is currently set up with the OLD CURSEFORGE /
    // MODRINTH spec; without this flag a user-initiated start
    // would just call `docker start` on the stale container and
    // mc-image-helper would still run with all the CF_* env it
    // remembers from creation time. The reprov-before-start hook
    // strips this flag once it fires.
    next.__COFEMINE_NEEDS_REPROV = "1";
    await prisma.server.update({
      where: { id },
      data: { type: newType, env: next as unknown as object },
    });
    // Earlier install-modloader runs created /data/libraries/net/
    // minecraft/* and friends as root (the temp container runs as
    // root). itzg's install-neoforge on the freshly-detached server
    // chokes on AccessDeniedException when it tries to overwrite
    // those — even though the file content is identical. Pre-empt
    // that by chowning the install tree to itzg's uid 1000.
    try {
      const client = await NodeClient.forId(server.nodeId);
      await client.call("POST", `/servers/${id}/fix-permissions`);
    } catch (err) {
      req.log.warn(
        { err },
        "detach-source: fix-permissions call failed (non-fatal)"
      );
    }
    await writeAudit(req, {
      action: "server.detach-source",
      resource: id,
      metadata: { previousType: server.type, newType, loader: nativeVer },
    });
    return { ok: true, type: newType, loader: nativeVer ?? null };
  });

  /**
   * Repair file ownership across /data/libraries + run scripts.
   * Useful after the agent's loader installer ran in a previous
   * version that didn't chown its outputs to itzg's uid 1000 —
   * existing root-owned files cause AccessDenied on subsequent
   * starts. Idempotent.
   */
  app.post("/:id/fix-permissions", async (req) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.edit");
    const server = await prisma.server.findUniqueOrThrow({ where: { id } });
    const client = await NodeClient.forId(server.nodeId);
    const res = await client.call<{ ok: boolean; fixed: number }>(
      "POST",
      `/servers/${id}/fix-permissions`
    );
    await writeAudit(req, {
      action: "server.fix-permissions",
      resource: id,
      metadata: { fixed: res.fixed },
    });
    return res;
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

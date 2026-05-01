import type { FastifyInstance } from "fastify";
import { z } from "zod";
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
    const cfKey = await readCurseforgeApiKey();
    const extra = cfKey ? { "x-cf-api-key": cfKey } : undefined;
    return client.call(
      "GET",
      `/servers/${id}/installed-content`,
      undefined,
      extra
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

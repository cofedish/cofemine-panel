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
} from "./service.js";

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
    return servers.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      type: s.type,
      version: s.version,
      status: s.status,
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
    return server;
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
    await writeAudit(req, { action: "server.delete", resource: id });
    return { ok: true };
  });

  // Lifecycle actions proxied to the agent.
  for (const action of ["start", "stop", "restart", "kill"] as const) {
    app.post(`/:id/${action}`, async (req) => {
      const { id } = req.params as { id: string };
      await assertServerPermission(req, id, "server.control");
      const server = await prisma.server.findUniqueOrThrow({ where: { id } });
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
    const cloned = await prisma.server.create({
      data: {
        name: cloneName,
        description: source.description,
        nodeId: source.nodeId,
        type: source.type,
        version: source.version,
        memoryMb: source.memoryMb,
        cpuLimit: source.cpuLimit,
        ports: source.ports as any,
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

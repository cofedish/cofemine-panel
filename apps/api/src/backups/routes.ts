import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { assertServerPermission } from "../auth/rbac.js";
import { writeAudit } from "../audit/service.js";
import { NodeClient } from "../nodes/node-client.js";
import { z } from "zod";

const createBackupSchema = z.object({
  name: z.string().min(1).max(100).optional(),
});

export async function backupsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/servers/:id/backups", async (req) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.view");
    return prisma.backup.findMany({
      where: { serverId: id },
      orderBy: { createdAt: "desc" },
    });
  });

  app.post("/servers/:id/backups", async (req, reply) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.edit");
    const body = createBackupSchema.parse(req.body ?? {});
    const server = await prisma.server.findUniqueOrThrow({ where: { id } });
    const name =
      body.name ?? `manual-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const backup = await prisma.backup.create({
      data: { serverId: id, name, status: "running" },
    });
    try {
      const client = await NodeClient.forId(server.nodeId);
      const res = await client.call<{ path: string; size: number }>(
        "POST",
        `/servers/${id}/backups`,
        { backupId: backup.id, name }
      );
      await prisma.backup.update({
        where: { id: backup.id },
        data: {
          status: "success",
          path: res.path,
          sizeBytes: BigInt(res.size),
          finishedAt: new Date(),
        },
      });
    } catch (err) {
      await prisma.backup.update({
        where: { id: backup.id },
        data: { status: "failed", finishedAt: new Date() },
      });
      throw err;
    }
    await writeAudit(req, {
      action: "backup.create",
      resource: id,
      metadata: { backupId: backup.id, name },
    });
    return reply.code(201).send({ id: backup.id });
  });

  app.post("/backups/:id/restore", async (req) => {
    const { id } = req.params as { id: string };
    const backup = await prisma.backup.findUniqueOrThrow({ where: { id } });
    await assertServerPermission(req, backup.serverId, "server.edit");
    const server = await prisma.server.findUniqueOrThrow({
      where: { id: backup.serverId },
    });
    const client = await NodeClient.forId(server.nodeId);
    await client.call("POST", `/backups/${id}/restore`, {
      serverId: server.id,
      path: backup.path,
    });
    await writeAudit(req, {
      action: "backup.restore",
      resource: backup.serverId,
      metadata: { backupId: id },
    });
    return { ok: true };
  });

  app.delete("/backups/:id", async (req) => {
    const { id } = req.params as { id: string };
    const backup = await prisma.backup.findUniqueOrThrow({ where: { id } });
    await assertServerPermission(req, backup.serverId, "server.edit");
    const server = await prisma.server.findUniqueOrThrow({
      where: { id: backup.serverId },
    });
    try {
      const client = await NodeClient.forId(server.nodeId);
      await client.call("DELETE", `/backups/${id}?path=${encodeURIComponent(backup.path ?? "")}`);
    } catch (err) {
      req.log.warn({ err }, "agent backup delete failed; continuing");
    }
    await prisma.backup.delete({ where: { id } });
    await writeAudit(req, { action: "backup.delete", resource: id });
    return { ok: true };
  });
}

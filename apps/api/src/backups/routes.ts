import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { assertServerPermission } from "../auth/rbac.js";
import { writeAudit } from "../audit/service.js";
import { NodeClient } from "../nodes/node-client.js";
import { z } from "zod";

const createBackupSchema = z.object({
  // The agent turns this into `<name>.tar.gz` under the server's backup
  // directory, so it has to be a bare filename. Without the charset
  // restriction a name of `../<other-server-id>/x` writes outside this
  // server's directory — the agent re-checks, but the operator should
  // get a real error rather than a 400 from the node.
  //
  // Charset also has to keep the `manual-` / `scheduled-` prefixes
  // intact: retention deletes only `scheduled-`-prefixed rows.
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(
      /^[A-Za-z0-9._-]+$/,
      "Backup name may contain only letters, digits, dot, dash and underscore"
    )
    .refine((n) => !n.startsWith("."), "Backup name must not start with a dot")
    .optional(),
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

  /**
   * One-shot retention sweep — keeps the N most recent successful
   * scheduled-* backups, deletes the rest from BOTH agent disk and
   * the DB. Useful when an operator just added retention to a
   * schedule that ran ungoverned for a week and wants to free disk
   * RIGHT NOW instead of waiting for the next tick.
   *
   * Manual backups (anything whose name doesn't start with
   * 'scheduled-') and failed runs are NEVER touched — same contract
   * as the scheduler's auto-prune.
   */
  app.post("/servers/:id/backups/prune", async (req) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.edit");
    const body = z
      .object({ keep: z.coerce.number().int().min(0).max(10000) })
      .parse(req.body);
    const server = await prisma.server.findUniqueOrThrow({ where: { id } });
    const candidates = await prisma.backup.findMany({
      where: {
        serverId: id,
        status: "success",
        name: { startsWith: "scheduled-" },
      },
      orderBy: { createdAt: "desc" },
    });
    const stale = candidates.slice(body.keep);
    if (stale.length === 0) {
      return { ok: true, pruned: 0, freedBytes: 0 };
    }
    const client = await NodeClient.forId(server.nodeId);
    let freedBytes = 0n;
    for (const b of stale) {
      try {
        await client.call(
          "DELETE",
          `/backups/${b.id}?path=${encodeURIComponent(b.path ?? "")}`
        );
      } catch (err) {
        req.log.warn(
          { err, backupId: b.id },
          "agent backup delete failed during manual prune; dropping DB row anyway"
        );
      }
      if (b.sizeBytes) freedBytes += b.sizeBytes;
      await prisma.backup.delete({ where: { id: b.id } }).catch(() => {});
    }
    await writeAudit(req, {
      action: "backup.prune",
      resource: id,
      metadata: { keep: body.keep, pruned: stale.length },
    });
    return {
      ok: true,
      pruned: stale.length,
      freedBytes: Number(freedBytes),
    };
  });
}

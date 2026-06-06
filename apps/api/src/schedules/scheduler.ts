import { Cron } from "croner";
import { prisma } from "../db.js";
import { NodeClient } from "../nodes/node-client.js";
import pino from "pino";

const log = pino({ name: "scheduler" });
const jobs = new Map<string, Cron>();

export async function startScheduler(): Promise<void> {
  await reloadJobs();
}

export async function restartScheduler(): Promise<void> {
  for (const job of jobs.values()) job.stop();
  jobs.clear();
  await reloadJobs();
}

async function reloadJobs(): Promise<void> {
  const schedules = await prisma.schedule.findMany({
    where: { enabled: true },
    include: { server: true },
  });
  for (const sched of schedules) {
    try {
      const job = new Cron(sched.cron, { timezone: "UTC" }, async () => {
        await runSchedule(sched.id).catch((err) =>
          log.error({ err, id: sched.id }, "scheduled job failed")
        );
      });
      jobs.set(sched.id, job);
      log.info({ id: sched.id, cron: sched.cron }, "scheduled job registered");
    } catch (err) {
      log.error({ err, id: sched.id, cron: sched.cron }, "invalid cron");
    }
  }
}

/**
 * Keep at most `keep` successful scheduled-named backups for this
 * server; older ones are deleted from both disk (via the agent) and
 * the DB. Why filter on `name LIKE 'scheduled-%'`: manual backups
 * the operator named themselves should NEVER be auto-pruned — those
 * were created intentionally and represent restore points the user
 * wants pinned. Failed runs also stay (the DB row is the only thing
 * that proves the run happened; the agent never created an archive
 * to delete).
 */
async function pruneScheduledBackups(
  serverId: string,
  _nodeId: string,
  keep: number,
  client: NodeClient
): Promise<void> {
  const candidates = await prisma.backup.findMany({
    where: {
      serverId,
      status: "success",
      name: { startsWith: "scheduled-" },
    },
    orderBy: { createdAt: "desc" },
  });
  const stale = candidates.slice(keep);
  if (stale.length === 0) return;
  for (const b of stale) {
    try {
      await client.call(
        "DELETE",
        `/backups/${b.id}?path=${encodeURIComponent(b.path ?? "")}`
      );
    } catch (err) {
      // Agent-side delete failed — the file may already be gone
      // (operator pruned the disk by hand). Log and still drop the
      // DB row so the count converges to `keep` next tick.
      log.warn(
        { err, backupId: b.id },
        "agent backup delete failed during prune; dropping DB row anyway"
      );
    }
    await prisma.backup.delete({ where: { id: b.id } }).catch(() => {});
  }
  log.info(
    { serverId, pruned: stale.length, kept: Math.min(keep, candidates.length) },
    "scheduled backups pruned"
  );
}

async function runSchedule(id: string): Promise<void> {
  const sched = await prisma.schedule.findUnique({
    where: { id },
    include: { server: true },
  });
  if (!sched || !sched.enabled) return;
  const server = sched.server;
  const client = await NodeClient.forId(server.nodeId);
  switch (sched.action) {
    case "restart":
      await client.call("POST", `/servers/${server.id}/restart`);
      break;
    case "backup": {
      const backup = await prisma.backup.create({
        data: {
          serverId: server.id,
          name: `scheduled-${new Date().toISOString().replace(/[:.]/g, "-")}`,
          status: "running",
        },
      });
      try {
        const res = await client.call<{ path: string; size: number }>(
          "POST",
          `/servers/${server.id}/backups`,
          { backupId: backup.id, name: backup.name }
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
      } catch {
        await prisma.backup.update({
          where: { id: backup.id },
          data: { status: "failed", finishedAt: new Date() },
        });
      }
      // Rotate old scheduled backups. Without this an hourly schedule
      // accumulates 720+ archives per month — on a 2GB modpack that's
      // 1.4 TB. Retention is read from the schedule's payload first
      // (per-schedule control) then from the server env's COFEMINE_
      // BACKUP_KEEP, falling back to a sane default. Only SUCCESSFUL
      // scheduled-named backups are counted — manual backups and
      // failed runs aren't touched.
      const perScheduleKeep = Number(
        (sched.payload as { keep?: unknown } | null)?.keep ?? NaN
      );
      const envKeep = Number(
        (server.env as Record<string, string> | null)?.COFEMINE_BACKUP_KEEP ?? NaN
      );
      const keep =
        Number.isFinite(perScheduleKeep) && perScheduleKeep > 0
          ? Math.floor(perScheduleKeep)
          : Number.isFinite(envKeep) && envKeep > 0
            ? Math.floor(envKeep)
            : 24; // sensible hourly default — 1 day at hourly cadence
      await pruneScheduledBackups(server.id, server.nodeId, keep, client).catch(
        (err) => log.warn({ err, id: server.id }, "backup prune failed")
      );
      break;
    }
    case "command": {
      const cmd = (sched.payload as any)?.command ?? "";
      if (cmd) {
        await client.call("POST", `/servers/${server.id}/command`, {
          command: cmd,
        });
      }
      break;
    }
    case "announce": {
      const msg = (sched.payload as any)?.message ?? "Server restarting soon";
      await client.call("POST", `/servers/${server.id}/command`, {
        command: `say ${msg}`,
      });
      break;
    }
  }
  await prisma.schedule.update({
    where: { id },
    data: { lastRunAt: new Date() },
  });
}

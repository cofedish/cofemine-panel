import { Cron } from "croner";
import { prisma } from "../db.js";
import { NodeClient } from "../nodes/node-client.js";
import { isValidCronShape } from "@cofemine/shared";
import { userHasServerPermission } from "../auth/rbac.js";
import pino from "pino";

const log = pino({ name: "scheduler" });
const jobs = new Map<string, Cron>();

/**
 * Serialises reloads. `restartScheduler` stops every job, clears the
 * map, then awaits a DB read — two concurrent schedule edits could
 * interleave inside that await and leave live `Cron` instances with no
 * reference in `jobs`, which nothing can ever stop. Orphans also defeat
 * `protect: true`, since that guards a single instance rather than the
 * set of them.
 */
let reloadChain: Promise<void> = Promise.resolve();

function serialise(work: () => Promise<void>): Promise<void> {
  const next = reloadChain.then(work, work);
  // Keep the chain alive even if one reload throws.
  reloadChain = next.catch(() => {});
  return next;
}

export async function startScheduler(): Promise<void> {
  await serialise(reloadJobs);
}

export async function restartScheduler(): Promise<void> {
  await serialise(async () => {
    for (const job of jobs.values()) job.stop();
    jobs.clear();
    await reloadJobs();
  });
}

async function reloadJobs(): Promise<void> {
  const schedules = await prisma.schedule.findMany({
    where: { enabled: true },
    include: { server: true },
  });
  for (const sched of schedules) {
    // Reject anything that isn't a five-field expression or a named
    // shortcut, even if it predates the schema validation. croner reads
    // a six-field form as second-level, so `* * * * * *` + backup would
    // tar the world once a second.
    if (!isValidCronShape(sched.cron)) {
      log.error(
        { id: sched.id, cron: sched.cron },
        "refusing to register schedule: cron must be 5 fields or a named shortcut"
      );
      continue;
    }
    try {
      const job = new Cron(
        sched.cron,
        {
          timezone: "UTC",
          // Skip a tick rather than starting a second copy while the
          // previous run is still going. A minutely backup on a big
          // world takes longer than a minute, and overlapping runs
          // stack until the node falls over.
          protect: true,
        },
        async () => {
          await runSchedule(sched.id).catch((err) =>
            log.error({ err, id: sched.id }, "scheduled job failed")
          );
        }
      );
      jobs.set(sched.id, job);
      log.info({ id: sched.id, cron: sched.cron }, "scheduled job registered");
    } catch (err) {
      log.error({ err, id: sched.id, cron: sched.cron }, "invalid cron");
    }
  }
}

/**
 * Append a scheduler event to the audit log.
 *
 * `writeAudit` needs a FastifyRequest; scheduled runs have none, so
 * they write directly. Before this, only schedule *creation* was
 * audited — the recurring `command` executions it produced left no
 * trace at all.
 */
async function auditScheduleEvent(
  action: string,
  sched: { id: string; serverId: string; action: string; createdById: string | null },
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await prisma.auditEvent
    .create({
      data: {
        userId: sched.createdById,
        action,
        resource: sched.serverId,
        metadata: {
          scheduleId: sched.id,
          scheduleAction: sched.action,
          ...metadata,
        },
      },
    })
    .catch((err) => log.warn({ err }, "audit write failed for scheduled run"));
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

  // Re-check authorization at execution time, not just at creation.
  // A schedule is a standing grant to act on a server: `command:
  // "op attacker"` kept running after its author was demoted or their
  // account deleted, because nothing ever looked again. Disable it
  // instead of skipping, so it stops burning ticks and shows up as
  // disabled in the UI.
  //
  // Rows created before `createdById` existed carry null — those are
  // grandfathered rather than disabled en masse, which would take out
  // every existing backup schedule on deploy.
  if (sched.createdById) {
    const stillAllowed = await userHasServerPermission(
      sched.createdById,
      server.id,
      "server.edit"
    );
    if (!stillAllowed) {
      await prisma.schedule
        .update({ where: { id }, data: { enabled: false } })
        .catch(() => {});
      jobs.get(id)?.stop();
      jobs.delete(id);
      log.warn(
        { id, serverId: server.id, createdById: sched.createdById },
        "disabling schedule: its creator no longer has server.edit"
      );
      await auditScheduleEvent("schedule.disabled-unauthorized", sched);
      return;
    }
  } else {
    log.warn(
      { id, serverId: server.id },
      "schedule has no recorded creator (created before authorship tracking) — running without a re-check"
    );
  }

  const client = await NodeClient.forId(server.nodeId);
  try {
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
      // Floor of 1, always. `Math.floor` on a fractional value used to
      // yield 0, and `slice(0)` selects the entire array — a
      // `{keep: 0.5}` payload deleted every successful scheduled backup
      // from disk and the DB. The schema now rejects such payloads;
      // this clamp covers rows written before it and the env override.
      const rawKeep =
        Number.isFinite(perScheduleKeep) && perScheduleKeep > 0
          ? perScheduleKeep
          : Number.isFinite(envKeep) && envKeep > 0
            ? envKeep
            : 24; // sensible hourly default — 1 day at hourly cadence
      const keep = Math.max(1, Math.floor(rawKeep));
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
  } catch (err) {
    // Audit failures too. A run that errored still *attempted* a
    // console command, and "the command that broke the server isn't in
    // the log because it threw" is the wrong property for an audit
    // trail to have.
    await auditScheduleEvent("schedule.run-failed", sched, {
      ...describePayload(sched),
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    await prisma.schedule
      .update({ where: { id }, data: { lastRunAt: new Date() } })
      .catch(() => {});
  }
  // Every run is auditable, with the payload for the actions that carry
  // one — a scheduled `command` is a console execution and belongs in
  // the trail exactly like the interactive one.
  await auditScheduleEvent("schedule.run", sched, describePayload(sched));
}

/** Action-specific fields worth keeping in the audit record. */
function describePayload(sched: {
  action: string;
  payload: unknown;
}): Record<string, unknown> {
  const payload = (sched.payload ?? {}) as {
    command?: string;
    message?: string;
  };
  if (sched.action === "command") return { command: payload.command ?? null };
  if (sched.action === "announce") return { message: payload.message ?? null };
  return {};
}

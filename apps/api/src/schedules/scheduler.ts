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

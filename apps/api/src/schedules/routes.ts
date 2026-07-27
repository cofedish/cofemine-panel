import type { FastifyInstance } from "fastify";
import { Cron } from "croner";
import { scheduleSchema } from "@cofemine/shared";
import { prisma } from "../db.js";
import { assertServerPermission } from "../auth/rbac.js";
import { requireUser } from "../auth/context.js";
import { writeAudit } from "../audit/service.js";
import { restartScheduler } from "./scheduler.js";

/**
 * Field *semantics* — the shared schema only counts fields, because it
 * must stay dependency-free. Parsing here means a malformed expression
 * is a 400 at save time instead of a line in the scheduler log that
 * nobody reads while the schedule silently never runs.
 */
function assertCronParses(expression: string): void {
  let next: Date | null;
  try {
    // `paused` so constructing it doesn't register a live job.
    const probe = new Cron(expression, { timezone: "UTC", paused: true });
    next = probe.nextRun();
    probe.stop();
  } catch {
    throw Object.assign(new Error(`Invalid cron expression: ${expression}`), {
      statusCode: 400,
    });
  }
  // Parses fine but never fires — e.g. `0 0 30 2 *` (30 February).
  // Saving that returns 201 and then silently does nothing forever.
  if (!next) {
    throw Object.assign(
      new Error(`Cron expression never matches a real date: ${expression}`),
      { statusCode: 400 }
    );
  }
}

export async function schedulesRoutes(app: FastifyInstance): Promise<void> {
  app.get("/servers/:id/schedules", async (req) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.view");
    return prisma.schedule.findMany({
      where: { serverId: id },
      orderBy: { createdAt: "asc" },
    });
  });

  app.post("/servers/:id/schedules", async (req, reply) => {
    const { id } = req.params as { id: string };
    await assertServerPermission(req, id, "server.edit");
    const body = scheduleSchema.parse(req.body);
    assertCronParses(body.cron);
    const created = await prisma.schedule.create({
      data: {
        serverId: id,
        name: body.name,
        cron: body.cron,
        action: body.action,
        payload: (body.payload as object) ?? undefined,
        enabled: body.enabled,
        // Recorded so the scheduler can re-check this user still has
        // server.edit before every run — see schedules/scheduler.ts.
        createdById: requireUser(req).id,
      },
    });
    await restartScheduler();
    await writeAudit(req, {
      action: "schedule.create",
      resource: id,
      metadata: { scheduleId: created.id, cron: body.cron, action: body.action },
    });
    return reply.code(201).send({ id: created.id });
  });

  app.patch("/schedules/:id", async (req) => {
    const { id } = req.params as { id: string };
    const sched = await prisma.schedule.findUniqueOrThrow({ where: { id } });
    await assertServerPermission(req, sched.serverId, "server.edit");
    const body = scheduleSchema.partial().parse(req.body);
    if (body.cron) assertCronParses(body.cron);
    const editor = requireUser(req);
    const updated = await prisma.schedule.update({
      where: { id },
      data: {
        name: body.name,
        cron: body.cron,
        action: body.action,
        payload: (body.payload as object) ?? undefined,
        enabled: body.enabled,
        // Re-attribute to whoever last changed it. Without this, an
        // OPERATOR could rewrite an ADMIN's schedule into
        // `command: "op mallory"` and the scheduler's pre-run
        // authorization check would keep validating the ADMIN — the
        // edit would inherit someone else's authority.
        createdById: editor.id,
      },
    });
    await restartScheduler();
    // Was the only mutating handler in this router without an audit
    // call, which is exactly where a hijacked schedule would hide.
    await writeAudit(req, {
      action: "schedule.update",
      resource: sched.serverId,
      metadata: {
        scheduleId: id,
        cron: updated.cron,
        scheduleAction: updated.action,
        enabled: updated.enabled,
        previousCreatedById: sched.createdById,
      },
    });
    return updated;
  });

  app.delete("/schedules/:id", async (req) => {
    const { id } = req.params as { id: string };
    const sched = await prisma.schedule.findUniqueOrThrow({ where: { id } });
    await assertServerPermission(req, sched.serverId, "server.edit");
    await prisma.schedule.delete({ where: { id } });
    await restartScheduler();
    await writeAudit(req, { action: "schedule.delete", resource: sched.serverId });
    return { ok: true };
  });
}

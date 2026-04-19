import type { FastifyInstance } from "fastify";
import { scheduleSchema } from "@cofemine/shared";
import { prisma } from "../db.js";
import { assertServerPermission } from "../auth/rbac.js";
import { writeAudit } from "../audit/service.js";
import { restartScheduler } from "./scheduler.js";

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
    const created = await prisma.schedule.create({
      data: {
        serverId: id,
        name: body.name,
        cron: body.cron,
        action: body.action,
        payload: (body.payload as object) ?? undefined,
        enabled: body.enabled,
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
    const updated = await prisma.schedule.update({
      where: { id },
      data: {
        name: body.name,
        cron: body.cron,
        action: body.action,
        payload: (body.payload as object) ?? undefined,
        enabled: body.enabled,
      },
    });
    await restartScheduler();
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

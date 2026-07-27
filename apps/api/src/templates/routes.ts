import type { FastifyInstance } from "fastify";
import { createTemplateSchema } from "@cofemine/shared";
import { prisma } from "../db.js";
import { requireGlobalPermission } from "../auth/rbac.js";
import { writeAudit } from "../audit/service.js";
import { redactEnv } from "../servers/env-redaction.js";

export async function templatesRoutes(app: FastifyInstance): Promise<void> {
  // Templates carry an `env` blob of exactly the kind redactEnv exists
  // for. This was the one route in the router without a gate, so any
  // authenticated user — including a VIEWER with no server access at
  // all — could read every template's env in plaintext.
  app.get(
    "/",
    { preHandler: requireGlobalPermission("template.manage") },
    async () => {
      const rows = await prisma.template.findMany({
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          name: true,
          description: true,
          type: true,
          version: true,
          memoryMb: true,
          env: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      return rows.map((t) => ({ ...t, env: redactEnv(t.env) }));
    }
  );

  app.post(
    "/",
    { preHandler: requireGlobalPermission("template.manage") },
    async (req, reply) => {
      const body = createTemplateSchema.parse(req.body);
      const t = await prisma.template.create({
        data: {
          name: body.name,
          description: body.description ?? null,
          type: body.type,
          version: body.version,
          memoryMb: body.memoryMb,
          env: body.env as unknown as object,
        },
      });
      await writeAudit(req, { action: "template.create", resource: t.id });
      return reply.code(201).send({ id: t.id });
    }
  );

  app.delete(
    "/:id",
    { preHandler: requireGlobalPermission("template.manage") },
    async (req) => {
      const { id } = req.params as { id: string };
      await prisma.template.delete({ where: { id } });
      await writeAudit(req, { action: "template.delete", resource: id });
      return { ok: true };
    }
  );
}

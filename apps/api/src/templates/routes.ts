import type { FastifyInstance } from "fastify";
import { createTemplateSchema } from "@cofemine/shared";
import { prisma } from "../db.js";
import { requireGlobalPermission } from "../auth/rbac.js";
import { writeAudit } from "../audit/service.js";

export async function templatesRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async () => {
    return prisma.template.findMany({ orderBy: { createdAt: "asc" } });
  });

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

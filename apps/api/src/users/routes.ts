import type { FastifyInstance } from "fastify";
import { createUserSchema, updateUserSchema } from "@cofemine/shared";
import { prisma } from "../db.js";
import { requireGlobalPermission } from "../auth/rbac.js";
import { hashPassword } from "../auth/password.js";
import { writeAudit } from "../audit/service.js";
import { requireUser } from "../auth/context.js";

export async function usersRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/",
    { preHandler: requireGlobalPermission("user.manage") },
    async () => {
      const users = await prisma.user.findMany({
        select: {
          id: true,
          email: true,
          username: true,
          role: true,
          createdAt: true,
        },
        orderBy: { createdAt: "asc" },
      });
      return users;
    }
  );

  app.post(
    "/",
    { preHandler: requireGlobalPermission("user.manage") },
    async (req, reply) => {
      const body = createUserSchema.parse(req.body);
      const user = await prisma.user.create({
        data: {
          email: body.email,
          username: body.username,
          password: await hashPassword(body.password),
          role: body.role,
        },
        select: { id: true, email: true, username: true, role: true },
      });
      await writeAudit(req, {
        action: "user.create",
        resource: user.id,
        metadata: { role: user.role },
      });
      return reply.code(201).send(user);
    }
  );

  app.patch(
    "/:id",
    { preHandler: requireGlobalPermission("user.manage") },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = updateUserSchema.parse(req.body);
      const current = requireUser(req);
      if (body.role === "OWNER" && current.role !== "OWNER") {
        const err = new Error("Only OWNER can grant OWNER role");
        (err as any).statusCode = 403;
        throw err;
      }
      const data: Record<string, unknown> = {};
      if (body.email) data.email = body.email;
      if (body.username) data.username = body.username;
      if (body.password) data.password = await hashPassword(body.password);
      if (body.role) data.role = body.role;
      const updated = await prisma.user.update({
        where: { id },
        data,
        select: { id: true, email: true, username: true, role: true },
      });
      await writeAudit(req, { action: "user.update", resource: id });
      return updated;
    }
  );

  app.delete(
    "/:id",
    { preHandler: requireGlobalPermission("user.manage") },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const current = requireUser(req);
      if (id === current.id) {
        return reply.code(400).send({ error: "You cannot delete yourself" });
      }
      await prisma.user.delete({ where: { id } });
      await writeAudit(req, { action: "user.delete", resource: id });
      return { ok: true };
    }
  );
}

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createUserSchema, updateUserSchema } from "@cofemine/shared";
import { prisma } from "../db.js";
import { requireGlobalPermission } from "../auth/rbac.js";
import { hashPassword } from "../auth/password.js";
import { writeAudit } from "../audit/service.js";
import { requireUser } from "../auth/context.js";
import { issueResetTokenAndEmail } from "../auth/routes.js";

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
          avatar: true,
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

  /**
   * Owner / admin password reset for someone else's account. Two modes:
   *
   *   • body.newPassword set      → write the new password directly,
   *     invalidate the user's sessions, return ok.
   *   • body.newPassword absent  → generate a one-shot reset link and
   *     email it to the user. Falls back to returning the link in the
   *     response when SMTP is not configured, so the admin can copy it
   *     into a chat / paper / signal / whatever.
   *
   * Either way we never exfiltrate or log the actual password.
   */
  app.post(
    "/:id/reset-password",
    { preHandler: requireGlobalPermission("user.manage") },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = z
        .object({
          newPassword: z.string().min(8).max(200).optional(),
        })
        .parse(req.body ?? {});
      const current = requireUser(req);
      const target = await prisma.user.findUnique({ where: { id } });
      if (!target) return reply.code(404).send({ error: "User not found" });

      if (body.newPassword) {
        await prisma.$transaction([
          prisma.user.update({
            where: { id },
            data: { password: await hashPassword(body.newPassword) },
          }),
          prisma.session.deleteMany({ where: { userId: id } }),
        ]);
        await writeAudit(req, {
          action: "user.password-reset.direct",
          resource: id,
          metadata: { actor: current.id },
        });
        return { ok: true, mode: "direct" as const };
      }

      const { link, mailed } = await issueResetTokenAndEmail(
        id,
        target.email,
        `admin:${current.id}`
      );
      await writeAudit(req, {
        action: "user.password-reset.link",
        resource: id,
        metadata: { actor: current.id, mailed },
      });
      // When SMTP isn't set up we hand the link back so the admin can
      // copy it manually. When it IS set up we still return it so the
      // UI can show "Sent — link copied for fallback" without a second
      // round trip; the email is the canonical delivery channel.
      return { ok: true, mode: "link" as const, mailed, link };
    }
  );
}

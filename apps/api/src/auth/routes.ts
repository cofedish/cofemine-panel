import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { loginSchema, setupSchema } from "@cofemine/shared";
import { prisma } from "../db.js";
import { hashPassword, verifyPassword } from "./password.js";
import { signSession } from "./jwt.js";
import { sha256Hex } from "../crypto.js";
import { config } from "../config.js";
import { SESSION_COOKIE } from "./plugin.js";
import { writeAudit } from "../audit/service.js";
import { requireUser } from "./context.js";

const SESSION_COOKIE_OPTS = {
  path: "/",
  httpOnly: true,
  sameSite: "lax" as const,
  secure: config.NODE_ENV === "production",
  maxAge: config.SESSION_TTL_HOURS * 60 * 60,
};

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.get("/setup-status", async () => {
    const userCount = await prisma.user.count();
    return { setupRequired: userCount === 0 };
  });

  app.post("/setup", async (req, reply) => {
    const existing = await prisma.user.count();
    if (existing > 0) {
      return reply.code(409).send({ error: "Setup already completed" });
    }
    const body = setupSchema.parse(req.body);
    const user = await prisma.user.create({
      data: {
        email: body.email,
        username: body.username,
        password: await hashPassword(body.password),
        role: "OWNER",
      },
    });
    await issueSession(app, req, reply, user.id);
    await writeAudit(req, { action: "auth.setup", resource: user.id });
    return reply.send({ ok: true });
  });

  app.post("/login", async (req, reply) => {
    const body = loginSchema.parse(req.body);
    const user = await prisma.user.findFirst({
      where: {
        OR: [{ email: body.usernameOrEmail }, { username: body.usernameOrEmail }],
      },
    });
    if (!user || !(await verifyPassword(body.password, user.password))) {
      return reply.code(401).send({ error: "Invalid credentials" });
    }
    await issueSession(app, req, reply, user.id);
    await writeAudit(req, { action: "auth.login", resource: user.id });
    return reply.send({ ok: true });
  });

  app.post("/logout", async (req, reply) => {
    if (req.user) {
      await prisma.session.delete({ where: { id: req.user.sessionId } }).catch(() => {});
      await writeAudit(req, { action: "auth.logout", resource: req.user.id });
    }
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/me", async (req) => {
    const user = requireUser(req);
    const full = await prisma.user.findUnique({
      where: { id: user.id },
      select: {
        id: true,
        email: true,
        username: true,
        role: true,
        avatar: true,
      },
    });
    return full;
  });

  // Self-service updates (avatar, future: displayName, email, password).
  // Admin-level updates on other users live under /users/:id.
  app.patch("/me", async (req) => {
    const user = requireUser(req);
    const body = z
      .object({
        avatar: z
          .string()
          .max(300_000, "Avatar too large (max ~300KB base64)")
          .nullable()
          .optional(),
      })
      .parse(req.body);
    const data: Record<string, unknown> = {};
    if ("avatar" in body) data.avatar = body.avatar;
    const updated = await prisma.user.update({
      where: { id: user.id },
      data,
      select: {
        id: true,
        email: true,
        username: true,
        role: true,
        avatar: true,
      },
    });
    await writeAudit(req, { action: "user.self-update", resource: user.id });
    return updated;
  });
}

async function issueSession(
  app: FastifyInstance,
  req: import("fastify").FastifyRequest,
  reply: import("fastify").FastifyReply,
  userId: string
): Promise<void> {
  const expiresAt = new Date(
    Date.now() + config.SESSION_TTL_HOURS * 60 * 60 * 1000
  );
  // We create the session first with a placeholder, then update with the token hash.
  const session = await prisma.session.create({
    data: {
      userId,
      tokenHash: "pending",
      expiresAt,
      userAgent: req.headers["user-agent"]?.slice(0, 500),
      ip: req.ip,
    },
  });
  const token = signSession({ sub: userId, sid: session.id });
  await prisma.session.update({
    where: { id: session.id },
    data: { tokenHash: sha256Hex(token) },
  });
  reply.setCookie(SESSION_COOKIE, token, SESSION_COOKIE_OPTS);
}

import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
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
import { buildResetLink, sendMail } from "../mail/smtp.js";

/** Reset tokens are valid for 1 hour from issue. */
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
/** Length in bytes; the hex-encoded form is 2× this. */
const RESET_TOKEN_BYTES = 32;

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

  // ---- Password reset --------------------------------------------------
  //
  // Two flows:
  //   • POST /auth/forgot-password — public. Looks up by email or username;
  //     if it matches a user, creates a one-shot token and emails the link.
  //     Always returns 204 so attackers can't probe which addresses exist.
  //   • POST /auth/reset-password — public. Consumes a valid unused token,
  //     replaces the user's password, invalidates ALL their sessions.

  app.post("/forgot-password", async (req, reply) => {
    const body = z
      .object({ usernameOrEmail: z.string().min(1).max(200) })
      .parse(req.body);
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { email: body.usernameOrEmail.toLowerCase() },
          { username: body.usernameOrEmail },
        ],
      },
    });
    // Always pretend success to prevent enumeration. Do the work async only
    // when we actually found a user.
    if (user) {
      try {
        const link = await issueResetTokenAndEmail(user.id, user.email, "self");
        req.log.info(
          { userId: user.id, mailed: link.mailed },
          "password reset link generated"
        );
      } catch (err) {
        req.log.warn({ err }, "forgot-password processing failed");
      }
    }
    return reply.code(204).send();
  });

  app.post("/reset-password", async (req, reply) => {
    const body = z
      .object({
        token: z.string().min(16).max(256),
        newPassword: z
          .string()
          .min(8, "Password must be at least 8 characters")
          .max(200),
      })
      .parse(req.body);
    const tokenHash = sha256Hex(body.token);
    const row = await prisma.passwordResetToken.findUnique({
      where: { tokenHash },
    });
    if (!row || row.usedAt || row.expiresAt < new Date()) {
      return reply
        .code(400)
        .send({ error: "Reset link is invalid or has expired" });
    }
    await prisma.$transaction([
      prisma.user.update({
        where: { id: row.userId },
        data: { password: await hashPassword(body.newPassword) },
      }),
      prisma.passwordResetToken.update({
        where: { id: row.id },
        data: { usedAt: new Date() },
      }),
      // Kill all active sessions — a forced password reset must log
      // every other browser out, otherwise a stolen session survives
      // the recovery flow.
      prisma.session.deleteMany({ where: { userId: row.userId } }),
    ]);
    await writeAudit(req, {
      action: "auth.password-reset",
      resource: row.userId,
      metadata: { source: row.source },
    });
    return reply.send({ ok: true });
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

/**
 * Generate a fresh reset token, persist its hash + expiry, and email the
 * link to the recipient. Returns the raw token + a flag for whether the
 * email actually went out (false when SMTP is not configured — used by
 * the admin flow to copy the link into the response so a human can
 * deliver it manually).
 */
export async function issueResetTokenAndEmail(
  userId: string,
  email: string,
  source: string
): Promise<{ token: string; link: string; mailed: boolean }> {
  const raw = crypto.randomBytes(RESET_TOKEN_BYTES).toString("hex");
  const tokenHash = sha256Hex(raw);
  await prisma.passwordResetToken.create({
    data: {
      userId,
      tokenHash,
      expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
      source,
    },
  });
  const link = await buildResetLink(raw);
  const subject = "Cofemine Panel — password reset";
  const text = [
    "We received a request to reset your password.",
    "",
    `Open this link to set a new one (valid for 1 hour):`,
    link,
    "",
    "If you didn't request this, you can ignore this email and your password will stay the same.",
  ].join("\n");
  const html = [
    `<p>We received a request to reset your password.</p>`,
    `<p>Open this link to set a new one (valid for 1 hour):</p>`,
    `<p><a href="${link}">${link}</a></p>`,
    `<p>If you didn't request this, you can ignore this email — your password will stay the same.</p>`,
  ].join("");
  const mailed = await sendMail(email, subject, text, html);
  return { token: raw, link, mailed };
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

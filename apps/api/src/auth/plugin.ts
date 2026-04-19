import type { FastifyInstance, FastifyRequest } from "fastify";
import { verifySession } from "./jwt.js";
import { sha256Hex } from "../crypto.js";
import { prisma } from "../db.js";
import type { AuthUser } from "./context.js";
import type { Role } from "@cofemine/shared";

export const SESSION_COOKIE = "cofemine_session";

async function loadUser(req: FastifyRequest): Promise<AuthUser | null> {
  const token =
    req.cookies[SESSION_COOKIE] ||
    (req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice(7)
      : undefined);
  if (!token) return null;
  try {
    const { sub, sid } = verifySession(token);
    const session = await prisma.session.findUnique({
      where: { id: sid },
      include: { user: true },
    });
    if (!session || session.userId !== sub) return null;
    if (session.expiresAt.getTime() < Date.now()) return null;
    if (session.tokenHash !== sha256Hex(token)) return null;
    return {
      id: session.user.id,
      email: session.user.email,
      username: session.user.username,
      role: session.user.role as Role,
      sessionId: session.id,
    };
  } catch {
    return null;
  }
}

export async function registerAuthHook(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (req) => {
    req.user = (await loadUser(req)) ?? undefined;
  });
}

import type { FastifyRequest } from "fastify";
import type { Role } from "@cofemine/shared";

export interface AuthUser {
  id: string;
  email: string;
  username: string;
  role: Role;
  sessionId: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

export function requireUser(req: FastifyRequest): AuthUser {
  if (!req.user) {
    const err = new Error("Unauthorized");
    (err as any).statusCode = 401;
    throw err;
  }
  return req.user;
}

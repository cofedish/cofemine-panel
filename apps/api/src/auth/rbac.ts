import type { FastifyReply, FastifyRequest } from "fastify";
import {
  hasPermission,
  type Permission,
  type Role,
  ROLE_RANK,
} from "@cofemine/shared";
import { prisma } from "../db.js";
import { requireUser } from "./context.js";

export function requireGlobalPermission(perm: Permission) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const user = requireUser(req);
    if (!hasPermission(user.role, perm)) {
      return reply.forbidden(`Missing global permission: ${perm}`);
    }
  };
}

/**
 * Check that the user is allowed to perform `perm` on the specific server.
 * Looks up server membership; if none exists, falls back to global role.
 * The most-permissive of (membership role, global role) wins.
 */
export async function assertServerPermission(
  req: FastifyRequest,
  serverId: string,
  perm: Permission
): Promise<void> {
  const user = requireUser(req);
  const membership = await prisma.membership.findUnique({
    where: { userId_serverId: { userId: user.id, serverId } },
  });
  const roles: Role[] = [user.role];
  if (membership) roles.push(membership.role as Role);
  const best = roles.reduce((a, b) =>
    ROLE_RANK[a] >= ROLE_RANK[b] ? a : b
  );
  if (!hasPermission(best, perm)) {
    const err = new Error(`Missing permission ${perm} on server ${serverId}`);
    (err as any).statusCode = 403;
    throw err;
  }
}

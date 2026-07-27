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
 * Roles whose *global* assignment is panel-wide: they administer the
 * installation itself, so their role also applies to every server.
 *
 * OPERATOR and VIEWER are deliberately NOT here: for them the global
 * role grants nothing on any specific server, and access comes from a
 * `Membership` row alone. Note this is not a *ceiling* — a Membership
 * may grant more than the global role (a global VIEWER with an ADMIN
 * membership is ADMIN on that server), which is the point of
 * memberships. Before this split, a global OPERATOR could
 * `POST /servers/<any-id>/command` — full console control over servers
 * they were never added to — while `GET /servers` deliberately hid
 * those same servers from them (see `servers/routes.ts`, the
 * `canSeeAll` branch). Keep the two rules in sync.
 *
 * Operational consequence: no route creates Membership rows yet, so
 * OPERATOR/VIEWER accounts currently have no server access at all
 * through the panel. That is the correct default, but the roles are
 * unusable until a membership endpoint exists.
 */
function globalRoleAppliesToAllServers(role: Role): boolean {
  return role === "OWNER" || role === "ADMIN";
}

/**
 * Check that the user is allowed to perform `perm` on the specific server.
 *
 * Effective role = most-permissive of:
 *   • the global role, but only for OWNER/ADMIN (see above), and
 *   • the per-server `Membership` role, when one exists.
 *
 * A scoped user (OPERATOR/VIEWER) with no membership on this server has
 * no effective role at all → 403, regardless of `perm`.
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
  const roles: Role[] = globalRoleAppliesToAllServers(user.role)
    ? [user.role]
    : [];
  if (membership) roles.push(membership.role as Role);
  if (roles.length === 0) {
    throw forbidden(perm, serverId);
  }
  const best = roles.reduce((a, b) =>
    ROLE_RANK[a] >= ROLE_RANK[b] ? a : b
  );
  if (!hasPermission(best, perm)) {
    throw forbidden(perm, serverId);
  }
}

/**
 * Request-free permission check, for code that runs outside an HTTP
 * request — currently the scheduler, which re-verifies that a
 * schedule's creator is still allowed to act on the target server
 * before every run.
 *
 * Same rule as `assertServerPermission`, returning a boolean instead of
 * throwing. Returns false when the user no longer exists.
 */
export async function userHasServerPermission(
  userId: string,
  serverId: string,
  perm: Permission
): Promise<boolean> {
  const [user, membership] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { role: true } }),
    prisma.membership.findUnique({
      where: { userId_serverId: { userId, serverId } },
    }),
  ]);
  if (!user) return false;
  const roles: Role[] = globalRoleAppliesToAllServers(user.role as Role)
    ? [user.role as Role]
    : [];
  if (membership) roles.push(membership.role as Role);
  if (roles.length === 0) return false;
  const best = roles.reduce((a, b) => (ROLE_RANK[a] >= ROLE_RANK[b] ? a : b));
  return hasPermission(best, perm);
}

function forbidden(perm: Permission, serverId: string): Error {
  // Same message shape for "no membership" and "membership too weak" so
  // the response doesn't tell a scoped user whether the server exists.
  return Object.assign(
    new Error(`Missing permission ${perm} on server ${serverId}`),
    { statusCode: 403 }
  );
}

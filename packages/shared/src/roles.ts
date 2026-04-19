export const ROLES = ["OWNER", "ADMIN", "OPERATOR", "VIEWER"] as const;
export type Role = (typeof ROLES)[number];

/** Higher = more power. Used for "role >= X" checks. */
export const ROLE_RANK: Record<Role, number> = {
  OWNER: 100,
  ADMIN: 75,
  OPERATOR: 50,
  VIEWER: 10,
};

export function roleAtLeast(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

export type Permission =
  | "server.view"
  | "server.control" // start/stop/restart/kill/command
  | "server.edit" // properties, env, files write
  | "server.delete"
  | "server.create"
  | "node.manage"
  | "user.manage"
  | "template.manage"
  | "integration.manage"
  | "audit.view";

/** Permission matrix at the *server scope* (also used as global fallback). */
export const PERMISSIONS: Record<Role, Permission[]> = {
  OWNER: [
    "server.view",
    "server.control",
    "server.edit",
    "server.delete",
    "server.create",
    "node.manage",
    "user.manage",
    "template.manage",
    "integration.manage",
    "audit.view",
  ],
  ADMIN: [
    "server.view",
    "server.control",
    "server.edit",
    "server.delete",
    "server.create",
    "node.manage",
    "template.manage",
    "integration.manage",
    "audit.view",
  ],
  OPERATOR: ["server.view", "server.control", "server.edit"],
  VIEWER: ["server.view"],
};

export function hasPermission(role: Role, perm: Permission): boolean {
  return PERMISSIONS[role].includes(perm);
}

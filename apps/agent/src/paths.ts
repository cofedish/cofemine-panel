import path from "node:path";
import { promises as fs } from "node:fs";
import { config } from "./config.js";

/**
 * A server id is a cuid, and it is used as a path component in both
 * roots below. `path.join` does not sanitise, so an id of `..` would
 * silently resolve to the root itself and an id of `../x` would escape
 * it entirely.
 *
 * Unreachable through the API today (ids come from Postgres, and calling
 * the agent directly needs the bearer token), so this is defence in
 * depth — but it is one regex guarding every filesystem route in the
 * service.
 */
const SERVER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function assertServerId(serverId: string): string {
  if (!SERVER_ID_RE.test(serverId)) {
    throw Object.assign(new Error("Invalid server id"), { statusCode: 400 });
  }
  return serverId;
}

export function dataDirFor(serverId: string): string {
  return path.join(config.AGENT_DATA_ROOT, assertServerId(serverId));
}

export function backupDirFor(serverId: string): string {
  return path.join(config.AGENT_BACKUP_ROOT, assertServerId(serverId));
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Resolve a user-supplied relative path safely inside a base directory.
 * Prevents path traversal. Returns the absolute, canonicalized path or throws.
 */
export function safeResolve(base: string, userPath: string): string {
  const clean = userPath.replace(/^[\\/]+/, "");
  const resolved = path.resolve(base, clean);
  const baseResolved = path.resolve(base);
  if (
    resolved !== baseResolved &&
    !resolved.startsWith(baseResolved + path.sep)
  ) {
    throw Object.assign(new Error("Path traversal detected"), {
      statusCode: 400,
    });
  }
  return resolved;
}

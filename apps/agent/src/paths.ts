import path from "node:path";
import { promises as fs } from "node:fs";
import { config } from "./config.js";

export function dataDirFor(serverId: string): string {
  return path.join(config.AGENT_DATA_ROOT, serverId);
}

export function backupDirFor(serverId: string): string {
  return path.join(config.AGENT_BACKUP_ROOT, serverId);
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

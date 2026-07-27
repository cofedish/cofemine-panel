import type { FastifyInstance } from "fastify";
import { z } from "zod";
import path from "node:path";
import { promises as fs, createReadStream, createWriteStream } from "node:fs";
import * as tar from "tar";
import { config } from "../config.js";
import { backupDirFor, dataDirFor, ensureDir } from "../paths.js";

const createBackupSchema = z.object({
  backupId: z.string().min(1),
  // Bare name only — it becomes `<name>.tar.gz` inside this server's
  // backup directory. Anything with a separator or a `..` would write
  // into another server's backups or straight into the host bind-mount.
  // The API validates the same shape; the agent must not depend on that.
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9._-]+$/, "Invalid backup name")
    .refine((n) => !n.startsWith("."), "Invalid backup name"),
});

const restoreSchema = z.object({
  serverId: z.string().min(1),
  path: z.string().min(1),
});

/**
 * Confine a caller-supplied absolute archive path to `base`.
 *
 * These two routes take a full path rather than a server-relative one
 * (the API passes back the exact path this agent handed it at create
 * time), so `safeResolve` — which resolves *relative* to a base — is
 * the wrong tool. The property to enforce is the same one though: the
 * resolved path must live under a directory we own.
 *
 * Without this the agent would `tar.extract` from, and `fs.rm`, any
 * path on the host filesystem for anyone who reached it — and the agent
 * runs alongside the Docker socket. `docs/security.md` claimed all file
 * routes were guarded; these two were the exception.
 */
function resolveArchivePath(base: string, candidate: string): string {
  const baseResolved = path.resolve(base);
  const resolved = path.resolve(candidate);
  if (
    resolved !== baseResolved &&
    !resolved.startsWith(baseResolved + path.sep)
  ) {
    throw Object.assign(
      new Error("Backup path is outside the backup root"),
      { statusCode: 400 }
    );
  }
  if (!resolved.endsWith(".tar.gz")) {
    throw Object.assign(new Error("Backup path must be a .tar.gz archive"), {
      statusCode: 400,
    });
  }
  return resolved;
}

export async function backupsAgentRoutes(app: FastifyInstance): Promise<void> {
  app.post("/servers/:id/backups", async (req) => {
    const { id } = req.params as { id: string };
    const body = createBackupSchema.parse(req.body);
    const dataDir = dataDirFor(id);
    const backupDir = backupDirFor(id);
    await ensureDir(backupDir);
    const filename = `${body.name}.tar.gz`;
    // Belt and braces on top of the schema: the write path goes through
    // the same confinement check as restore and delete, so all three
    // routes share one definition of "inside this server's backups".
    const fullPath = resolveArchivePath(backupDir, path.join(backupDir, filename));

    // List what to back up — the whole /data tree but skip cache / logs for size.
    await tar.create(
      {
        gzip: true,
        file: fullPath,
        cwd: dataDir,
        filter: (p) => !p.startsWith("./cache") && !p.startsWith("./logs"),
      },
      ["."]
    );
    const stat = await fs.stat(fullPath);
    return { path: fullPath, size: stat.size };
  });

  app.post("/backups/:id/restore", async (req, reply) => {
    const body = restoreSchema.parse(req.body);
    if (!body.path) return reply.code(400).send({ error: "missing path" });
    // Scoped to THIS server's backup directory, not just the backup
    // root: the API only ever restores a backup into the server that
    // produced it, so cross-server restores are a bug or an attack.
    const archivePath = resolveArchivePath(
      backupDirFor(body.serverId),
      body.path
    );
    const dataDir = dataDirFor(body.serverId);
    await ensureDir(dataDir);
    // Empty the data dir first to avoid leftovers.
    for (const entry of await fs.readdir(dataDir)) {
      await fs.rm(path.join(dataDir, entry), { recursive: true, force: true });
    }
    await tar.extract({ file: archivePath, cwd: dataDir });
    return { ok: true };
  });

  app.delete("/backups/:id", async (req) => {
    const q = req.query as { path?: string };
    if (q.path) {
      // Only the backup root here — this route doesn't learn which
      // server the archive belongs to.
      const archivePath = resolveArchivePath(
        config.AGENT_BACKUP_ROOT,
        q.path
      );
      await fs.rm(archivePath, { force: true });
    }
    return { ok: true };
  });

  void createReadStream;
  void createWriteStream;
}

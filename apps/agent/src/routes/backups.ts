import type { FastifyInstance } from "fastify";
import { z } from "zod";
import path from "node:path";
import { promises as fs, createReadStream, createWriteStream } from "node:fs";
import * as tar from "tar";
import { backupDirFor, dataDirFor, ensureDir } from "../paths.js";

const createBackupSchema = z.object({
  backupId: z.string().min(1),
  name: z.string().min(1),
});

const restoreSchema = z.object({
  serverId: z.string().min(1),
  path: z.string().min(1),
});

export async function backupsAgentRoutes(app: FastifyInstance): Promise<void> {
  app.post("/servers/:id/backups", async (req) => {
    const { id } = req.params as { id: string };
    const body = createBackupSchema.parse(req.body);
    const dataDir = dataDirFor(id);
    const backupDir = backupDirFor(id);
    await ensureDir(backupDir);
    const filename = `${body.name}.tar.gz`;
    const fullPath = path.join(backupDir, filename);

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
    const dataDir = dataDirFor(body.serverId);
    await ensureDir(dataDir);
    // Empty the data dir first to avoid leftovers.
    for (const entry of await fs.readdir(dataDir)) {
      await fs.rm(path.join(dataDir, entry), { recursive: true, force: true });
    }
    await tar.extract({ file: body.path, cwd: dataDir });
    return { ok: true };
  });

  app.delete("/backups/:id", async (req) => {
    const q = req.query as { path?: string };
    if (q.path) {
      await fs.rm(q.path, { force: true });
    }
    return { ok: true };
  });

  void createReadStream;
  void createWriteStream;
}

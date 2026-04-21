import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { promises as fs, createReadStream } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { request } from "undici";
import { docker, ensureNetwork } from "../docker.js";
import { dataDirFor, ensureDir, safeResolve } from "../paths.js";
import { getRuntime } from "../runtime/registry.js";
import { config } from "../config.js";
import { execInContainer, streamExecOutput } from "../utils/exec.js";
import { ensureImagePulled } from "../docker-pull.js";

const specSchema = z.object({
  id: z.string(),
  name: z.string(),
  containerName: z.string(),
  type: z.string(),
  version: z.string(),
  memoryMb: z.number().int(),
  cpuLimit: z.number().nullable().optional(),
  ports: z.array(
    z.object({
      host: z.number(),
      container: z.number(),
      protocol: z.enum(["tcp", "udp"]),
    })
  ),
  env: z.record(z.string(), z.string()),
  eulaAccepted: z.boolean(),
});

const commandSchema = z.object({
  command: z.string().min(1).max(1000),
});

const restoreFromSchema = z.object({
  sourceId: z.string().min(1),
});

const writeFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

async function findContainer(serverId: string) {
  const containers = await docker.listContainers({
    all: true,
    filters: JSON.stringify({
      label: [`${config.AGENT_LABEL_PREFIX}.serverId=${serverId}`],
    }),
  });
  if (containers.length === 0) return null;
  const first = containers[0];
  if (!first) return null;
  return docker.getContainer(first.Id);
}

export async function serversAgentRoutes(app: FastifyInstance): Promise<void> {
  app.post("/servers", async (req, reply) => {
    const spec = specSchema.parse(req.body);
    const runtime = getRuntime("itzg");
    await ensureNetwork(config.AGENT_DOCKER_NETWORK);
    const dataDir = dataDirFor(spec.id);
    await ensureDir(dataDir);

    const containerSpec = runtime.createContainerSpec(spec, dataDir);
    // Fresh hosts don't have the image; Docker daemon does not auto-pull
    // on create. Pull now (no-op if already present) to avoid the
    // "no such image" 404 the user would otherwise see on first server.
    const image = (containerSpec as any).Image as string;
    if (image) {
      req.log.info({ image }, "ensuring image is present");
      await ensureImagePulled(docker, image, (m) =>
        req.log.info(m)
      );
    }
    const container = await docker.createContainer(containerSpec);
    const info = await container.inspect();
    return reply.code(201).send({ containerId: info.Id });
  });

  /**
   * Recreate the container with an updated spec. /data survives because
   * it's a bind mount to AGENT_DATA_ROOT/<id>. Used to re-sync env vars
   * that changed after initial creation — e.g. a CurseForge API key
   * added in Integrations *after* the server was made.
   */
  app.post("/servers/:id/reprovision", async (req, reply) => {
    const spec = specSchema.parse(req.body);
    const runtime = getRuntime("itzg");
    await ensureNetwork(config.AGENT_DOCKER_NETWORK);
    const dataDir = dataDirFor(spec.id);
    await ensureDir(dataDir);
    const containerSpec = runtime.createContainerSpec(spec, dataDir);
    const image = (containerSpec as any).Image as string;
    if (image) {
      await ensureImagePulled(docker, image, (m) => req.log.info(m));
    }
    const existing = await findContainer(spec.id);
    if (existing) {
      try {
        await existing.stop({ t: 20 });
      } catch {}
      try {
        await existing.remove({ force: true });
      } catch (err) {
        req.log.warn(
          { err },
          "failed to remove existing container on reprovision"
        );
      }
    }
    const container = await docker.createContainer(containerSpec);
    const info = await container.inspect();
    return reply.code(200).send({ containerId: info.Id });
  });

  app.delete("/servers/:id", async (req) => {
    const { id } = req.params as { id: string };
    const container = await findContainer(id);
    if (container) {
      try {
        await container.stop({ t: 10 });
      } catch {
        // already stopped
      }
      await container.remove({ force: true, v: true });
    }
    const dir = dataDirFor(id);
    await fs.rm(dir, { recursive: true, force: true });
    return { ok: true };
  });

  for (const action of ["start", "stop", "restart", "kill"] as const) {
    app.post(`/servers/:id/${action}`, async (req, reply) => {
      const { id } = req.params as { id: string };
      const container = await findContainer(id);
      if (!container) return reply.code(404).send({ error: "No container" });
      switch (action) {
        case "start":
          await container.start().catch((err) => {
            if (!String(err).includes("already started")) throw err;
          });
          break;
        case "stop":
          await container.stop({ t: 20 }).catch(() => {});
          break;
        case "restart":
          await container.restart({ t: 20 });
          break;
        case "kill":
          await container.kill().catch(() => {});
          break;
      }
      return { ok: true };
    });
  }

  app.post("/servers/:id/command", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = commandSchema.parse(req.body);
    const container = await findContainer(id);
    if (!container) return reply.code(404).send({ error: "No container" });
    const info = await container.inspect();
    if (!info.State.Running) {
      return reply.code(409).send({ error: "Server not running" });
    }
    // itzg ships mc-send-to-console and rcon-cli; rcon-cli is preferred.
    const output = await execInContainer(container, [
      "rcon-cli",
      body.command,
    ]);
    return { ok: true, output };
  });

  app.post("/servers/:id/restore-from", async (req) => {
    const { id } = req.params as { id: string };
    const body = restoreFromSchema.parse(req.body);
    const src = dataDirFor(body.sourceId);
    const dst = dataDirFor(id);
    await ensureDir(dst);
    await copyRecursive(src, dst);
    return { ok: true };
  });

  app.get("/servers/:id/stats", async (req, reply) => {
    const { id } = req.params as { id: string };
    const container = await findContainer(id);
    if (!container) return reply.code(404).send({ error: "No container" });
    const info = await container.inspect();
    if (!info.State.Running) {
      return {
        status: info.State.Status,
        startedAt: info.State.StartedAt,
        cpu: null,
        memoryBytes: null,
        memoryLimitBytes: null,
      };
    }
    const stats = await new Promise<any>((resolve, reject) => {
      (container as any).stats({ stream: false }, (err: Error | null, data: any) => {
        if (err) reject(err);
        else resolve(data);
      });
    });
    const cpuDelta =
      stats.cpu_stats.cpu_usage.total_usage -
      stats.precpu_stats.cpu_usage.total_usage;
    const sysDelta =
      stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
    const cpuPct =
      sysDelta > 0 && cpuDelta > 0
        ? (cpuDelta / sysDelta) *
          (stats.cpu_stats.online_cpus ?? 1) *
          100
        : 0;
    return {
      status: info.State.Status,
      startedAt: info.State.StartedAt,
      cpuPercent: Number(cpuPct.toFixed(2)),
      memoryBytes: stats.memory_stats.usage ?? 0,
      memoryLimitBytes: stats.memory_stats.limit ?? 0,
    };
  });

  app.get("/servers/:id/players", async (req, reply) => {
    const { id } = req.params as { id: string };
    const container = await findContainer(id);
    if (!container) return reply.code(404).send({ error: "No container" });
    const info = await container.inspect();
    if (!info.State.Running) return { online: 0, max: 0, players: [] };
    try {
      const out = await execInContainer(container, ["rcon-cli", "list"]);
      return parseListOutput(out);
    } catch {
      return { online: 0, max: 0, players: [] };
    }
  });

  // Basic file manager
  app.get("/servers/:id/files", async (req) => {
    const { id } = req.params as { id: string };
    const rel = (req.query as { path?: string }).path ?? "";
    const base = dataDirFor(id);
    const abs = safeResolve(base, rel);
    await ensureDir(base);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) return { kind: "missing", path: rel };
    if (stat.isDirectory()) {
      const entries = await fs.readdir(abs, { withFileTypes: true });
      return {
        kind: "dir",
        path: rel,
        entries: entries.map((e) => ({
          name: e.name,
          isDir: e.isDirectory(),
        })),
      };
    }
    if (stat.size > 2 * 1024 * 1024) {
      return { kind: "file", path: rel, size: stat.size, truncated: true };
    }
    const content = await fs.readFile(abs, "utf8");
    return { kind: "file", path: rel, size: stat.size, content };
  });

  app.put("/servers/:id/files", async (req) => {
    const { id } = req.params as { id: string };
    const body = writeFileSchema.parse(req.body);
    const base = dataDirFor(id);
    const abs = safeResolve(base, body.path);
    await ensureDir(path.dirname(abs));
    await fs.writeFile(abs, body.content, "utf8");
    return { ok: true };
  });

  app.delete("/servers/:id/files", async (req) => {
    const { id } = req.params as { id: string };
    const rel = (req.query as { path?: string }).path ?? "";
    if (!rel) return { ok: true };
    const base = dataDirFor(id);
    const abs = safeResolve(base, rel);
    await fs.rm(abs, { recursive: true, force: true });
    return { ok: true };
  });

  // Icon (64x64 PNG). Writes /data/server-icon.png which itzg exposes
  // automatically. Expects a base64-encoded PNG data URL.
  app.get("/servers/:id/icon", async (req, reply) => {
    const { id } = req.params as { id: string };
    const base = dataDirFor(id);
    const p = path.join(base, "server-icon.png");
    try {
      const buf = await fs.readFile(p);
      return { data: `data:image/png;base64,${buf.toString("base64")}` };
    } catch {
      return reply.code(404).send({ error: "no icon" });
    }
  });

  app.post("/servers/:id/icon", async (req) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({ data: z.string().regex(/^data:image\/png;base64,/) })
      .parse(req.body);
    const base64 = body.data.slice("data:image/png;base64,".length);
    const buf = Buffer.from(base64, "base64");
    const base = dataDirFor(id);
    await ensureDir(base);
    await fs.writeFile(path.join(base, "server-icon.png"), buf);
    return { ok: true, size: buf.length };
  });

  app.delete("/servers/:id/icon", async (req) => {
    const { id } = req.params as { id: string };
    const base = dataDirFor(id);
    await fs.rm(path.join(base, "server-icon.png"), { force: true });
    return { ok: true };
  });

  /**
   * List content installed into /data/mods, /data/plugins and
   * /data/world/datapacks. Each entry is enriched via Modrinth's
   * /version_files hash lookup: given the SHA1 of a jar, Modrinth can
   * tell us the project (title / icon / author). Works for any mod that
   * was originally uploaded to Modrinth, regardless of how it ended up
   * on disk (CF AUTO install, manual upload, modpack include).
   */
  app.get("/servers/:id/installed-content", async (req) => {
    const { id } = req.params as { id: string };
    const base = dataDirFor(id);
    const [mods, plugins, datapacks] = await Promise.all([
      listHashedJarDir(base, "mods"),
      listHashedJarDir(base, "plugins"),
      listHashedJarDir(base, "world/datapacks"),
    ]);

    const allHashes = [...mods, ...plugins, ...datapacks]
      .map((f) => f.sha1)
      .filter((h): h is string => typeof h === "string");

    const { versions, projects } = await modrinthLookupByHash(
      allHashes,
      req.log
    );

    const enrich = (f: HashedFile): EnrichedFile => {
      const v = f.sha1 ? versions[f.sha1] : undefined;
      const p = v?.project_id ? projects[v.project_id] : undefined;
      return {
        name: f.name,
        size: f.size,
        mtime: f.mtime,
        modrinth: p
          ? {
              slug: p.slug as string,
              title: p.title as string,
              description: p.description as string | undefined,
              icon: p.icon_url as string | null,
              versionNumber: v?.version_number as string | undefined,
              pageUrl: `https://modrinth.com/${p.project_type ?? "mod"}/${p.slug}`,
            }
          : undefined,
      };
    };

    return {
      mods: mods.map(enrich),
      plugins: plugins.map(enrich),
      datapacks: datapacks.map(enrich),
    };
  });

  app.delete("/servers/:id/installed-content", async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { type?: string; name?: string };
    if (!q.type || !q.name)
      return reply.code(400).send({ error: "type and name required" });
    const dirMap: Record<string, string> = {
      mods: "mods",
      plugins: "plugins",
      datapacks: "world/datapacks",
    };
    const subdir = dirMap[q.type];
    if (!subdir) return reply.code(400).send({ error: "unknown type" });
    const base = dataDirFor(id);
    const file = safeResolve(base, `${subdir}/${q.name}`);
    await fs.rm(file, { force: true });
    return { ok: true };
  });

  /**
   * Parse recent container logs for CurseForge 403 "Retry" failures —
   * mods where the pack points at a file the author has disabled for
   * third-party downloads. Deduped by mod; last retry count kept.
   */
  app.get("/servers/:id/install-failures", async (req) => {
    const { id } = req.params as { id: string };
    const container = await findContainer(id);
    if (!container) return { failures: [] };
    const rawLogs = (await container.logs({
      follow: false,
      stdout: true,
      stderr: true,
      tail: 3000,
      timestamps: false,
    })) as unknown as Buffer;
    const text = demuxLogBuffer(rawLogs);
    return { failures: parseCfFailures(text) };
  });

  app.get("/servers/:id/properties", async (req) => {
    const { id } = req.params as { id: string };
    const base = dataDirFor(id);
    const abs = safeResolve(base, "server.properties");
    const content = await fs.readFile(abs, "utf8").catch(() => "");
    return { raw: content, parsed: parseProperties(content) };
  });

  app.put("/servers/:id/properties", async (req) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({ properties: z.record(z.string(), z.string()) })
      .parse(req.body);
    const base = dataDirFor(id);
    const abs = safeResolve(base, "server.properties");
    const current = await fs.readFile(abs, "utf8").catch(() => "");
    const next = mergeProperties(current, body.properties);
    await fs.writeFile(abs, next, "utf8");
    return { ok: true };
  });

  void streamExecOutput; // re-export anchor
}

type HashedFile = {
  name: string;
  size: number;
  mtime: string;
  sha1?: string;
};

type EnrichedFile = {
  name: string;
  size: number;
  mtime: string;
  modrinth?: {
    slug: string;
    title: string;
    description?: string;
    icon?: string | null;
    versionNumber?: string;
    pageUrl: string;
  };
};

/**
 * Read one dir of JAR/ZIP content, streaming-SHA1 each file so we can
 * look it up on Modrinth. Returns an empty list when the dir is absent.
 * Non-jar/zip files are skipped to avoid hashing large worlds by accident.
 */
async function listHashedJarDir(
  base: string,
  subdir: string
): Promise<HashedFile[]> {
  const dir = path.join(base, subdir);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter(
          (e) =>
            e.isFile() &&
            (e.name.endsWith(".jar") || e.name.endsWith(".zip"))
        )
        .map(async (e): Promise<HashedFile> => {
          const full = path.join(dir, e.name);
          const [stat, sha1] = await Promise.all([
            fs.stat(full),
            streamSha1(full).catch(() => undefined),
          ]);
          return {
            name: e.name,
            size: stat.size,
            mtime: stat.mtime.toISOString(),
            sha1,
          };
        })
    );
    return files.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function streamSha1(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha1");
    const s = createReadStream(file);
    s.on("data", (chunk) => hash.update(chunk));
    s.on("error", reject);
    s.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Ask Modrinth to resolve a batch of SHA1 hashes to project metadata.
 * Two calls:
 *   POST /v2/version_files { hashes, algorithm: "sha1" }
 *   GET  /v2/projects?ids=[...]
 * Safe to call with an empty hash list — returns empty maps. Never
 * throws; on failure the UI just falls back to raw filenames.
 */
async function modrinthLookupByHash(
  hashes: string[],
  log?: { warn: (obj: unknown, msg?: string) => void }
): Promise<{
  versions: Record<string, any>;
  projects: Record<string, any>;
}> {
  if (hashes.length === 0) return { versions: {}, projects: {} };
  const ua =
    "cofemine-panel/0.1 (+https://github.com/cofemine/panel)";
  try {
    const vr = await request("https://api.modrinth.com/v2/version_files", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": ua },
      body: JSON.stringify({ hashes, algorithm: "sha1" }),
    });
    if (vr.statusCode >= 400) return { versions: {}, projects: {} };
    const versions = (await vr.body.json()) as Record<string, any>;
    const projectIds = new Set<string>();
    for (const v of Object.values(versions)) {
      if (v?.project_id) projectIds.add(v.project_id as string);
    }
    if (projectIds.size === 0) return { versions, projects: {} };
    const idsJson = JSON.stringify([...projectIds]);
    const pr = await request(
      `https://api.modrinth.com/v2/projects?ids=${encodeURIComponent(idsJson)}`,
      { headers: { "user-agent": ua } }
    );
    if (pr.statusCode >= 400) return { versions, projects: {} };
    const projectsList = (await pr.body.json()) as any[];
    const projects = Object.fromEntries(projectsList.map((p) => [p.id, p]));
    return { versions, projects };
  } catch (err) {
    log?.warn({ err }, "modrinth hash lookup failed");
    return { versions: {}, projects: {} };
  }
}

/** Demux Docker's multiplexed log stream into a single utf-8 string. */
function demuxLogBuffer(buf: Buffer): string {
  const parts: string[] = [];
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const size = buf.readUInt32BE(offset + 4);
    parts.push(buf.slice(offset + 8, offset + 8 + size).toString("utf8"));
    offset += 8 + size;
  }
  return parts.join("");
}

/**
 * Pull all CurseForge-download failures from itzg's init log. Dedups by
 * mod name and captures the CurseForge mod ID / file ID when visible in
 * the URL (so the UI can link directly to the pack page).
 */
function parseCfFailures(text: string): Array<{
  fileName: string;
  modName: string;
  lastRetry: number;
  modId?: number;
  fileId?: number;
  url?: string;
}> {
  const re =
    /Retry #(\d+) download of (\S+?) @ ([^:]+):[^\n]*?(?:HTTP request of (\S+))?[^\n]*?403 Forbidden/g;
  const dedup = new Map<string, {
    fileName: string;
    modName: string;
    lastRetry: number;
    modId?: number;
    fileId?: number;
    url?: string;
  }>();
  for (const m of text.matchAll(re)) {
    const retry = Number(m[1]);
    const fileName = m[2] ?? "";
    const modName = (m[3] ?? "").trim();
    const url = m[4];
    const idMatch = url?.match(/\/mods\/(\d+)\/files\/(\d+)/);
    const key = `${modName}|${fileName}`;
    const prev = dedup.get(key);
    if (!prev || retry > prev.lastRetry) {
      dedup.set(key, {
        fileName,
        modName,
        lastRetry: retry,
        modId: idMatch ? Number(idMatch[1]) : prev?.modId,
        fileId: idMatch ? Number(idMatch[2]) : prev?.fileId,
        url: url ?? prev?.url,
      });
    }
  }
  return [...dedup.values()].sort((a, b) =>
    a.modName.localeCompare(b.modName)
  );
}

function parseProperties(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function mergeProperties(
  current: string,
  updates: Record<string, string>
): string {
  const lines = current.split(/\r?\n/);
  const handled = new Set<string>();
  const result = lines.map((line) => {
    if (!line || line.startsWith("#")) return line;
    const eq = line.indexOf("=");
    if (eq < 1) return line;
    const key = line.slice(0, eq).trim();
    if (key in updates) {
      handled.add(key);
      return `${key}=${updates[key]}`;
    }
    return line;
  });
  for (const [k, v] of Object.entries(updates)) {
    if (!handled.has(k)) result.push(`${k}=${v}`);
  }
  return result.join("\n");
}

function parseListOutput(raw: string): {
  online: number;
  max: number;
  players: string[];
} {
  // Typical vanilla output: "There are 2 of a max of 20 players online: Alice, Bob"
  const m = raw.match(
    /There are (\d+) ?(?:of a max of|\/) ?(\d+) players online:?\s*(.*)/i
  );
  if (!m) return { online: 0, max: 0, players: [] };
  const onlineStr = m[1] ?? "0";
  const maxStr = m[2] ?? "0";
  const rest = (m[3] ?? "").trim();
  return {
    online: Number(onlineStr),
    max: Number(maxStr),
    players: rest
      ? rest.split(",").map((s) => s.trim()).filter(Boolean)
      : [],
  };
}

async function copyRecursive(src: string, dst: string): Promise<void> {
  await fs.cp(src, dst, { recursive: true, force: true });
}

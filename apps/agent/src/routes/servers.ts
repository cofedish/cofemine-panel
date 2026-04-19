import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import { docker, ensureNetwork } from "../docker.js";
import { dataDirFor, ensureDir, safeResolve } from "../paths.js";
import { getRuntime } from "../runtime/registry.js";
import { config } from "../config.js";
import { execInContainer, streamExecOutput } from "../utils/exec.js";

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
    const container = await docker.createContainer(containerSpec);
    const info = await container.inspect();
    return reply.code(201).send({ containerId: info.Id });
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

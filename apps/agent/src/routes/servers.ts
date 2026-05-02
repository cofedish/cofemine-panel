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

type HealthState = "healthy" | "unhealthy" | "starting" | null;

/**
 * Read Docker's parenthesised health hint out of the human-readable
 * Status string (the one listContainers returns alongside State).
 * Avoids a per-container inspect() call in the batch state endpoint.
 */
function parseHealthFromStatus(status: string | undefined): HealthState {
  if (!status) return null;
  const m = /\(([^)]+)\)/.exec(status);
  if (!m) return null;
  const inner = m[1]!.toLowerCase();
  if (inner.includes("starting")) return "starting";
  if (inner === "healthy") return "healthy";
  if (inner === "unhealthy") return "unhealthy";
  return null;
}

/**
 * Normalise Docker's `State.Health.Status` (returned from inspect)
 * to the same vocabulary as parseHealthFromStatus. Docker reports
 * "starting" / "healthy" / "unhealthy" / "none".
 */
function mapDockerHealth(s: string): HealthState {
  const v = s.toLowerCase();
  if (v === "starting") return "starting";
  if (v === "healthy") return "healthy";
  if (v === "unhealthy") return "unhealthy";
  return null;
}

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
          await startWithPortRecovery(container, id, req.log);
          break;
        case "stop":
          // Actually stop — don't swallow errors. If SIGTERM+timeout didn't
          // work, escalate to SIGKILL so the next Start isn't blocked by a
          // container that's still binding the host port.
          await stopReliably(container, req.log);
          break;
        case "restart":
          await stopReliably(container, req.log);
          await startWithPortRecovery(container, id, req.log);
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

  /**
   * Lightweight batch state endpoint for the panel-API's status
   * reconciler. Returns docker `State.Status` for every container
   * the agent manages (filtered by our label), keyed by serverId.
   *
   * Lightweight = no `docker stats` call (which is slow because it
   * polls the kernel cgroups). Just `listContainers` which Docker
   * answers from its own state.
   */
  app.get("/servers/state", async () => {
    const containers = await docker.listContainers({
      all: true,
      filters: JSON.stringify({
        label: [`${config.AGENT_LABEL_PREFIX}.managed=true`],
      }),
    });
    const states: Record<
      string,
      {
        status: string;
        state: string;
        health: "healthy" | "unhealthy" | "starting" | null;
        startedAt?: string | null;
      }
    > = {};
    for (const c of containers) {
      const id = c.Labels?.[`${config.AGENT_LABEL_PREFIX}.serverId`];
      if (!id) continue;
      states[id] = {
        // `c.State` from listContainers is one of: created / restarting /
        // running / removing / paused / exited / dead. Match against
        // it directly — this is what Docker daemon reports.
        state: c.State,
        status: c.Status, // human-readable like "Up 4 minutes (healthy)"
        // Parse the parenthesised health hint that Docker appends to
        // the human-readable Status string. Cheaper than calling
        // inspect() on every container just to read State.Health.
        // Format examples:
        //   "Up 4 minutes"                    → null
        //   "Up 4 minutes (healthy)"          → healthy
        //   "Up 4 minutes (unhealthy)"        → unhealthy
        //   "Up 4 minutes (health: starting)" → starting
        health: parseHealthFromStatus(c.Status),
      };
    }
    return states;
  });

  /** Single-container variant of /servers/state. Used by the API
   *  detail endpoint when the user opens one server's page so we
   *  don't pull in every other container's state too. */
  app.get("/servers/:id/state", async (req, reply) => {
    const { id } = req.params as { id: string };
    const container = await findContainer(id);
    if (!container) return reply.code(404).send({ error: "No container" });
    const info = await container.inspect();
    return {
      state: info.State.Status,
      running: Boolean(info.State.Running),
      // State.Health is undefined when there's no HEALTHCHECK on the
      // image. itzg ships one (mc-monitor pings RCON), so it's
      // present for managed MC containers.
      health: (info.State as { Health?: { Status?: string } }).Health?.Status
        ? mapDockerHealth(
            (info.State as { Health: { Status: string } }).Health.Status
          )
        : null,
      startedAt: info.State.StartedAt,
    };
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

    // Fallback: anything that didn't resolve by SHA1 (pack-bundled jars,
    // CF-only uploads that also happen to exist on Modrinth, etc.) —
    // try a Modrinth project lookup by slug derived from the filename.
    // Catches the common case where JEI / Create / AE2 etc. got dropped
    // in by itzg's CF AUTO install and have no hash match.
    const unresolvedSlugs = new Set<string>();
    for (const f of [...mods, ...plugins, ...datapacks]) {
      const resolvedByHash = f.sha1 ? versions[f.sha1] : undefined;
      if (resolvedByHash) continue;
      const slug = slugFromFilename(f.name);
      if (slug) unresolvedSlugs.add(slug);
    }
    const projectsBySlug = await modrinthLookupBySlug(
      [...unresolvedSlugs],
      req.log
    );

    // CurseForge fingerprint lookup — only files that are still unresolved
    // after both Modrinth passes. Compute CF's custom Murmur2 hash for
    // each jar (whitespace-stripped, seed=1) and ask the CF API to map
    // them to mod IDs + icon URLs. Gated on an x-cf-api-key header so we
    // don't churn a key the operator hasn't configured.
    const cfApiKey = (req.headers["x-cf-api-key"] as string | undefined) ?? "";
    const cfByName: Record<string, CfProjectMeta> = {};
    if (cfApiKey) {
      const stillUnresolved: Array<{ subdir: string; file: HashedFile }> = [];
      const groups: Array<{ subdir: string; files: HashedFile[] }> = [
        { subdir: "mods", files: mods },
        { subdir: "plugins", files: plugins },
        { subdir: "world/datapacks", files: datapacks },
      ];
      for (const g of groups) {
        for (const f of g.files) {
          const resolvedByHash = f.sha1 ? versions[f.sha1] : undefined;
          if (resolvedByHash) continue;
          const slug = slugFromFilename(f.name);
          if (slug && projectsBySlug[slug]) continue;
          stillUnresolved.push({ subdir: g.subdir, file: f });
        }
      }
      if (stillUnresolved.length > 0) {
        const fpPairs = await Promise.all(
          stillUnresolved.map(async ({ subdir, file }) => {
            const full = path.join(base, subdir, file.name);
            try {
              const fp = await cfMurmur2(full);
              return { name: file.name, fp };
            } catch {
              return { name: file.name, fp: null as number | null };
            }
          })
        );
        const fps = fpPairs
          .map((p) => p.fp)
          .filter((x): x is number => typeof x === "number");
        const cfHits = await curseforgeFingerprintLookup(
          fps,
          cfApiKey,
          req.log
        );
        for (const pair of fpPairs) {
          if (pair.fp == null) continue;
          const hit = cfHits[pair.fp];
          if (hit) cfByName[pair.name] = hit;
        }
      }
    }

    const enrich = (f: HashedFile): EnrichedFile => {
      const v = f.sha1 ? versions[f.sha1] : undefined;
      const p = v?.project_id ? projects[v.project_id] : undefined;
      if (p) {
        return {
          name: f.name,
          size: f.size,
          mtime: f.mtime,
          modrinth: {
            slug: p.slug as string,
            title: p.title as string,
            description: p.description as string | undefined,
            icon: p.icon_url as string | null,
            versionNumber: v?.version_number as string | undefined,
            pageUrl: `https://modrinth.com/${p.project_type ?? "mod"}/${p.slug}`,
          },
        };
      }
      const slugGuess = slugFromFilename(f.name);
      const sp = slugGuess ? projectsBySlug[slugGuess] : undefined;
      if (sp) {
        return {
          name: f.name,
          size: f.size,
          mtime: f.mtime,
          modrinth: {
            slug: sp.slug as string,
            title: sp.title as string,
            description: sp.description as string | undefined,
            icon: sp.icon_url as string | null,
            // No version match without a hash, just skip the version row.
            pageUrl: `https://modrinth.com/${sp.project_type ?? "mod"}/${sp.slug}`,
          },
        };
      }
      const cf = cfByName[f.name];
      if (cf) {
        return {
          name: f.name,
          size: f.size,
          mtime: f.mtime,
          curseforge: cf,
        };
      }
      return { name: f.name, size: f.size, mtime: f.mtime };
    };

    return {
      mods: mods.map(enrich),
      plugins: plugins.map(enrich),
      datapacks: datapacks.map(enrich),
      // Authoritative loader + MC version, derived from artefacts itzg
      // (or a manual install) actually drops into /data. Used by the
      // Browse-and-install search on modpack-source servers where the
      // panel's static `server.type` doesn't tell us the real loader.
      runtime: await detectRuntime(base, mods),
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
   * Parse recent container logs for CurseForge install problems.
   * Two flavours surfaced:
   *   - `failures[]` — per-mod 403s where the author disabled third-party
   *     downloads. These are fixable via "Skip failures & retry" / Modrinth
   *     replacements.
   *   - `interrupt` — a generic install abort (network timeout, retries
   *     exhausted, "Failed to auto-install CurseForge modpack"). Not a
   *     per-mod fix; usually resolves itself on the next Start because
   *     already-downloaded files are kept.
   */
  app.get("/servers/:id/install-failures", async (req) => {
    const { id } = req.params as { id: string };
    const container = await findContainer(id);
    if (!container) {
      return {
        failures: [],
        interrupt: null,
        booted: false,
        containerHasProxyEnv: false,
      };
    }
    // Scope the log read to logs produced since the container's most
    // recent StartedAt. Without this, a successful boot from an earlier
    // run would still show its "Done!" marker forever, tricking the
    // watchdog into thinking every subsequent install also booted.
    const info = await container.inspect().catch(() => null);
    const startedAt = info?.State?.StartedAt;
    const sinceUnix =
      startedAt && Number.isFinite(new Date(startedAt).getTime())
        ? Math.floor(new Date(startedAt).getTime() / 1000)
        : undefined;
    const rawLogs = (await container.logs({
      follow: false,
      stdout: true,
      stderr: true,
      tail: 3000,
      timestamps: false,
      ...(sinceUnix ? { since: sinceUnix } : {}),
    } as unknown as { follow: false })) as unknown as Buffer;
    const text = demuxLogBuffer(rawLogs);
    const interrupt = parseInstallInterrupt(text);
    const booted = detectBooted(text);
    // Reflect whether the container's actual Config.Env carries a
    // proxy injection (HTTPS_PROXY or socks-flavoured JAVA_TOOL_OPTIONS).
    // The DB-side flag only records intent — `toggleProxyAndRestart`
    // can fail mid-flight (reconcile or start throws) and leave the
    // DB saying "proxy=on" while the live container has nothing.
    // The watchdog now uses this to detect that desync and force a
    // clean reprovision instead of sitting on the wrong state.
    const containerEnv = info?.Config?.Env ?? [];
    const containerHasProxyEnv = containerEnv.some(
      (line) =>
        /^HTTPS_PROXY=/.test(line) ||
        /^HTTP_PROXY=/.test(line) ||
        /^JAVA_TOOL_OPTIONS=.*-DsocksProxyHost=/.test(line) ||
        /^JAVA_TOOL_OPTIONS=.*-Dhttps\.proxyHost=/.test(line)
    );
    return {
      failures: parseCfFailures(text),
      // If the MC server booted AFTER the last install interrupt, the
      // install obviously succeeded and the interrupt is stale. Suppress
      // it so UI + watchdog see a clean "booted" state.
      interrupt: booted ? null : interrupt,
      booted,
      containerHasProxyEnv,
    };
  });

  /**
   * List crash reports written by the MC server into /data/crash-reports.
   * Each entry carries a parsed summary (time, exception, suspect mods)
   * so the UI can show the important bits without downloading the whole
   * file. Also includes hs_err_pidNNN.log files from the JVM when present.
   */
  app.get("/servers/:id/crash-reports", async (req) => {
    const { id } = req.params as { id: string };
    const base = dataDirFor(id);
    const reports = await listCrashReports(base);
    return { reports };
  });

  app.get("/servers/:id/crash-reports/:name", async (req, reply) => {
    const { id, name } = req.params as { id: string; name: string };
    const base = dataDirFor(id);
    const abs = resolveCrashReport(base, name);
    if (!abs) return reply.code(400).send({ error: "invalid name" });
    try {
      const content = await fs.readFile(abs, "utf8");
      const stat = await fs.stat(abs);
      return {
        name,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        content,
        summary: parseCrashReport(content),
      };
    } catch {
      return reply.code(404).send({ error: "not found" });
    }
  });

  app.delete("/servers/:id/crash-reports/:name", async (req, reply) => {
    const { id, name } = req.params as { id: string; name: string };
    const base = dataDirFor(id);
    const abs = resolveCrashReport(base, name);
    if (!abs) return reply.code(400).send({ error: "invalid name" });
    await fs.rm(abs, { force: true });
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
  curseforge?: CfProjectMeta;
};

type CfProjectMeta = {
  modId: number;
  slug?: string;
  title: string;
  summary?: string;
  icon?: string | null;
  pageUrl?: string;
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

// 10-minute in-memory cache of Modrinth project lookups by slug. SWR on
// the web side polls installed-content every 15s; without this we'd hit
// Modrinth for every unresolved jar on every poll.
const slugCache = new Map<string, { at: number; project: any | null }>();
const SLUG_TTL_MS = 10 * 60 * 1000;

/**
 * Resolve a batch of candidate Modrinth slugs (derived from JAR filenames)
 * to full project metadata. Modrinth's `/v2/projects?ids=[...]` accepts
 * both project IDs and slugs, so we can look up many in one call.
 * Returns a { slug → project } map. Missing slugs are remembered as
 * negative hits so we don't keep hammering the API for CF-exclusive
 * mods that Modrinth will never know about.
 */
async function modrinthLookupBySlug(
  slugs: string[],
  log?: { warn: (obj: unknown, msg?: string) => void }
): Promise<Record<string, any>> {
  const now = Date.now();
  const out: Record<string, any> = {};
  const needFetch: string[] = [];
  for (const s of slugs) {
    const cached = slugCache.get(s);
    if (cached && now - cached.at < SLUG_TTL_MS) {
      if (cached.project) out[s] = cached.project;
    } else {
      needFetch.push(s);
    }
  }
  if (needFetch.length === 0) return out;

  const ua = "cofemine-panel/0.1 (+https://github.com/cofemine/panel)";
  try {
    const idsJson = JSON.stringify(needFetch);
    const pr = await request(
      `https://api.modrinth.com/v2/projects?ids=${encodeURIComponent(idsJson)}`,
      { headers: { "user-agent": ua } }
    );
    if (pr.statusCode >= 400) {
      // Some slug in the batch was invalid. Fall back to per-slug GETs
      // so a single bad slug doesn't poison the whole list.
      await Promise.all(
        needFetch.map(async (s) => {
          try {
            const r = await request(
              `https://api.modrinth.com/v2/project/${encodeURIComponent(s)}`,
              { headers: { "user-agent": ua } }
            );
            if (r.statusCode >= 400) {
              slugCache.set(s, { at: now, project: null });
              await r.body.dump().catch(() => {});
              return;
            }
            const proj = (await r.body.json()) as any;
            slugCache.set(s, { at: now, project: proj });
            out[s] = proj;
          } catch {
            slugCache.set(s, { at: now, project: null });
          }
        })
      );
      return out;
    }
    const list = (await pr.body.json()) as any[];
    const bySlug = new Map<string, any>();
    for (const p of list) {
      if (p?.slug) bySlug.set(String(p.slug), p);
    }
    for (const s of needFetch) {
      const p = bySlug.get(s) ?? null;
      slugCache.set(s, { at: now, project: p });
      if (p) out[s] = p;
    }
    return out;
  } catch (err) {
    log?.warn({ err }, "modrinth slug lookup failed");
    return out;
  }
}

/**
 * Heuristic slug-from-filename for installed jars. Strips the extension,
 * normalises separators, and chops off the version tail (1.20.1, v1.2,
 * mc1.20, -neo-, -forge-, …) so what remains is the mod's root slug.
 * Purely best-effort — returns "" when the filename is too mangled.
 */
function slugFromFilename(name: string): string {
  let s = name.toLowerCase();
  s = s.replace(/\.(jar|zip)$/, "");
  s = s.replace(/[_\s]+/g, "-");
  const m = s.match(
    /^([a-z][a-z-]*?)(?=-\d|-v\d|-mc\d|-neo|-forge|-fabric|-quilt|$)/
  );
  return (m?.[1] ?? s).replace(/-+$/, "");
}

// CurseForge fingerprint cache — keyed by Murmur2 hash. CF doesn't
// rename files once published, so the mapping hash → modId is stable
// forever; a longer TTL here saves API calls when the install list
// barely changes between polls.
const cfFpCache = new Map<number, { at: number; meta: CfProjectMeta | null }>();
const CF_FP_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Look up CurseForge "fingerprints" (Murmur2 hashes of mod jars with
 * whitespace removed). Returns a map fingerprint → { modId, icon, … }.
 *
 * Flow:
 *   POST /v1/fingerprints { fingerprints: [...] }
 *     → list of { id (fingerprint), file: { modId } }
 *   POST /v1/mods          { modIds: [...] }
 *     → list of { id, name, slug, logo.url, summary, links.websiteUrl }
 *
 * All failures are swallowed and logged — the caller already has
 * a reasonable fallback (raw filename), so worst case the icon just
 * doesn't appear.
 */
async function curseforgeFingerprintLookup(
  fingerprints: number[],
  apiKey: string,
  log?: { warn: (obj: unknown, msg?: string) => void }
): Promise<Record<number, CfProjectMeta>> {
  const now = Date.now();
  const out: Record<number, CfProjectMeta> = {};
  const needFetch: number[] = [];
  for (const fp of fingerprints) {
    const cached = cfFpCache.get(fp);
    if (cached && now - cached.at < CF_FP_TTL_MS) {
      if (cached.meta) out[fp] = cached.meta;
    } else {
      needFetch.push(fp);
    }
  }
  if (needFetch.length === 0) return out;

  try {
    const fpRes = await request(
      "https://api.curseforge.com/v1/fingerprints",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify({ fingerprints: needFetch }),
      }
    );
    if (fpRes.statusCode >= 400) {
      await fpRes.body.dump().catch(() => {});
      // remember negative so we don't retry every poll
      for (const fp of needFetch) cfFpCache.set(fp, { at: now, meta: null });
      return out;
    }
    const fpBody = (await fpRes.body.json()) as any;
    const matches = (fpBody?.data?.exactMatches ?? []) as Array<{
      id?: number;
      file?: { modId?: number; id?: number };
    }>;
    // Keep the association: fingerprint → modId
    const fpToMod = new Map<number, number>();
    for (const m of matches) {
      const fp = typeof m.id === "number" ? m.id : undefined;
      const modId = m.file?.modId;
      if (fp != null && modId != null) fpToMod.set(fp, modId);
    }

    const modIds = [...new Set(fpToMod.values())];
    const modsById = new Map<number, any>();
    if (modIds.length > 0) {
      const modsRes = await request("https://api.curseforge.com/v1/mods", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify({ modIds }),
      });
      if (modsRes.statusCode < 400) {
        const body = (await modsRes.body.json()) as any;
        for (const m of body?.data ?? []) {
          if (typeof m?.id === "number") modsById.set(m.id, m);
        }
      } else {
        await modsRes.body.dump().catch(() => {});
      }
    }

    for (const fp of needFetch) {
      const modId = fpToMod.get(fp);
      if (modId == null) {
        cfFpCache.set(fp, { at: now, meta: null });
        continue;
      }
      const m = modsById.get(modId);
      const meta: CfProjectMeta = {
        modId,
        slug: m?.slug,
        title: (m?.name as string) ?? `CurseForge mod ${modId}`,
        summary: m?.summary as string | undefined,
        icon: (m?.logo?.url as string | undefined) ?? null,
        pageUrl:
          (m?.links?.websiteUrl as string | undefined) ??
          (m?.slug
            ? `https://www.curseforge.com/minecraft/mc-mods/${m.slug}`
            : undefined),
      };
      cfFpCache.set(fp, { at: now, meta });
      out[fp] = meta;
    }
    return out;
  } catch (err) {
    log?.warn({ err }, "curseforge fingerprint lookup failed");
    return out;
  }
}

/**
 * CurseForge's file fingerprint: Murmur2 (seed = 1) over the jar bytes
 * with all whitespace characters stripped (tab, LF, CR, space). We stream
 * the file to keep memory bounded even for 50MB packs.
 */
async function cfMurmur2(file: string): Promise<number> {
  const filtered = await readFilteredJar(file);
  return murmur2(filtered, 1);
}

function readFilteredJar(file: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const s = createReadStream(file);
    s.on("data", (raw: Buffer | string) => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      const out = Buffer.allocUnsafe(chunk.length);
      let j = 0;
      for (let i = 0; i < chunk.length; i++) {
        const b = chunk[i]!;
        if (b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x20) {
          out[j++] = b;
        }
      }
      if (j > 0) {
        chunks.push(out.subarray(0, j));
        total += j;
      }
    });
    s.on("error", reject);
    s.on("end", () => resolve(Buffer.concat(chunks, total)));
  });
}

/**
 * Murmur2 32-bit hash, matching the canonical Java implementation that
 * CurseForge uses for file fingerprints. Uses Math.imul for 32-bit
 * multiplication and forces uint32 with `>>> 0` at every step.
 */
function murmur2(data: Buffer, seed: number): number {
  const m = 0x5bd1e995;
  const r = 24;
  let len = data.length;
  let h = (seed ^ len) >>> 0;
  let i = 0;
  while (len >= 4) {
    let k =
      data[i]! |
      (data[i + 1]! << 8) |
      (data[i + 2]! << 16) |
      (data[i + 3]! << 24);
    k = Math.imul(k, m) >>> 0;
    k = (k ^ (k >>> r)) >>> 0;
    k = Math.imul(k, m) >>> 0;
    h = Math.imul(h, m) >>> 0;
    h = (h ^ k) >>> 0;
    i += 4;
    len -= 4;
  }
  if (len >= 3) h = (h ^ (data[i + 2]! << 16)) >>> 0;
  if (len >= 2) h = (h ^ (data[i + 1]! << 8)) >>> 0;
  if (len >= 1) {
    h = (h ^ data[i]!) >>> 0;
    h = Math.imul(h, m) >>> 0;
  }
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, m) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h >>> 0;
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
  // Filename can contain spaces (e.g. "DnT-ocean-replacement-v1.2 [NeoForge].jar")
  // so we anchor on the extension, not on \S+. The `@ ` separator plus the
  // first `:` after the mod name (which never contains a colon in itzg's
  // output) is enough structure to pull out the pieces reliably.
  const re =
    /Retry #(\d+) download of (.+?\.(?:jar|zip)) @ ([^:\n]+):[^\n]*?HTTP request of (\S+)[^\n]*?403 Forbidden/g;
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

type InstallInterrupt = {
  /** "timeout" for netty ReadTimeoutException, "exhausted" for reactor
   *  RetryExhaustedException, "generic" for the catch-all init log line. */
  kind: "timeout" | "exhausted" | "generic" | "blocked";
  /** One-liner safe to show in UI. */
  message: string;
};

/**
 * Detect a CurseForge-install interrupt in the container logs. These are
 * distinct from per-mod 403s: the whole modpack install died mid-way
 * (usually a network hiccup to CF), and simply pressing Start again
 * resumes because already-downloaded jars are preserved on disk.
 */
/**
 * Detect the actual loader + MC version a server is running, using
 * the files itzg (or a vanilla install) deposits in /data. This is
 * authoritative — mod jar filenames are not (some mods don't put the
 * loader in the name; some put both in a "neoforge-fabric" composite
 * filename without actually supporting both).
 *
 * Sources we consult, in order of trustworthiness:
 *
 *   1. /data/libraries/net/neoforged/neoforge/X.Y.Z/  — installed by
 *      the NeoForge installer itzg runs. The version dir name maps
 *      directly to MC (NeoForge `21.1.234` ↔ MC `1.21.1`).
 *   2. /data/libraries/net/minecraftforge/forge/MC-FV/  — same idea
 *      for legacy Forge; the dir name embeds MC version.
 *   3. /data/.fabric/server/MCVERSION/                 — Fabric
 *      bootstrap state. The folder name IS the MC release.
 *   4. /data/.quilt/server/MCVERSION/                  — Quilt.
 *   5. /data/{paper,purpur}-MCVERSION-BUILD.jar        — Paper-family
 *      drops a versioned launcher jar straight into /data.
 *   6. Mojang version manifest in the vanilla server jar              ← TODO
 *   7. Last-resort filename heuristic on /data/mods/*.jar — only used
 *      if nothing above matched. False-positive prone but better than
 *      nothing for non-itzg installs.
 *
 * Returns nulls when nothing matched; the panel falls back to its
 * server.type → loader map in that case.
 */
async function detectRuntime(
  base: string,
  modFiles: HashedFile[]
): Promise<{ loader: string | null; mcVersion: string | null }> {
  // 1. NeoForge
  const neo = await readNewestSubdir(
    path.join(base, "libraries/net/neoforged/neoforge")
  );
  if (neo) {
    // NeoForge versioning: "21.1.234" → MC "1.21.1". Strip the patch.
    const m = neo.match(/^(\d+)\.(\d+)\.\d+/);
    if (m) {
      const major = m[1];
      const minor = m[2] === "0" ? "" : `.${m[2]}`;
      return { loader: "neoforge", mcVersion: `1.${major}${minor}` };
    }
    return { loader: "neoforge", mcVersion: null };
  }

  // 2. Forge — folder name is the canonical "MC-FORGEVER" string,
  // e.g. "1.20.1-47.3.0". MC is the part before the dash.
  const forge = await readNewestSubdir(
    path.join(base, "libraries/net/minecraftforge/forge")
  );
  if (forge) {
    const m = forge.match(/^(\d+\.\d+(?:\.\d+)?)-/);
    return { loader: "forge", mcVersion: m?.[1] ?? null };
  }

  // 3. Fabric — Fabric server bootstrap creates one folder per MC
  // release it has installed. We pick the newest if more than one.
  const fabric = await readNewestSubdir(path.join(base, ".fabric/server"));
  if (fabric && /^\d+\.\d+(?:\.\d+)?$/.test(fabric)) {
    return { loader: "fabric", mcVersion: fabric };
  }

  // 4. Quilt — same shape.
  const quilt = await readNewestSubdir(path.join(base, ".quilt/server"));
  if (quilt && /^\d+\.\d+(?:\.\d+)?$/.test(quilt)) {
    return { loader: "quilt", mcVersion: quilt };
  }

  // 5. Paper / Purpur / Mohist — versioned launcher jar at /data root.
  try {
    const entries = await fs.readdir(base);
    for (const name of entries) {
      const m = name.match(
        /^(paper|purpur|mohist)-(\d+\.\d+(?:\.\d+)?)-[\w.+-]+\.jar$/i
      );
      if (m && m[1] && m[2]) {
        return { loader: m[1].toLowerCase(), mcVersion: m[2] };
      }
    }
  } catch {
    /* /data missing or unreadable — drop through. */
  }

  // 6. Heuristic last resort. Same logic the previous version of this
  // function used wholesale; here it only runs when none of the
  // authoritative sources matched (e.g. a manually-uploaded server
  // that doesn't follow itzg's layout).
  if (modFiles.length > 0) {
    return heuristicRuntimeFromFilenames(modFiles);
  }

  return { loader: null, mcVersion: null };
}

/**
 * Read a directory and return the newest (lex-largest, which on
 * version-numbered dirs is also semver-largest for our shapes) child
 * name. Returns null when the directory is missing or empty.
 */
async function readNewestSubdir(dir: string): Promise<string | null> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const names = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    if (names.length === 0) return null;
    names.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    return names[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Filename-based last-resort detection. Same shape as the original
 * heuristic — kept around so non-itzg installs (manual dumps into
 * /data/mods) still get *some* filter, even if the detection is
 * imprecise.
 */
function heuristicRuntimeFromFilenames(
  files: HashedFile[]
): { loader: string | null; mcVersion: string | null } {
  const loaderTags = ["neoforge", "fabric", "quilt", "forge"] as const;
  const loaderHits: Record<string, number> = {};
  const versionHits: Record<string, number> = {};
  for (const f of files) {
    const lower = f.name.toLowerCase();
    for (const tag of loaderTags) {
      if (lower.includes(tag)) {
        loaderHits[tag] = (loaderHits[tag] ?? 0) + 1;
        break;
      }
    }
    const m = lower.match(
      /(?:^|[^0-9.])(1\.(?:1[0-9]|2[0-9])(?:\.\d+)?)(?:[^0-9.]|$)/
    );
    if (m && m[1]) {
      versionHits[m[1]] = (versionHits[m[1]] ?? 0) + 1;
    }
  }
  const topLoader =
    Object.entries(loaderHits).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const topVersion =
    Object.entries(versionHits).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return { loader: topLoader, mcVersion: topVersion };
}

/**
 * True once the MC server has printed its vanilla "Done!" boot marker
 * during the *current* container session. Matches both vanilla/paper and
 * Forge/NeoForge variants that append extra punctuation. Scanning is
 * cheap — a single regex — so we do it on every /install-failures call.
 */
function detectBooted(text: string): boolean {
  return /Done \([0-9]+(?:\.[0-9]+)?s\)!\s*For help/i.test(text);
}

function parseInstallInterrupt(text: string): InstallInterrupt | null {
  if (/io\.netty\.handler\.timeout\.ReadTimeoutException/.test(text)) {
    return {
      kind: "timeout",
      message:
        "CurseForge read timed out while downloading modpack files. Files already on disk are kept — press Start to resume the install.",
    };
  }
  if (/RetryExhaustedException|Retries exhausted/.test(text)) {
    return {
      kind: "exhausted",
      message:
        "CurseForge install gave up after repeated retries. Most files already downloaded — press Start to resume.",
    };
  }
  if (/Failed to auto-install CurseForge modpack/.test(text)) {
    return {
      kind: "generic",
      message:
        "CurseForge modpack install was interrupted. Press Start to resume — already-downloaded files are preserved.",
    };
  }
  // CDN-side 403 storm — usually means the host's IP got region-
  // blocked by CurseForge or Cloudflare. Single 403s happen for
  // individual restricted mods, but THREE OR MORE in the same boot
  // is a strong "egress is blocked, route through the proxy"
  // signal. We emit interrupt early so the watchdog flips proxy on
  // before the install grinds through its full retry budget for
  // every mod (which can take HOURS on big modpacks).
  const blocked = text.match(
    /FailedRequestException[^\n]*\b403\b[^\n]*Forbidden/g
  );
  if (blocked && blocked.length >= 3) {
    return {
      kind: "blocked",
      message:
        "CurseForge is rejecting downloads with 403 Forbidden — looks like an IP-region block. Route the install through the configured proxy and resume.",
    };
  }
  return null;
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

type Logger = {
  warn: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
};

/**
 * Stop a container and *actually* stop it. dockerode's `container.stop`
 * resolves with an error if the container is already stopped — fine —
 * but also if SIGTERM hits a stuck JVM and the daemon's grace period
 * expires without a clean exit. Previously we swallowed that silently,
 * then the next Start would fail with "port is already allocated" because
 * the old container was still holding 25565. Now we verify the state
 * after stop and fall back to kill + wait.
 */
async function stopReliably(container: any, log: Logger): Promise<void> {
  try {
    await container.stop({ t: 20 });
  } catch (err) {
    const msg = String(err);
    // "container already stopped" is the only benign case
    if (!/already stopped|is not running/i.test(msg)) {
      log.warn({ err }, "stop returned an error; will verify state");
    }
  }
  // Confirm. If Docker still reports Running, escalate to kill.
  try {
    const info = await container.inspect();
    if (info.State?.Running) {
      log.warn({}, "container still running after stop; sending SIGKILL");
      await container.kill().catch(() => {});
      await container.wait({ condition: "not-running" }).catch(() => {});
    }
  } catch (err) {
    log.warn({ err }, "inspect after stop failed");
  }
}

/**
 * Start a container, and if Docker rejects with "port is already
 * allocated" because a zombie container (created by us in an earlier
 * deploy / crashed stop) is still bound to the same host port, remove
 * that zombie and retry once. Any non-cofemine container on the same
 * port is left alone — we only clean up our own mess.
 */
async function startWithPortRecovery(
  container: any,
  serverId: string,
  log: Logger
): Promise<void> {
  try {
    await container.start();
    return;
  } catch (err) {
    const msg = String(err);
    if (/already started|already running/i.test(msg)) return;
    if (!/port is already allocated|address already in use/i.test(msg)) {
      throw err;
    }
    log.warn(
      { err },
      "start failed: port busy — searching for zombie containers on same port"
    );
    // Which host ports does *this* container need?
    const info = await container.inspect().catch(() => null);
    const wanted = extractHostPorts(info);
    if (wanted.length === 0) throw err;
    const cleaned = await removeZombiesOnPorts(wanted, serverId, log);
    if (!cleaned) throw err;
    // Retry once now that the ports are free.
    await container.start();
  }
}

/** Pull out "hostPort/proto" pairs from an inspect result's HostConfig. */
function extractHostPorts(info: any): Array<{ port: number; proto: string }> {
  const bindings = info?.HostConfig?.PortBindings as
    | Record<string, Array<{ HostPort?: string }>>
    | undefined;
  if (!bindings) return [];
  const out: Array<{ port: number; proto: string }> = [];
  for (const [key, arr] of Object.entries(bindings)) {
    const [, proto = "tcp"] = key.split("/");
    for (const b of arr ?? []) {
      const port = Number(b?.HostPort);
      if (Number.isFinite(port)) out.push({ port, proto });
    }
  }
  return out;
}

/**
 * Find any cofemine-labelled container currently binding one of the
 * given host ports, remove it, and return true if we cleaned at least
 * one. Containers for the serverId we're trying to start are skipped
 * (the caller's container is the one we want to start, not delete).
 */
async function removeZombiesOnPorts(
  wanted: Array<{ port: number; proto: string }>,
  ownSerID: string,
  log: Logger
): Promise<boolean> {
  let cleaned = false;
  const all = await docker.listContainers({ all: true });
  for (const c of all) {
    const label =
      c.Labels?.[`${config.AGENT_LABEL_PREFIX}.serverId`] ?? undefined;
    if (!label) continue; // not one of ours
    if (label === ownSerID) continue; // our target container, skip
    const portsInUse = (c.Ports ?? [])
      .filter((p) => typeof p.PublicPort === "number")
      .map((p) => ({ port: p.PublicPort as number, proto: p.Type ?? "tcp" }));
    const clash = portsInUse.some((used) =>
      wanted.some((w) => w.port === used.port && w.proto === used.proto)
    );
    if (!clash) continue;
    log.warn(
      { containerId: c.Id, label, portsInUse },
      "removing zombie cofemine container blocking host port"
    );
    try {
      const zombie = docker.getContainer(c.Id);
      await zombie.stop({ t: 5 }).catch(() => {});
      await zombie.remove({ force: true });
      cleaned = true;
    } catch (err) {
      log.warn({ err }, "zombie removal failed");
    }
  }
  return cleaned;
}

type CrashReportSummary = {
  name: string;
  size: number;
  mtime: string;
  kind: "mc" | "jvm";
  time?: string;
  description?: string;
  exception?: string;
  suspectPackages: string[];
};

/**
 * List crash reports from /data/crash-reports/*.txt plus any hs_err_pid*.log
 * files in /data. Each gets a lightweight parsed summary: exception line,
 * description, and a de-duplicated list of mod-like package names pulled
 * from the stack trace (java.* and net.minecraft.* are filtered out so
 * what remains is likely a third-party mod).
 */
async function listCrashReports(base: string): Promise<CrashReportSummary[]> {
  const out: CrashReportSummary[] = [];
  const crashDir = path.join(base, "crash-reports");
  try {
    const entries = await fs.readdir(crashDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".txt")) continue;
      const full = path.join(crashDir, e.name);
      try {
        const [stat, content] = await Promise.all([
          fs.stat(full),
          fs.readFile(full, "utf8"),
        ]);
        const parsed = parseCrashReport(content);
        out.push({
          name: e.name,
          size: stat.size,
          mtime: stat.mtime.toISOString(),
          kind: "mc",
          ...parsed,
        });
      } catch {}
    }
  } catch {}
  try {
    const entries = await fs.readdir(base, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (!/^hs_err_pid\d+\.log$/.test(e.name)) continue;
      const full = path.join(base, e.name);
      try {
        const [stat, content] = await Promise.all([
          fs.stat(full),
          fs.readFile(full, "utf8"),
        ]);
        const parsed = parseCrashReport(content);
        out.push({
          name: e.name,
          size: stat.size,
          mtime: stat.mtime.toISOString(),
          kind: "jvm",
          ...parsed,
        });
      } catch {}
    }
  } catch {}
  return out.sort((a, b) => b.mtime.localeCompare(a.mtime));
}

/** Safely resolve a crash-report name to its absolute path (both the
 *  crash-reports dir and the /data root for hs_err_* logs). */
function resolveCrashReport(base: string, name: string): string | null {
  if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) {
    return null;
  }
  if (/^hs_err_pid\d+\.log$/.test(name)) {
    return path.join(base, name);
  }
  if (name.endsWith(".txt")) {
    return path.join(base, "crash-reports", name);
  }
  return null;
}

/**
 * Extract the useful bits from a Forge / Minecraft crash report (or a JVM
 * hs_err log). We look for:
 *  - "Time: ..."
 *  - "Description: ..."
 *  - the first exception line ("Caused by: ..." wins; otherwise the first
 *    "... Exception: ..." we find)
 *  - mod-ish packages from the stack — anything matching at(pkg.Class) that
 *    isn't Minecraft/Java/standard-library is a likely suspect.
 */
function parseCrashReport(content: string): {
  time?: string;
  description?: string;
  exception?: string;
  suspectPackages: string[];
} {
  const time = content.match(/^\s*Time:\s*(.+)$/m)?.[1]?.trim();
  const description = content
    .match(/^\s*Description:\s*(.+)$/m)?.[1]
    ?.trim();

  // Prefer the last "Caused by:" — that's the real root of a stack trace.
  const causedByAll = [
    ...content.matchAll(/^Caused by:\s*([^\r\n]+)$/gm),
  ].map((m) => m[1]?.trim() ?? "");
  let exception: string | undefined = causedByAll.at(-1);
  if (!exception) {
    exception = content
      .match(/^[^\r\n]*?(?:[A-Z][a-zA-Z]*(?:Exception|Error))[^\r\n]*$/m)?.[0]
      ?.trim();
  }

  const packages = new Set<string>();
  const stackRe = /at\s+([a-zA-Z_][\w]*(?:\.[a-zA-Z_][\w$]*)+)\s*\(/g;
  for (const m of content.matchAll(stackRe)) {
    const fq = m[1] ?? "";
    const top = fq.split(".").slice(0, 2).join(".");
    if (!top) continue;
    if (isBoringPackage(top)) continue;
    packages.add(top);
    if (packages.size >= 20) break;
  }

  return {
    time,
    description,
    exception,
    suspectPackages: [...packages],
  };
}

/** Return true for packages that aren't mods — we want to filter these
 *  out of the suspect list so what's left is something worth blaming. */
function isBoringPackage(top: string): boolean {
  const lower = top.toLowerCase();
  const boringPrefixes = [
    "java.",
    "javax.",
    "jdk.",
    "sun.",
    "com.sun.",
    "net.minecraft.",
    "net.minecraftforge.",
    "net.neoforged.",
    "com.mojang.",
    "cpw.mods.",
    "org.apache.",
    "org.slf4j.",
    "org.objectweb.",
    "org.bukkit.",
    "org.spongepowered.",
    "io.netty.",
    "com.google.",
    "com.electronwill.",
    "com.mohistmc.",
    "net.fabricmc.",
    "net.fabricmc.loader.",
    "org.quiltmc.",
    "io.papermc.",
    "kotlin.",
    "scala.",
  ];
  for (const p of boringPrefixes) {
    if (lower === p.slice(0, -1) || lower.startsWith(p)) return true;
  }
  return false;
}

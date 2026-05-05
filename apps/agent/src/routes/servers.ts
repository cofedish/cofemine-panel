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

  /**
   * Reinstall a Minecraft modloader directly via its official
   * installer jar, bypassing itzg / mc-image-helper completely.
   *
   * Why this exists as its own endpoint: the panel needs a way to
   * change a CURSEFORGE-pack server's loader version (e.g. NeoForge
   * 21.1.218 → 21.1.228) WITHOUT setting CF_FORCE_SYNCHRONIZE, which
   * would re-download the entire pack and wipe out any mods the user
   * added on top of the pack baseline. This endpoint runs the
   * NeoForge / Forge / Fabric / Quilt installer in a one-shot Java
   * container that bind-mounts /data:/data, so it regenerates run.sh
   * and libraries/net/<loader>/ but never touches /data/mods,
   * /data/world, /data/config, or anything else.
   *
   * Pre-requirement: the server must be stopped. We don't auto-stop
   * because writing to libraries/ while the JVM is mapping those
   * jars would corrupt the running server's classloader. Caller is
   * expected to have stopped the server first.
   */
  app.post("/servers/:id/install-modloader", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        loader: z.enum(["neoforge", "forge", "fabric", "quilt"]),
        version: z.string().min(1).max(64),
        // mcVersion is required for Forge / Fabric / Quilt URL shapes;
        // for NeoForge the version itself encodes MC compatibility.
        mcVersion: z.string().min(1).max(32).nullable().optional(),
        // Optional outbound proxy. Forwarded by panel-api when a
        // download-proxy is configured under Integrations. Agent uses
        // it both for the installer-jar fetch (undici ProxyAgent) AND
        // injects HTTP_PROXY/HTTPS_PROXY into the temp container env
        // so the loader's own dependency-resolution downloads also
        // tunnel through. ETIMEDOUT on maven.neoforged.net direct is
        // why this exists.
        proxyUrl: z.string().url().nullable().optional(),
      })
      .parse(req.body);

    const dataDir = dataDirFor(id);
    await ensureDir(dataDir);
    req.log.info(
      { id, loader: body.loader, version: body.version, dataDir },
      "install-modloader: start"
    );

    // Refuse if container is currently running. itzg locks libraries/
    // jars open while the JVM is up, and the installer would either
    // fail to overwrite them or — worse — leave a half-rewritten tree.
    const container = await findContainer(id);
    if (container) {
      const info = await container.inspect().catch(() => null);
      if (info?.State?.Running) {
        return reply
          .code(409)
          .send({ error: "Stop the server before changing the loader version" });
      }
    }

    // Wipe stale loader artifacts the installer would regenerate.
    // run.sh in particular hardcodes the old version on the JVM
    // command line — without removing it, even a fresh installer run
    // can be ignored by itzg's start path. We log per-path success
    // so a wipe failure (e.g. a root-owned file from a previous
    // installer crash) shows up in the agent log instead of being
    // silently ignored.
    const stalePaths = staleLoaderPaths(body.loader);
    const wipeResults: Array<{ path: string; existed: boolean; ok: boolean }> = [];
    for (const p of stalePaths) {
      const full = path.join(dataDir, p);
      const existed = await fs
        .access(full)
        .then(() => true)
        .catch(() => false);
      try {
        await fs.rm(full, { recursive: true, force: true });
        wipeResults.push({ path: p, existed, ok: true });
      } catch (err) {
        req.log.warn({ err, path: full }, "stale loader path wipe failed");
        wipeResults.push({ path: p, existed, ok: false });
      }
    }
    // Glob-wipe cached installer jars at /data root that
    // mc-image-helper will otherwise re-run on next boot to "fix"
    // the loader back to the pack-shipped version.
    await wipeRootInstallerJars(dataDir, body.loader, req.log);
    req.log.info(
      { wipeResults },
      "install-modloader: wipe phase complete"
    );

    // Download the installer jar into a hidden file at /data root so
    // the bind-mounted temp container can see it via /data/.
    const installerName = `.cofemine-${body.loader}-installer-${body.version}.jar`;
    const installerPath = path.join(dataDir, installerName);
    const url = installerUrl(
      body.loader,
      body.version,
      body.mcVersion ?? null
    );
    req.log.info(
      { url, installerPath, proxyUrl: body.proxyUrl ?? null },
      "install-modloader: downloading installer jar"
    );
    try {
      await downloadInstallerJar(url, installerPath, body.proxyUrl ?? null);
      // Patch version.json so mc-image-helper 1.56+ doesn't choke on
      // the new "neoforge-X.Y.Z" id format. Safe no-op if already 3-
      // segment or if the file's missing the inheritsFrom hint.
      if (body.loader === "neoforge" || body.loader === "forge") {
        await patchInstallerVersionJson(installerPath, body.loader).catch(
          (err) => {
            req.log.warn(
              { err },
              "version.json patch failed — itzg may complain on parse"
            );
          }
        );
      }
      const stat = await fs.stat(installerPath);
      req.log.info(
        { installerPath, size: stat.size },
        "install-modloader: installer downloaded"
      );
    } catch (err) {
      return reply.code(502).send({
        error: `Failed to download installer: ${(err as Error).message}`,
        url,
      });
    }

    // Pull a small Java image once (cached locally after first use).
    // We don't reuse the itzg image because its entrypoint runs the
    // server bootstrap; overriding entrypoint works but keeping the
    // installer-runner image dedicated is cleaner.
    const tempImage = "eclipse-temurin:21-jre-alpine";
    await ensureImagePulled(docker, tempImage, (m) =>
      req.log.info({ image: tempImage }, m)
    );

    const cmd = installerCmd(
      body.loader,
      body.version,
      body.mcVersion ?? null,
      installerName
    );
    // Inject proxy settings into the temp container so the loader's
    // internal dependency fetches (NeoForge installer pulls a tree
    // of libraries from multiple mavens via java.net.HttpURLConnection)
    // also go through the configured tunnel.
    //
    // Why both env AND JVM properties: Java's built-in HttpURLConnection
    // ignores HTTP_PROXY env vars completely — it only reads JVM
    // system properties (-Dhttp.proxyHost / -Dhttp.proxyPort etc.).
    // We pass those via JAVA_TOOL_OPTIONS, which the JVM reads at
    // startup. The HTTP_PROXY env vars are still useful as a belt
    // for any non-Java tool the installer might shell out to.
    const containerEnv: string[] = ["TERM=dumb"];
    if (body.proxyUrl) {
      // The JVM's proxy properties differ between protocols:
      //   - HTTP/HTTPS proxy → -Dhttp.proxyHost / -Dhttps.proxyHost
      //   - SOCKS5         → -DsocksProxyHost / -DsocksProxyPort
      // Mixing them up means the installer's URLConnection silently
      // ignores the property and goes direct, which is what the user
      // hit on the SOCKS-only port 10808.
      const isSocks = body.proxyUrl.startsWith("socks");
      let host = "";
      let port = "";
      try {
        const u = new URL(body.proxyUrl);
        host = u.hostname;
        port = u.port || (isSocks ? "1080" : "80");
      } catch {
        /* malformed — skip JVM props, the env-based fallback may still help */
      }
      const javaToolOptions = host
        ? (isSocks
            ? [
                `-DsocksProxyHost=${host}`,
                `-DsocksProxyPort=${port}`,
                "-DsocksNonProxyHosts=localhost|127.0.0.1|host.docker.internal|*.ru",
              ]
            : [
                `-Dhttp.proxyHost=${host}`,
                `-Dhttp.proxyPort=${port}`,
                `-Dhttps.proxyHost=${host}`,
                `-Dhttps.proxyPort=${port}`,
                "-Dhttp.nonProxyHosts=localhost|127.0.0.1|host.docker.internal|*.ru",
              ]
          ).join(" ")
        : "";
      // ALL_PROXY honours SOCKS in tools that look at it (curl, etc.);
      // HTTP_PROXY only on HTTP-CONNECT proxies. Set both so non-Java
      // shell-outs the installer might do also tunnel correctly.
      if (isSocks) {
        containerEnv.push(
          `ALL_PROXY=${body.proxyUrl}`,
          `all_proxy=${body.proxyUrl}`
        );
      } else {
        containerEnv.push(
          `HTTP_PROXY=${body.proxyUrl}`,
          `HTTPS_PROXY=${body.proxyUrl}`,
          `http_proxy=${body.proxyUrl}`,
          `https_proxy=${body.proxyUrl}`
        );
      }
      containerEnv.push(
        "NO_PROXY=localhost,127.0.0.1,::1,host.docker.internal,*.ru,172.16.0.0/12,10.0.0.0/8,192.168.0.0/16",
        "no_proxy=localhost,127.0.0.1,::1,host.docker.internal,*.ru,172.16.0.0/12,10.0.0.0/8,192.168.0.0/16"
      );
      if (javaToolOptions) {
        containerEnv.push(`JAVA_TOOL_OPTIONS=${javaToolOptions}`);
      }
    }
    const temp = await docker.createContainer({
      Image: tempImage,
      Cmd: cmd,
      WorkingDir: "/data",
      Env: containerEnv,
      HostConfig: {
        Binds: [`${dataDir}:/data`],
        AutoRemove: false,
        NetworkMode: config.AGENT_DOCKER_NETWORK,
        // host.docker.internal mapping is needed when the proxy URL
        // points at a host-side service (xray on the host's port 2080).
        // Without this the temp container can't resolve it.
        ExtraHosts: ["host.docker.internal:host-gateway"],
      },
      Tty: false,
    });

    req.log.info(
      { tempImage, cmd, env: containerEnv },
      "install-modloader: starting installer container"
    );
    let logsStr = "";
    let exitCode = -1;
    try {
      await temp.start();
      const result = await temp.wait();
      exitCode = result.StatusCode ?? -1;
      req.log.info(
        { exitCode },
        "install-modloader: installer container exited"
      );
      const logs = await temp.logs({
        stdout: true,
        stderr: true,
        follow: false,
      });
      logsStr = logs
        .toString("utf8")
        // Docker emits framed bytes (8-byte header per stdout/stderr
        // chunk). Strip non-printable control chars except tab / LF /
        // CR so the tail we surface to the UI is readable.
        // eslint-disable-next-line no-control-regex
        .replace(/[ --]/g, "");
    } catch (err) {
      req.log.warn({ err }, "modloader installer container failed");
      await temp.remove({ force: true }).catch(() => {});
      await fs.unlink(installerPath).catch(() => {});
      return reply.code(500).send({
        error: `Installer container failed: ${(err as Error).message}`,
      });
    }

    await temp.remove({ force: true }).catch(() => {});
    // KEEP the installer jar on disk. itzg's start-deployNeoForge
    // honours NEOFORGE_INSTALLER pointing at a local file —
    // bypassing the maven-metadata.xml fetch which is what fails
    // for users whose proxy can't reach maven.neoforged.net (the
    // user's prod xray hits 404 / ReadTimeout there). On the next
    // boot itzg uses our local jar, no external network call.
    if (exitCode !== 0) {
      req.log.warn({ exitCode, tail: logsStr.slice(-1500) }, "installer non-zero exit");
      return reply.code(500).send({
        error: `Installer exited ${exitCode}`,
        logs: logsStr.slice(-2000),
      });
    }

    // Sanity: confirm the installer wrote run.sh (NeoForge / Forge)
    // or the launcher jar (Fabric / Quilt). If not, something silently
    // went sideways and starting the server would fail anyway.
    const expectMarker = installerOutputMarker(body.loader);
    const markerExists = await fs
      .access(path.join(dataDir, expectMarker))
      .then(() => true)
      .catch(() => false);
    if (!markerExists) {
      return reply.code(500).send({
        error: `Installer claimed success but didn't produce ${expectMarker}`,
        logs: logsStr.slice(-2000),
      });
    }
    req.log.info(
      { marker: expectMarker },
      "install-modloader: marker file present, install validated"
    );

    // Verify the actual version landed where we expect, NOT just that
    // a run.sh exists. With NeoForge / Forge we expect a directory at
    // libraries/<loaderPath>/<version>/ — if instead we see a different
    // version subdir, mc-image-helper / itzg will keep loading the old
    // one and the override silently fails.
    const verifyResult = await verifyInstalledVersion(
      dataDir,
      body.loader,
      body.version,
      req.log
    );

    // The temp container ran as root, so everything it wrote (run.sh,
    // user_jvm_args.txt, the libraries/ subtree) is root-owned. itzg
    // runs the MC server as uid 1000 via gosu and chokes with
    // "Permission denied" on user_jvm_args.txt the moment it tries to
    // append the install proxy to it. chown the affected files +
    // libraries/<loader>/ subtree back to 1000:1000 so itzg owns them.
    await chownInstallerOutput(dataDir, body.loader, req.log);
    req.log.info({ verifyResult }, "install-modloader: complete");
    return {
      ok: true,
      loader: body.loader,
      version: body.version,
      tail: logsStr.slice(-500),
      verify: verifyResult,
    };
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

  // ============================== CLIENT MODS ==============================
  //
  // Per-server "client modpack" — jars the user wants in the .mrpack
  // export but that should NOT be installed on the server (shaders,
  // miniмap mods, Iris/Sodium, Distant Horizons, JEI client extras…).
  // They live at `<dataDir>/.cofemine-client/mods/`. The leading dot
  // hides them from itzg's mod scanner; nothing in itzg's image walks
  // dot-prefixed paths. The .mrpack export bundles every jar from this
  // directory + every jar from /data/mods/ into `overrides/mods/`.

  /** Client-pack staging area kind. Each maps to a subdirectory under
   *  .cofemine-client/ that gets bundled into overrides/<kind>/ when
   *  the .mrpack is exported. */
  const CLIENT_KINDS = ["mods", "shaderpacks", "resourcepacks"] as const;
  type ClientKind = (typeof CLIENT_KINDS)[number];
  function parseClientKind(raw: unknown): ClientKind {
    return CLIENT_KINDS.includes(raw as ClientKind)
      ? (raw as ClientKind)
      : "mods";
  }
  function clientStagingDir(serverId: string, kind: ClientKind): string {
    return path.join(dataDirFor(serverId), ".cofemine-client", kind);
  }

  app.get("/servers/:id/client-mods", async (req) => {
    const { id } = req.params as { id: string };
    const kind = parseClientKind((req.query as { kind?: string }).kind);
    const dir = clientStagingDir(id, kind);
    await ensureDir(dir);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const out: Array<{ name: string; size: number; mtime: string }> = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (!/\.(jar|zip)$/i.test(e.name)) continue;
      const full = path.join(dir, e.name);
      const st = await fs.stat(full);
      out.push({
        name: e.name,
        size: st.size,
        mtime: st.mtime.toISOString(),
      });
    }
    return { mods: out };
  });

  /**
   * Scan mc-image-helper's CF cache and discover client-only mods
   * the pack intentionally excluded from the server install (Iris,
   * Sodium, Mouse Tweaks, Xaero — anything tagged "Client" in CF's
   * gameVersions).
   *
   * Returns the catalog without downloading anything. The Client Pack
   * tab uses this to render a "Pack ships these client-only mods,
   * download them all?" prompt.
   *
   * Source: <dataDir>/.cache/curseforge/getModInfo/*.json. Each file
   * is a CF /mods/<id> response cached by mc-image-helper. We pick
   * the file whose displayName / gameVersions matches "Client" + the
   * pack's MC version + the pack's loader.
   */
  app.get("/servers/:id/client-mods/auto-detect", async (req) => {
    const { id } = req.params as { id: string };
    const cacheDir = path.join(
      dataDirFor(id),
      ".cache",
      "curseforge",
      "getModInfo"
    );
    let entries: string[];
    try {
      entries = await fs.readdir(cacheDir);
    } catch {
      return { detected: [], reason: "no CF cache yet — pack hasn't installed" };
    }
    type Detected = {
      modId: number;
      slug?: string;
      title: string;
      filename: string;
      downloadUrl: string;
      icon?: string | null;
      size?: number;
    };
    const detected: Detected[] = [];
    const clientDir = path.join(dataDirFor(id), ".cofemine-client", "mods");
    let alreadyDownloaded: Set<string> = new Set();
    try {
      const have = await fs.readdir(clientDir);
      alreadyDownloaded = new Set(have);
    } catch {
      /* dir doesn't exist yet — that's fine */
    }
    for (const e of entries) {
      if (!e.endsWith(".json")) continue;
      let mod: any;
      try {
        const raw = await fs.readFile(path.join(cacheDir, e), "utf8");
        mod = JSON.parse(raw);
      } catch {
        continue;
      }
      // Find a "Client"-tagged file in this mod's latest releases.
      // CF marks client-only releases by including the literal string
      // "Client" in the file's gameVersions array.
      const files = (mod.latestFiles ?? []) as any[];
      const clientFile = files.find((f) => {
        const gvs = (f.gameVersions ?? []) as string[];
        return gvs.includes("Client");
      });
      if (!clientFile) continue;
      if (!clientFile.downloadUrl) continue;
      // Skip mods where the user already has the file in client-mods.
      if (alreadyDownloaded.has(clientFile.fileName)) continue;
      detected.push({
        modId: mod.id,
        slug: mod.slug,
        title: mod.name ?? `CF mod #${mod.id}`,
        filename: clientFile.fileName,
        downloadUrl: clientFile.downloadUrl,
        icon: mod.logo?.url ?? null,
        size: clientFile.fileLength,
      });
    }
    return { detected };
  });

  /**
   * Bulk-download a list of client-mod URLs (typically the output of
   * /client-mods/auto-detect) into <dataDir>/.cofemine-client/mods/.
   * Used by the panel UI's "Add all detected client mods" button.
   *
   * Streams each download to disk (no buffering) and reports per-file
   * success / failure so the UI can show partial-failure state.
   */
  app.post("/servers/:id/client-mods/download", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        files: z
          .array(
            z.object({
              filename: z.string().min(1).max(256),
              downloadUrl: z.string().url(),
            })
          )
          .min(1)
          .max(200),
        proxyUrl: z.string().url().nullable().optional(),
      })
      .parse(req.body);
    const dir = path.join(dataDirFor(id), ".cofemine-client", "mods");
    await ensureDir(dir);
    const results: Array<{ filename: string; ok: boolean; error?: string }> = [];
    for (const f of body.files) {
      const dest = path.join(dir, f.filename);
      try {
        await downloadInstallerJar(
          f.downloadUrl,
          dest,
          body.proxyUrl ?? null
        );
        results.push({ filename: f.filename, ok: true });
      } catch (err) {
        results.push({
          filename: f.filename,
          ok: false,
          error: (err as Error).message,
        });
      }
    }
    return reply.send({ results });
  });

  app.post("/servers/:id/client-mods", async (req, reply) => {
    const { id } = req.params as { id: string };
    const kind = parseClientKind((req.query as { kind?: string }).kind);
    const body = z
      .object({
        filename: z.string().min(1).max(256),
        contentBase64: z.string().min(1),
      })
      .parse(req.body);
    // Mods are .jar (or rare .zip-format mods); shaderpacks and
    // resourcepacks are always .zip. Reject mismatched extensions
    // early so the user doesn't end up with a shaderpack uploaded
    // into mods/ silently.
    const allowed =
      kind === "mods" ? /\.(jar|zip)$/i : /\.zip$/i;
    if (!allowed.test(body.filename)) {
      return reply.code(400).send({
        error:
          kind === "mods"
            ? "Only .jar / .zip files allowed for mods"
            : `Only .zip files allowed for ${kind}`,
      });
    }
    if (body.filename.includes("/") || body.filename.includes("\\")) {
      return reply.code(400).send({ error: "Bare filename only" });
    }
    const dir = clientStagingDir(id, kind);
    await ensureDir(dir);
    const buf = Buffer.from(body.contentBase64, "base64");
    if (buf.length > 100 * 1024 * 1024) {
      return reply.code(413).send({ error: "File too large (>100MB)" });
    }
    await fs.writeFile(path.join(dir, body.filename), buf);
    return { ok: true, name: body.filename, size: buf.length };
  });

  app.delete("/servers/:id/client-mods", async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { name?: string; kind?: string };
    if (!q.name) return { ok: true };
    if (q.name.includes("/") || q.name.includes("\\")) {
      return { ok: false };
    }
    const kind = parseClientKind(q.kind);
    const file = path.join(clientStagingDir(id, kind), q.name);
    await fs.rm(file, { force: true });
    return { ok: true };
  });

  /**
   * Wipe an entire client-staging kind (mods / shaderpacks /
   * resourcepacks). Used from the panel UI's "Clear all" button when
   * the user wants to drop a stale collection in one shot — typically
   * when the staging dir filled up with cross-pack/cross-version jars
   * that now conflict with the current server install.
   *
   * Only deletes top-level files (.jar/.zip); won't touch
   * subdirectories or the staging dir itself.
   */
  app.delete("/servers/:id/client-mods/all", async (req) => {
    const { id } = req.params as { id: string };
    const kind = parseClientKind((req.query as { kind?: string }).kind);
    const dir = clientStagingDir(id, kind);
    let removed = 0;
    try {
      const items = await fs.readdir(dir, { withFileTypes: true });
      for (const it of items) {
        if (!it.isFile()) continue;
        if (!/\.(jar|zip)$/i.test(it.name)) continue;
        await fs.rm(path.join(dir, it.name), { force: true });
        removed++;
      }
    } catch {
      /* dir doesn't exist — nothing to clear */
    }
    return { ok: true, removed };
  });

  /**
   * Fix root-owned files in /data left over from earlier root-running
   * installer phases. uid 1000 (itzg's runtime user) needs to be able
   * to overwrite libraries/net/minecraft/.../*.jar etc. on subsequent
   * boots; without this AccessDeniedException stops install-neoforge.
   *
   * Called by panel-API after detach-source so existing prod servers
   * with the wrong ownership can be repaired without a fresh install.
   */
  app.post("/servers/:id/fix-permissions", async (req) => {
    const { id } = req.params as { id: string };
    const dataDir = dataDirFor(id);
    const targets = [
      "libraries",
      "run.sh",
      "run.bat",
      "user_jvm_args.txt",
      "fabric-server-launcher.jar",
      "fabric-server-launch.jar",
      "quilt-server-launcher.jar",
    ];
    let fixed = 0;
    for (const rel of targets) {
      const full = path.join(dataDir, rel);
      try {
        await chownRecursive(full, 1000, 1000);
        fixed++;
      } catch {
        // Path may not exist — fine.
      }
    }
    return { ok: true, fixed };
  });

  /**
   * Download a loader installer.jar to <dataDir>/.cofemine-<loader>-
   * installer-<version>.jar so itzg's NEOFORGE_INSTALLER / FORGE_
   * INSTALLER env can point at a local file. This bypasses the
   * maven-metadata.xml fetch that mc-image-helper does when no
   * local installer is provided — that fetch is what hits
   * ReadTimeout / 404 on user proxies that can't reach the loader's
   * maven directly.
   *
   * Idempotent: if a jar of the right size already exists, no-op.
   */
  app.post("/servers/:id/download-loader-installer", async (req) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        loader: z.enum(["neoforge", "forge", "fabric", "quilt"]),
        version: z.string().min(1).max(64),
        mcVersion: z.string().min(1).max(32).nullable().optional(),
        proxyUrl: z.string().url().nullable().optional(),
      })
      .parse(req.body);
    const dataDir = dataDirFor(id);
    await ensureDir(dataDir);
    const installerName = `.cofemine-${body.loader}-installer-${body.version}.jar`;
    const installerPath = path.join(dataDir, installerName);
    // Already there → don't redownload.
    try {
      const stat = await fs.stat(installerPath);
      if (stat.size > 0) {
        return { ok: true, path: installerPath, cached: true, size: stat.size };
      }
    } catch {
      // File doesn't exist — proceed to download.
    }
    const url = installerUrl(
      body.loader,
      body.version,
      body.mcVersion ?? null
    );
    await downloadInstallerJar(url, installerPath, body.proxyUrl ?? null);
    if (body.loader === "neoforge" || body.loader === "forge") {
      await patchInstallerVersionJson(installerPath, body.loader).catch(
        () => {
          /* logged by caller if itzg later complains */
        }
      );
    }
    await fs.chown(installerPath, 1000, 1000).catch(() => {});
    const stat = await fs.stat(installerPath);
    return {
      ok: true,
      path: installerPath,
      cached: false,
      size: stat.size,
    };
  });

  /**
   * Generate a Modrinth-format pack (.mrpack) from the server's
   * mod state and stream it back as a downloadable ZIP.
   *
   * Strategy: bundle EVERYTHING as overrides. Every jar from
   * `/data/mods/` and `/data/.cofemine-client/mods/` lands in
   * `overrides/mods/`. Configs and resourcepacks ride along under
   * `overrides/<sub>/`. No side-splitting, no allow/deny — the friend
   * gets the same thing the server runs (plus whatever you've staged
   * in the client-only area). HMCL, Modrinth App, Prism all extract
   * `overrides/` so the pack works everywhere.
   */
  app.get("/servers/:id/export-mrpack", async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as {
      packName?: string;
      mcVersion?: string;
      loader?: string;
      loaderVersion?: string;
      proxyUrl?: string;
      includeAutoDetected?: string;
    };
    const base = dataDirFor(id);

    const serverModsDir = path.join(base, "mods");
    const clientModsDir = path.join(base, ".cofemine-client", "mods");

    type Entry = {
      sourcePath: string;
      filename: string;
      origin: "server" | "client";
    };
    const entries: Entry[] = [];

    async function collect(
      dir: string,
      origin: "server" | "client"
    ): Promise<void> {
      let items: string[] = [];
      try {
        items = await fs.readdir(dir);
      } catch {
        return;
      }
      for (const name of items) {
        if (!/\.(jar|zip)$/i.test(name)) continue;
        entries.push({
          sourcePath: path.join(dir, name),
          filename: name,
          origin,
        });
      }
    }
    await collect(serverModsDir, "server");
    await collect(clientModsDir, "client");

    const packName = q.packName ?? `cofemine-${id.slice(0, 8)}`;
    const versionId = new Date().toISOString().slice(0, 10);
    const manifest = {
      formatVersion: 1,
      game: "minecraft",
      versionId,
      name: packName,
      summary: "Exported by Cofemine Panel",
      files: [] as Array<unknown>,
      dependencies: {
        minecraft: q.mcVersion ?? "1.21.1",
        ...(q.loader && q.loaderVersion ? { [q.loader]: q.loaderVersion } : {}),
      },
    };
    /**
     * Friendly, human-readable sibling to modrinth.index.json. Sat at
     * the ZIP root so a user inspecting the pack in a file manager can
     * see at a glance which MC + loader version it was built against.
     * Launchers ignore this file (they only look at modrinth.index.json),
     * so it's safe to add.
     */
    const friendlyManifest = {
      versionName: packName,
      minecraft: q.mcVersion ?? "1.21.1",
      loader: q.loader ?? null,
      loaderVersion: q.loaderVersion ?? null,
      builtAt: new Date().toISOString(),
      builtBy: "Cofemine Panel",
    };

    // Set headers BEFORE the archive starts streaming.
    const safeName = (q.packName ?? `cofemine-${id.slice(0, 8)}`).replace(
      /[^a-zA-Z0-9._-]+/g,
      "-"
    );
    reply.header("content-type", "application/zip");
    reply.header(
      "content-disposition",
      `attachment; filename="${safeName}.mrpack"`
    );
    // We can't precompute content-length without buffering everything;
    // omit it and rely on chunked transfer.

    const { default: archiver } = await import("archiver");
    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.on("warning", (err) => {
      req.log.warn({ err }, "mrpack archiver warning");
    });
    archive.on("error", (err) => {
      req.log.error({ err }, "mrpack archiver error");
      reply.raw.destroy(err);
    });

    // Pipe archive bytes straight into the HTTP response.
    archive.pipe(reply.raw);

    // Bundle every jar into overrides/mods/. No deduping, no filtering,
    // no side-skipping — what's on disk in /data/mods/ and in the
    // user's client-staging area is what ends up in the pack. The
    // panel is a transparent shipper, not a curator.
    for (const e of entries) {
      archive.file(e.sourcePath, {
        name: `overrides/mods/${e.filename}`,
      });
    }

    // Auto-detect: pull every client-only mod from mc-image-helper's
    // CF cache and stream it straight into overrides/mods/. This is
    // how Iris / Sodium / Xaero / Mouse Tweaks etc. — mods the pack
    // ships but that itzg deliberately skips on server install — get
    // back into the client pack.
    //
    // No loader / MC filter: if the file is tagged "Client" in CF's
    // gameVersions it goes in. Fabric mods on a NeoForge server are
    // valid via Sinytra Connector; "fixing" them would silently strip
    // legitimate parts of the pack. The agent is a dumb shipper.
    const includeAutoDetected =
      (q.includeAutoDetected ?? "1") !== "0";
    if (includeAutoDetected) {
      const cacheDir = path.join(base, ".cache", "curseforge", "getModInfo");
      let cacheEntries: string[] = [];
      try {
        cacheEntries = await fs.readdir(cacheDir);
      } catch {
        /* no cache → nothing to add */
      }
      const fetchTasks: Array<{ filename: string; downloadUrl: string }> = [];
      for (const ce of cacheEntries) {
        if (!ce.endsWith(".json")) continue;
        let mod: any;
        try {
          mod = JSON.parse(await fs.readFile(path.join(cacheDir, ce), "utf8"));
        } catch {
          continue;
        }
        const files = (mod.latestFiles ?? []) as any[];
        const clientFile = files.find((f) => {
          const gvs = (f.gameVersions ?? []) as string[];
          return gvs.includes("Client");
        });
        if (!clientFile?.downloadUrl) continue;
        fetchTasks.push({
          filename: clientFile.fileName,
          downloadUrl: clientFile.downloadUrl,
        });
      }
      if (fetchTasks.length > 0) {
        req.log.info(
          { count: fetchTasks.length },
          "mrpack export: streaming auto-detected client mods"
        );
        for (const t of fetchTasks) {
          try {
            const stream = await openHttpStream(
              t.downloadUrl,
              q.proxyUrl ?? null
            );
            archive.append(stream as any, {
              name: `overrides/mods/${t.filename}`,
            });
          } catch (err) {
            req.log.warn(
              { err, filename: t.filename },
              "mrpack export: skipping mod, fetch failed"
            );
          }
        }
      }
    }

    // Bundle config + resourcepacks under overrides/. These apply to
    // both client and server when the launcher installs the pack —
    // which matches how a real CurseForge / Modrinth pack ships them.
    // Wrapped in try/catch per-dir so a missing directory just skips
    // (a freshly-installed server has no /data/config until first boot).
    async function dirExists(p: string): Promise<boolean> {
      try {
        const st = await fs.stat(p);
        return st.isDirectory();
      } catch {
        return false;
      }
    }
    const includedDirs: string[] = [];

    // Server-side dirs — pulled from /data/<sub>/. These are populated
    // by the server (configs generated, kubejs scripts authored, etc.)
    // and there's no client-side equivalent worth shipping.
    for (const sub of [
      "config",
      "kubejs",
      "defaultconfigs",
      "scripts",
      "openloader",
    ]) {
      const src = path.join(base, sub);
      if (await dirExists(src)) {
        archive.directory(src, `overrides/${sub}`);
        includedDirs.push(`server/${sub}`);
      }
    }

    // Client-leaning dirs — shaderpacks/resourcepacks are pure-client
    // content, the server doesn't render them. Prefer client-staging
    // (.cofemine-client/<sub>/) since that's where the panel UI lets
    // owners drop these. Fall back to /data/<sub>/ if someone dumped
    // files there directly (Files tab / SFTP).
    for (const sub of ["shaderpacks", "resourcepacks"]) {
      const clientSrc = path.join(base, ".cofemine-client", sub);
      const serverSrc = path.join(base, sub);
      if (await dirExists(clientSrc)) {
        archive.directory(clientSrc, `overrides/${sub}`);
        includedDirs.push(`client/${sub}`);
      } else if (await dirExists(serverSrc)) {
        archive.directory(serverSrc, `overrides/${sub}`);
        includedDirs.push(`server/${sub}`);
      }
    }
    req.log.info(
      {
        serverMods: entries.filter((e) => e.origin === "server").length,
        clientMods: entries.filter((e) => e.origin === "client").length,
        bundledTotal: entries.length,
        includedDirs,
      },
      "mrpack export: assembled"
    );

    // Modrinth's spec manifest (launchers parse this).
    archive.append(JSON.stringify(manifest, null, 2), {
      name: "modrinth.index.json",
    });
    // Friendly sibling for humans.
    archive.append(JSON.stringify(friendlyManifest, null, 2), {
      name: "manifest.json",
    });

    await archive.finalize();
    // archiver.pipe(reply.raw) ends the stream itself; no further
    // reply.send needed. Returning here just satisfies fastify.
    return reply;
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
      // Try every candidate (camelCase-split + plain). Modrinth's
      // slug for "ArmorPoser-...jar" is "armor-poser"; the plain
      // "armorposer" returns 404. Without splitting we miss every
      // PascalCase mod name's icon / metadata.
      for (const c of slugCandidatesFromFilename(f.name)) {
        unresolvedSlugs.add(c);
      }
    }
    const projectsBySlug = await modrinthLookupBySlug(
      [...unresolvedSlugs],
      req.log
    );

    // CurseForge fingerprint lookup. Compute CF's custom Murmur2 hash
    // for each jar (whitespace-stripped, seed=1) and ask the CF API
    // to map them to mod IDs + icon URLs. Gated on x-cf-api-key —
    // we don't churn a key the operator hasn't configured.
    //
    // Two modes:
    //   - default ("missing"): only run CF lookup for files that
    //     didn't resolve via Modrinth. Saves API calls for plain
    //     Modrinth servers.
    //   - x-cf-resolve-all=1: run CF lookup for EVERY jar regardless
    //     of Modrinth resolution. Used for CURSEFORGE modpack servers,
    //     where we need the CF modId on every mod so the Content tab's
    //     "Exclude from pack" (Ban) button can submit a numeric ID to
    //     CF_EXCLUDE_MODS — without this, popular mods like Waystones
    //     resolve via Modrinth, get no CF modId, and the Ban button
    //     stays hidden, so the user can't blacklist them from the pack.
    const cfApiKey = (req.headers["x-cf-api-key"] as string | undefined) ?? "";
    const cfResolveAll =
      String(req.headers["x-cf-resolve-all"] ?? "") === "1";
    const cfByName: Record<string, CfProjectMeta> = {};
    if (cfApiKey) {
      const candidates: Array<{ subdir: string; file: HashedFile }> = [];
      const groups: Array<{ subdir: string; files: HashedFile[] }> = [
        { subdir: "mods", files: mods },
        { subdir: "plugins", files: plugins },
        { subdir: "world/datapacks", files: datapacks },
      ];
      for (const g of groups) {
        for (const f of g.files) {
          if (!cfResolveAll) {
            const resolvedByHash = f.sha1 ? versions[f.sha1] : undefined;
            if (resolvedByHash) continue;
            const slug = slugFromFilename(f.name);
            if (slug && projectsBySlug[slug]) continue;
          }
          candidates.push({ subdir: g.subdir, file: f });
        }
      }
      if (candidates.length > 0) {
        const fpPairs = await Promise.all(
          candidates.map(async ({ subdir, file }) => {
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
        // Slug fallback for everything fingerprinting missed. Modpack
        // authors often recompress jars (different Murmur2 hash, same
        // filename / slug), and that's the case where Waystones et al.
        // get rendered without a CF modId — meaning the user can't add
        // them to CF_EXCLUDE_MODS. The slug guesser is best-effort but
        // catches all the popular packs.
        const stillMissing = candidates.filter(
          ({ file }) => !cfByName[file.name]
        );
        if (stillMissing.length > 0) {
          // Map each filename to the FIRST candidate slug; collect
          // the union of all candidates to query CF in one pass,
          // then walk back to which file each hit belongs to.
          const candidatesByFile = new Map<string, string[]>();
          const allSlugs = new Set<string>();
          for (const { file } of stillMissing) {
            const cands = slugCandidatesFromFilename(file.name);
            if (cands.length === 0) continue;
            candidatesByFile.set(file.name, cands);
            for (const c of cands) allSlugs.add(c);
          }
          if (allSlugs.size > 0) {
            const slugHits = await curseforgeSlugLookup(
              [...allSlugs],
              cfApiKey,
              req.log
            );
            for (const [filename, cands] of candidatesByFile) {
              for (const c of cands) {
                if (slugHits[c]) {
                  cfByName[filename] = slugHits[c];
                  break;
                }
              }
            }
          }
          // Search-by-name fallback for compound words that the
          // camelCase splitter can't decompose (kotlinforforge →
          // kotlin-for-forge, voicechat → simple-voice-chat). CF's
          // search endpoint takes a free-text query and returns
          // top matches by relevance; we use the first candidate
          // (lowercase) as the query and accept the top result.
          // One CF search call per still-unresolved mod, which is
          // fine — typical pack has < 10 such jars.
          for (const { file } of stillMissing) {
            if (cfByName[file.name]) continue;
            const cands = slugCandidatesFromFilename(file.name);
            if (cands.length === 0) continue;
            const query = cands[cands.length - 1]!; // bare lowercase
            const hit = await curseforgeSearchByName(
              query,
              cfApiKey,
              req.log
            );
            if (hit) cfByName[file.name] = hit;
          }
        }
      }
    }

    const enrich = (f: HashedFile): EnrichedFile => {
      const v = f.sha1 ? versions[f.sha1] : undefined;
      const p = v?.project_id ? projects[v.project_id] : undefined;
      // CF metadata is attached alongside Modrinth's, not instead of:
      // when the server is a CurseForge modpack we always look up the
      // CF modId so the UI's exclude-from-pack button has something
      // to submit, even for mods that ALSO live on Modrinth (Waystones,
      // JEI, Create — basically every popular mod).
      const cf = cfByName[f.name];
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
            // Used by the panel UI's "effective MC version" majority
            // vote when a server stored version="LATEST" — we filter
            // to "1.X[.Y]" entries so the helper finds the pack's
            // actual MC instead of falling back to Mojang's latest.
            gameVersions: Array.isArray(v?.game_versions)
              ? (v?.game_versions as string[])
              : [],
            pageUrl: `https://modrinth.com/${p.project_type ?? "mod"}/${p.slug}`,
          },
          ...(cf ? { curseforge: cf } : {}),
        };
      }
      // Walk every candidate, take the first one Modrinth knew about.
      let sp: any = undefined;
      for (const c of slugCandidatesFromFilename(f.name)) {
        if (projectsBySlug[c]) {
          sp = projectsBySlug[c];
          break;
        }
      }
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
          ...(cf ? { curseforge: cf } : {}),
        };
      }
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
    gameVersions?: string[];
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
  // Backwards-compat: keep returning a single string. Most callers
  // only care about the primary candidate; the broader lookup paths
  // (Modrinth + CF slug fallback) use slugCandidatesFromFilename
  // below to try all variants.
  return slugCandidatesFromFilename(name)[0] ?? "";
}

/**
 * Generate every plausible slug candidate from a mod jar filename.
 * Returned in priority order — caller looks up each in turn until
 * one matches a project. Examples:
 *   "ArmorPoser-neoforge-1.21.1-6.2.2.jar"
 *     → ["armor-poser", "armorposer"]
 *   "create-1.21.1-6.0.6.jar"
 *     → ["create"]
 *   "iron-spells-n-spellbooks-neoforge-1.21.1-2.0.0.jar"
 *     → ["iron-spells-n-spellbooks", "ironspellsnspellbooks"]
 *
 * The camelCase split matters because Modrinth / CF slugs are
 * canonical "armor-poser" while modpack jar filenames often use
 * the PascalCase "ArmorPoser" — the unsplit form misses both
 * registries and the mod card has no icon / metadata at all.
 */
function slugCandidatesFromFilename(name: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  function push(s: string): void {
    const trimmed = s.replace(/-+$/, "").replace(/^-+/, "");
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  const stripped = name.replace(/\.(jar|zip)$/i, "");
  // Split point: where a version / loader marker starts. Capture the
  // raw original-case prefix so we can split camelCase boundaries
  // before lowercasing.
  const splitRe = /(?:-_)?(?:\d|v\d|mc\d|neo[a-z]*|forge|fabric|quilt)/i;
  const m = stripped.split(splitRe)[0] ?? stripped;
  const baseRaw = m.replace(/[_\s]+/g, "-").replace(/-+$/, "");
  // Candidate 1: split at camelCase / PascalCase boundaries.
  const split = baseRaw
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
  push(split);
  // Candidate 2: bare lowercase, no extra hyphens. This is what the
  // old behaviour returned and still works for already-hyphenated
  // names like "iron-spells-n-spellbooks".
  push(baseRaw.toLowerCase());
  return out;
}

// CurseForge fingerprint cache — keyed by Murmur2 hash. CF doesn't
// rename files once published, so the mapping hash → modId is stable
// forever; a longer TTL here saves API calls when the install list
// barely changes between polls.
const cfFpCache = new Map<number, { at: number; meta: CfProjectMeta | null }>();
const CF_FP_TTL_MS = 60 * 60 * 1000; // 1 hour

// Slug → CF metadata cache. Slugs (canonical) are immutable once a CF
// project is published, so 1h TTL is fine — same reasoning as fingerprints.
const cfSlugCache = new Map<string, { at: number; meta: CfProjectMeta | null }>();

/**
 * Last-resort: CF search by free-text query. Used when neither the
 * Murmur2 fingerprint nor any of the slug candidates matched. The
 * search endpoint ranks by relevance, so for compound names like
 * "kotlinforforge" the top hit is usually the canonical project
 * even though the slug doesn't match character-for-character.
 *
 * Cached per-query alongside the slug cache.
 */
async function curseforgeSearchByName(
  query: string,
  apiKey: string,
  log?: { warn: (obj: unknown, msg?: string) => void }
): Promise<CfProjectMeta | null> {
  if (!query || query.length < 3) return null;
  const cacheKey = `search:${query}`;
  const now = Date.now();
  const cached = cfSlugCache.get(cacheKey);
  if (cached && now - cached.at < CF_FP_TTL_MS) return cached.meta;
  try {
    const url = `https://api.curseforge.com/v1/mods/search?gameId=432&searchFilter=${encodeURIComponent(
      query
    )}&pageSize=1`;
    const res = await request(url, {
      method: "GET",
      headers: { "x-api-key": apiKey, accept: "application/json" },
    });
    if (res.statusCode >= 400) {
      await res.body.dump().catch(() => {});
      cfSlugCache.set(cacheKey, { at: now, meta: null });
      return null;
    }
    const body = (await res.body.json()) as any;
    const m = (body?.data ?? [])[0];
    if (!m || typeof m.id !== "number") {
      cfSlugCache.set(cacheKey, { at: now, meta: null });
      return null;
    }
    const meta: CfProjectMeta = {
      modId: m.id,
      slug: m.slug,
      title: (m.name as string) ?? `CurseForge mod ${m.id}`,
      summary: m.summary as string | undefined,
      icon: (m.logo?.url as string | undefined) ?? null,
      pageUrl:
        (m.links?.websiteUrl as string | undefined) ??
        (m.slug
          ? `https://www.curseforge.com/minecraft/mc-mods/${m.slug}`
          : undefined),
    };
    cfSlugCache.set(cacheKey, { at: now, meta });
    return meta;
  } catch (err) {
    log?.warn({ err, query }, "curseforge search-by-name failed");
    return null;
  }
}

/**
 * Resolve a CF project by slug via /v1/mods/search?slug=X. Used as a
 * fallback when the fingerprint lookup misses — happens often for
 * mods that the modpack author re-bundled (recompressed jar = different
 * Murmur2 hash) but whose filename still carries the original slug
 * (e.g. "waystones-neoforge-1.21.1-21.1.25.jar" → slug=waystones).
 *
 * Returns metadata in the same shape as the fingerprint helper, so
 * the rest of the enrichment pipeline doesn't care which path resolved
 * the mod.
 */
async function curseforgeSlugLookup(
  slugs: string[],
  apiKey: string,
  log?: { warn: (obj: unknown, msg?: string) => void }
): Promise<Record<string, CfProjectMeta>> {
  const now = Date.now();
  const out: Record<string, CfProjectMeta> = {};
  const needFetch: string[] = [];
  for (const slug of slugs) {
    const cached = cfSlugCache.get(slug);
    if (cached && now - cached.at < CF_FP_TTL_MS) {
      if (cached.meta) out[slug] = cached.meta;
    } else {
      needFetch.push(slug);
    }
  }
  if (needFetch.length === 0) return out;

  // CF's search endpoint is one slug per call (slug is an exact-match
  // filter, not a fuzzy term). We parallelise but cap concurrency so a
  // big modpack with hundreds of un-fingerprinted jars doesn't stampede
  // the CF API rate limit.
  const CONCURRENCY = 8;
  const queue = [...needFetch];
  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const slug = queue.shift();
      if (!slug) return;
      try {
        const url = `https://api.curseforge.com/v1/mods/search?gameId=432&slug=${encodeURIComponent(
          slug
        )}`;
        const res = await request(url, {
          method: "GET",
          headers: { "x-api-key": apiKey, accept: "application/json" },
        });
        if (res.statusCode >= 400) {
          await res.body.dump().catch(() => {});
          cfSlugCache.set(slug, { at: now, meta: null });
          continue;
        }
        const body = (await res.body.json()) as any;
        const m = (body?.data ?? [])[0];
        if (!m || typeof m.id !== "number") {
          cfSlugCache.set(slug, { at: now, meta: null });
          continue;
        }
        const meta: CfProjectMeta = {
          modId: m.id,
          slug: m.slug,
          title: (m.name as string) ?? `CurseForge mod ${m.id}`,
          summary: m.summary as string | undefined,
          icon: (m.logo?.url as string | undefined) ?? null,
          pageUrl:
            (m.links?.websiteUrl as string | undefined) ??
            (m.slug
              ? `https://www.curseforge.com/minecraft/mc-mods/${m.slug}`
              : undefined),
        };
        cfSlugCache.set(slug, { at: now, meta });
        out[slug] = meta;
      } catch (err) {
        log?.warn({ err, slug }, "curseforge slug lookup failed");
        cfSlugCache.set(slug, { at: now, meta: null });
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, needFetch.length) }, worker)
  );
  return out;
}

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
 * Stop a container and *actually* stop it.
 *
 * Resilience checklist, every line earned by a real failure:
 *
 *   1. Disable the restart policy first (`RestartPolicy=no`). Without
 *      this, a container caught mid-crash-loop comes right back up
 *      after SIGTERM/SIGKILL because dockerd's `unless-stopped` policy
 *      counts the kill as a crash, not a user stop. Symptom the user
 *      hit: clicking Stop → 502 → server visibly back to "running"
 *      seconds later.
 *
 *   2. Swallow non-fatal `container.stop` errors. dockerode throws on
 *      "already stopped" (benign) and also on transient daemon-busy
 *      states during a tight restart-loop. We log and proceed —
 *      kill+wait below is the source of truth.
 *
 *   3. Use a short SIGTERM grace (5s, not 20). 20 seconds was fine for
 *      a healthy server flushing chunks; for a crashed JVM it just
 *      means the user waits 20s before the panel responds. With the
 *      restart policy already off, escalating early to SIGKILL is safe.
 *
 *   4. Hard-cap the wait-for-not-running step. If dockerd is fully
 *      hung, `wait` would block the agent's HTTP worker forever; a
 *      6s ceiling lets the user's Stop request return promptly with
 *      a "couldn't fully verify, but restart policy is off" outcome.
 */
async function stopReliably(container: any, log: Logger): Promise<void> {
  // Step 1: take the container off auto-restart. If this errors we
  // continue anyway — the kill below still runs, and if the container
  // does come back, the worst case is the user clicking Stop again.
  try {
    await container.update({ RestartPolicy: { Name: "no" } });
  } catch (err) {
    log.warn({ err }, "failed to clear RestartPolicy before stop");
  }

  // Step 2: graceful SIGTERM with a short grace.
  try {
    await container.stop({ t: 5 });
  } catch (err) {
    const msg = String(err);
    if (!/already stopped|is not running|304/i.test(msg)) {
      log.warn({ err }, "stop returned an error; escalating to kill");
    }
  }

  // Step 3: confirm + escalate. If Docker still reports Running, SIGKILL.
  try {
    const info = await container.inspect();
    if (info.State?.Running) {
      log.warn({}, "container still running after stop; sending SIGKILL");
      await container.kill().catch(() => {});
    }
  } catch (err) {
    log.warn({ err }, "inspect after stop failed");
  }

  // Step 4: bounded wait so the HTTP worker doesn't hang on a wedged daemon.
  await Promise.race([
    container.wait({ condition: "not-running" }).catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, 6_000)),
  ]);
}

/** Re-enable `unless-stopped` so the container survives reboots and
 *  one-off crashes. Called from start/restart paths after stopReliably
 *  cleared the policy on its way down. */
async function restoreRestartPolicy(container: any, log: Logger): Promise<void> {
  try {
    await container.update({ RestartPolicy: { Name: "unless-stopped" } });
  } catch (err) {
    log.warn({ err }, "failed to restore RestartPolicy on start");
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
  // stopReliably clears RestartPolicy so a crash-loop container
  // actually goes down on user Stop. Restore it on the next user Start
  // so a normal MC crash brings the server back up under the watchdog.
  await restoreRestartPolicy(container, log);
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

// ====================== MODLOADER INSTALLER HELPERS ======================

/**
 * Files inside /data that hold the OLD loader version's identity.
 * Wiped before running the installer so the new run.sh / launch jars
 * land on a clean slate. Mod jars and world data are NOT in this list.
 */
/**
 * Per-loader and shared paths that need to be removed before our
 * installer runs, otherwise mc-image-helper / itzg short-circuits
 * and reinstalls the OLD version on next boot.
 *
 * The non-obvious one (which surfaced in real-world testing): for
 * NeoForge / Forge, mc-image-helper drops a copy of the installer
 * jar at /data/neoforge-<ver>-installer.jar (or forge-...) during
 * the initial pack install, then re-runs THAT jar on subsequent
 * boots. Even after we wiped run.sh + libraries and dropped fresh
 * 21.1.228 versions, mc-image-helper would find the cached 21.1.172
 * installer at /data root and overwrite everything back to 21.1.172.
 * So the wipe HAS to clear those root-level installer jars too.
 */
function staleLoaderPaths(loader: "neoforge" | "forge" | "fabric" | "quilt"): string[] {
  const common = [
    "run.sh",
    "run.bat",
    "user_jvm_args.txt",
    // mc-image-helper install-state markers (varies by version)
    ".cache/cf-modloader.txt",
    ".installed-modloader",
    ".curseforge-state",
    ".cf-state.json",
    ".cf-installed",
    "installs",
  ];
  switch (loader) {
    case "neoforge":
      return [
        ...common,
        "libraries/net/neoforged",
      ];
    case "forge":
      return [
        ...common,
        "libraries/net/minecraftforge",
      ];
    case "fabric":
      return [
        ...common,
        "fabric-server-launcher.jar",
        "fabric-server-launch.jar",
        ".fabric-installer-version",
      ];
    case "quilt":
      return [
        ...common,
        "quilt-server-launcher.jar",
        ".quilt-installer-version",
      ];
  }
}

/**
 * mc-image-helper drops `neoforge-<ver>-installer.jar` (or
 * `forge-<ver>-installer.jar`) at /data root during pack install
 * and re-runs it on every subsequent boot, which silently restores
 * the pack-shipped loader version no matter what NEOFORGE_VERSION
 * we set. Glob-wipe these by listing /data and matching the pattern
 * — we can't enumerate via the file API since we don't know the old
 * version number ahead of time.
 */
async function wipeRootInstallerJars(
  dataDir: string,
  loader: "neoforge" | "forge" | "fabric" | "quilt",
  log: Logger
): Promise<void> {
  const prefix =
    loader === "neoforge"
      ? "neoforge-"
      : loader === "forge"
        ? "forge-"
        : null;
  if (!prefix) return;
  let entries: string[];
  try {
    entries = await fs.readdir(dataDir);
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.startsWith(prefix) && /-installer\.jar(\.log)?$/.test(e)) {
      const full = path.join(dataDir, e);
      try {
        await fs.rm(full, { force: true });
        log.info({ path: full }, "wiped cached installer jar");
      } catch (err) {
        log.warn({ err, path: full }, "couldn't wipe cached installer jar");
      }
    }
  }
}

/** Canonical installer-jar URL per loader. */
function installerUrl(
  loader: "neoforge" | "forge" | "fabric" | "quilt",
  version: string,
  mcVersion: string | null
): string {
  switch (loader) {
    case "neoforge":
      return `https://maven.neoforged.net/releases/net/neoforged/neoforge/${version}/neoforge-${version}-installer.jar`;
    case "forge": {
      if (!mcVersion) {
        throw new Error("Forge installer URL requires mcVersion");
      }
      const fv = `${mcVersion}-${version}`;
      return `https://maven.minecraftforge.net/net/minecraftforge/forge/${fv}/forge-${fv}-installer.jar`;
    }
    case "fabric": {
      // Fabric ships a single "universal" installer jar that we point
      // at a specific MC + loader version via CLI args. Pinning the
      // installer to 1.0.1 (released early 2024, stable) avoids drift
      // when fabricmc cuts new installer builds.
      const installerVer = "1.0.1";
      return `https://maven.fabricmc.net/net/fabricmc/fabric-installer/${installerVer}/fabric-installer-${installerVer}.jar`;
    }
    case "quilt": {
      const installerVer = "0.9.2";
      return `https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer/${installerVer}/quilt-installer-${installerVer}.jar`;
    }
  }
}

/** Java args the temp container runs to invoke the installer. */
function installerCmd(
  loader: "neoforge" | "forge" | "fabric" | "quilt",
  version: string,
  mcVersion: string | null,
  installerName: string
): string[] {
  const installerInContainer = `/data/${installerName}`;
  switch (loader) {
    case "neoforge":
    case "forge":
      // Both loaders' installers accept --installServer with the
      // target dir; pointing at /data lands run.sh + libraries there.
      return ["java", "-jar", installerInContainer, "--installServer", "/data"];
    case "fabric":
      if (!mcVersion) throw new Error("fabric installer needs mcVersion");
      return [
        "java",
        "-jar",
        installerInContainer,
        "server",
        "-mcversion",
        mcVersion,
        "-loader",
        version,
        "-downloadMinecraft",
      ];
    case "quilt":
      if (!mcVersion) throw new Error("quilt installer needs mcVersion");
      return [
        "java",
        "-jar",
        installerInContainer,
        "install",
        "server",
        mcVersion,
        version,
        "--download-server",
      ];
  }
}

/** Filename the installer is expected to produce on success. Used as
 *  a sanity check after the installer container exits. */
function installerOutputMarker(loader: "neoforge" | "forge" | "fabric" | "quilt"): string {
  switch (loader) {
    case "neoforge":
    case "forge":
      return "run.sh";
    case "fabric":
      return "fabric-server-launch.jar";
    case "quilt":
      return "quilt-server-launcher.jar";
  }
}

/**
 * After the installer container exits, walk the paths it wrote and
 * fix ownership to 1000:1000 (itzg's runtime uid). The installer ran
 * as root so its outputs are root-owned by default; itzg's gosu drop
 * to uid 1000 then can't write user_jvm_args.txt and bombs out with
 * the exact "Permission denied" the user kept hitting.
 *
 * We don't chown the entire data dir because most of it (mods, world,
 * config) is already 1000-owned and walking 10k+ files on a big
 * modpack adds seconds. Just the loader's own outputs.
 */
async function chownInstallerOutput(
  dataDir: string,
  loader: "neoforge" | "forge" | "fabric" | "quilt",
  log: Logger
): Promise<void> {
  // The NeoForge / Forge installer doesn't just write libraries/net/
  // <loader>/ — it also lays down libraries/net/minecraft/server/...,
  // libraries/cpw/..., libraries/org/..., the actual mc server jar
  // itself, and a bunch of others. ALL of those land as root-owned
  // because the temp container runs as root, and on the next itzg
  // boot install-neoforge tries to overwrite them with the same
  // version + fails on AccessDeniedException.
  //
  // Cheapest correct fix: chown -R the entire /data/libraries tree
  // plus the run scripts. /data/libraries on a fresh CF pack install
  // is small (~50–100MB, mostly Minecraft + loader common deps) so
  // walking it is fast. Anything outside libraries (mods, world,
  // configs) stays as it was.
  const topLevelTargets: string[] = [
    "run.sh",
    "run.bat",
    "user_jvm_args.txt",
    "libraries",
  ];
  switch (loader) {
    case "fabric":
      topLevelTargets.push(
        "fabric-server-launcher.jar",
        "fabric-server-launch.jar"
      );
      break;
    case "quilt":
      topLevelTargets.push("quilt-server-launcher.jar");
      break;
  }
  for (const rel of topLevelTargets) {
    const full = path.join(dataDir, rel);
    try {
      await chownRecursive(full, 1000, 1000);
    } catch (err) {
      log.warn({ err, path: full }, "post-install chown failed");
    }
  }
}

/**
 * Confirm that the installer actually produced files for the version
 * the user asked for, not some other one. NeoForge / Forge install
 * to libraries/<loaderPath>/<version>/; we check that directory
 * exists. Logged + returned so the panel UI sees ground truth.
 */
async function verifyInstalledVersion(
  dataDir: string,
  loader: "neoforge" | "forge" | "fabric" | "quilt",
  version: string,
  log: Logger
): Promise<{ ok: boolean; foundVersion?: string; details?: string }> {
  if (loader === "fabric" || loader === "quilt") {
    // These don't shard libraries by version — the launcher jar itself
    // is the version, and we already check it via installerOutputMarker.
    return { ok: true };
  }
  const baseDir =
    loader === "neoforge"
      ? path.join(dataDir, "libraries", "net", "neoforged", "neoforge")
      : path.join(dataDir, "libraries", "net", "minecraftforge", "forge");
  let entries: string[] = [];
  try {
    entries = await fs.readdir(baseDir);
  } catch (err) {
    log.warn(
      { err, baseDir },
      "verify: loader libraries dir is missing — installer didn't run for our version"
    );
    return { ok: false, details: `${baseDir} doesn't exist` };
  }
  if (entries.includes(version)) {
    return { ok: true, foundVersion: version };
  }
  log.warn(
    { baseDir, expected: version, found: entries },
    "verify: expected version subdir not found — installer wrote a DIFFERENT version"
  );
  return {
    ok: false,
    foundVersion: entries[0],
    details: `expected ${version}, found ${entries.join(", ") || "<empty>"}`,
  };
}

async function chownRecursive(
  target: string,
  uid: number,
  gid: number
): Promise<void> {
  let stat: import("node:fs").Stats;
  try {
    stat = await fs.lstat(target);
  } catch {
    return; // path doesn't exist — nothing to chown
  }
  await fs.chown(target, uid, gid);
  if (stat.isDirectory()) {
    const entries = await fs.readdir(target);
    for (const e of entries) {
      await chownRecursive(path.join(target, e), uid, gid);
    }
  }
}

/**
 * Stream-download a jar to disk, optionally through a proxy.
 *
 * Two paths because undici's ProxyAgent only speaks HTTP CONNECT,
 * which a SOCKS5-only inbound (xray's default `socks` inbound) just
 * rejects with 400. So:
 *   - http:// proxies → undici ProxyAgent (fast, native).
 *   - socks5:// proxies → SocksProxyAgent on Node's https module
 *     (one extra dependency but actually speaks the protocol).
 *
 * Both stream the response straight to disk so a 50MB installer
 * doesn't spike RSS.
 */
/**
 * Open an HTTPS stream to `url`, optionally tunnelled through a
 * SOCKS5 proxy (xray etc.). Returns a Readable that emits the
 * response body chunks. Used by the .mrpack exporter to inline
 * CDN-hosted client mods into the ZIP without a temp-disk hop.
 */
async function openHttpStream(
  url: string,
  proxyUrl: string | null
): Promise<NodeJS.ReadableStream> {
  if (proxyUrl?.startsWith("socks")) {
    const [{ SocksProxyAgent }, https] = await Promise.all([
      import("socks-proxy-agent"),
      import("node:https"),
    ]);
    const agent = new SocksProxyAgent(proxyUrl);
    return new Promise((resolve, reject) => {
      const doFetch = (target: string, redirects: number): void => {
        if (redirects > 5) {
          reject(new Error("too many redirects"));
          return;
        }
        https
          .get(
            target,
            { agent: agent as any, timeout: 60_000 },
            (res) => {
              const status = res.statusCode ?? 0;
              if (status === 301 || status === 302 || status === 307) {
                res.resume();
                const loc = res.headers.location;
                if (!loc) {
                  reject(new Error(`HTTP ${status} no Location`));
                  return;
                }
                doFetch(loc, redirects + 1);
                return;
              }
              if (status >= 400) {
                res.resume();
                reject(new Error(`HTTP ${status}`));
                return;
              }
              resolve(res);
            }
          )
          .on("error", reject)
          .on("timeout", function (this: any) {
            this.destroy(new Error("connect timeout"));
          });
      };
      doFetch(url, 0);
    });
  }
  // Plain or HTTP-CONNECT proxy → undici with optional ProxyAgent.
  let dispatcher: import("undici").Dispatcher | undefined;
  if (proxyUrl) {
    const { ProxyAgent } = await import("undici");
    dispatcher = new ProxyAgent(proxyUrl);
  }
  const res = await request(url, {
    method: "GET",
    maxRedirections: 5,
    headersTimeout: 30_000,
    bodyTimeout: 5 * 60_000,
    dispatcher,
  });
  if (res.statusCode >= 400) {
    await res.body.dump().catch(() => {});
    throw new Error(`HTTP ${res.statusCode}`);
  }
  // undici returns a web ReadableStream; convert to Node Readable
  // so archiver / node:fs APIs accept it.
  const { Readable } = await import("node:stream");
  return Readable.fromWeb(res.body as any);
}

/**
 * mc-image-helper 1.56–1.57's ProvidedInstallerResolver expects the
 * installer's `version.json` `id` field to look like
 *   "neoforge-<mcVer>-<loaderVer>"   (3 segments)
 *   "forge-<mcVer>-<loaderVer>"      (3 segments)
 * Newer NeoForge installers (since ~21.1.x) ship as
 *   "neoforge-21.1.228"              (2 segments)
 * which trips the parser with
 *   "Unexpected format of id from Forge installer's version.json".
 *
 * Patch the jar in place: insert the MC version (read from
 * `inheritsFrom`) into the id so mc-image-helper accepts it. Loader
 * itself doesn't care about the id field — it reads loader version
 * from elsewhere — so the rewrite is cosmetic and safe.
 */
async function patchInstallerVersionJson(
  installerPath: string,
  loader: "neoforge" | "forge"
): Promise<void> {
  const { default: AdmZip } = await import("adm-zip");
  const zip = new AdmZip(installerPath);
  const entry = zip.getEntries().find((e) => e.entryName === "version.json");
  if (!entry) return; // shouldn't happen for valid installer; let mc-image-helper complain
  const raw = zip.readAsText(entry);
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  const id = String(parsed.id ?? "");
  // Already 3+ segments → mc-image-helper happy, leave alone.
  if (id.split("-").length >= 3) return;
  const mc = String(parsed.inheritsFrom ?? "").trim();
  if (!mc) return;
  const prefix = loader; // "neoforge" / "forge"
  const loaderVer = id.startsWith(`${prefix}-`)
    ? id.slice(prefix.length + 1)
    : id;
  parsed.id = `${prefix}-${mc}-${loaderVer}`;
  zip.updateFile(entry, Buffer.from(JSON.stringify(parsed, null, 2), "utf8"));
  zip.writeZip(installerPath);
}

async function downloadInstallerJar(
  url: string,
  destPath: string,
  proxyUrl: string | null
): Promise<void> {
  if (proxyUrl?.startsWith("socks")) {
    return downloadViaSocks(url, destPath, proxyUrl);
  }
  let dispatcher: import("undici").Dispatcher | undefined;
  if (proxyUrl) {
    const { ProxyAgent } = await import("undici");
    dispatcher = new ProxyAgent(proxyUrl);
  }
  const res = await request(url, {
    method: "GET",
    maxRedirections: 5,
    // Generous: maven.neoforged.net + maven.minecraftforge.net can be
    // slow especially without a proxy. 50MB installer at 100KB/s is
    // ~8 min; allow 15 min so a slow but progressing connection
    // doesn't get killed.
    headersTimeout: 60_000,
    bodyTimeout: 15 * 60_000,
    dispatcher,
  });
  if (res.statusCode >= 400) {
    await res.body.dump().catch(() => {});
    throw new Error(`HTTP ${res.statusCode}`);
  }
  // Stream to disk so a 200MB Forge installer doesn't spike RSS.
  const fh = await fs.open(destPath, "w");
  try {
    for await (const chunk of res.body) {
      await fh.write(chunk);
    }
  } finally {
    await fh.close();
  }
}

/**
 * SOCKS5 download path — uses Node's built-in https module (which
 * accepts a custom http.Agent) wired up to socks-proxy-agent.
 */
async function downloadViaSocks(
  url: string,
  destPath: string,
  socksUrl: string
): Promise<void> {
  const [{ SocksProxyAgent }, https, { createWriteStream }] = await Promise.all([
    import("socks-proxy-agent"),
    import("node:https"),
    import("node:fs"),
  ]);
  const agent = new SocksProxyAgent(socksUrl);
  await new Promise<void>((resolve, reject) => {
    const req = https.get(
      url,
      {
        agent: agent as any,
        // Follow redirects manually — see below — but Node's https
        // doesn't auto-redirect, so for now bail loudly if upstream
        // 30x's. mavens for the loaders we support don't redirect.
        timeout: 60_000,
      },
      (res) => {
        if ((res.statusCode ?? 0) >= 400) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        if (res.statusCode === 301 || res.statusCode === 302) {
          res.resume();
          const location = res.headers.location;
          if (!location) {
            reject(new Error(`HTTP ${res.statusCode} with no Location header`));
            return;
          }
          downloadViaSocks(location, destPath, socksUrl).then(resolve, reject);
          return;
        }
        const fileStream = createWriteStream(destPath);
        res.pipe(fileStream);
        fileStream.on("finish", () => {
          fileStream.close();
          resolve();
        });
        fileStream.on("error", reject);
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("socks download: connect timeout"));
    });
  });
}

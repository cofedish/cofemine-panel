import path from "node:path";
import type { Readable } from "node:stream";
import { config } from "./config.js";
import { docker, badRequest, notFound } from "./docker.js";
import {
  execCollect,
  findByServerId,
  labelKey,
  projectInspect,
  requireByServerId,
  type ContainerStateView,
} from "./containers.js";
import { getRuntime } from "./runtime/registry.js";
import type { ServerSpec } from "./runtime/runtime-provider.js";
import { ensureNetwork } from "./ca-volumes.js";

/**
 * Server ids are used as a path component under DATA_ROOT and as a label
 * value. `path.join` does not sanitise, so an id of `..` would resolve
 * the bind source to the data root itself.
 */
const SERVER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function dataPathFor(serverId: string): string {
  if (!SERVER_ID_RE.test(serverId)) throw badRequest("Invalid server id");
  return path.join(config.DATA_ROOT, serverId);
}

/**
 * Images this service is willing to run.
 *
 * The loader-installer endpoint takes an image name from the agent, and
 * "run a container from an arbitrary image with /data mounted" is a
 * short walk from "run a container from an image whose entrypoint reads
 * the mounted directory and phones home". Prefix allowlist keeps it to
 * the JDK images the installer flow actually uses.
 */
const INSTALLER_IMAGE_PREFIXES = ["eclipse-temurin:", "openjdk:", "amazoncorretto:"];

function assertInstallerImage(image: string): void {
  if (!INSTALLER_IMAGE_PREFIXES.some((p) => image.startsWith(p))) {
    throw badRequest(`Installer image not allowed: ${image}`);
  }
}

/** Pull an image when it isn't present locally. */
export async function ensureImagePulled(
  image: string,
  log: (msg: string) => void = () => {}
): Promise<void> {
  try {
    await docker.getImage(image).inspect();
    return;
  } catch {
    // not present — pull below
  }
  log(`pulling ${image}`);
  const stream = await docker.pull(image);
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (err: Error | null) =>
      err ? reject(err) : resolve()
    );
  });
  log(`pulled ${image}`);
}

/**
 * Create a Minecraft container from a validated spec.
 *
 * The caller supplies the *spec* — type, version, memory, ports, env —
 * and nothing else. Image selection, bind mounts, capabilities, the
 * network, `no-new-privileges`, the pids limit and the CA volume all
 * come from `ItzgRuntimeProvider` running here, on the socket side. That
 * is the reason this service exists: a compromised agent can ask for a
 * Minecraft server, not for a container with the host filesystem mounted.
 */
export async function createServerContainer(
  spec: ServerSpec
): Promise<{ containerId: string }> {
  const dataPath = dataPathFor(spec.id);
  await ensureNetwork(config.DOCKER_NETWORK);
  const runtime = getRuntime("itzg");
  const opts = runtime.createContainerSpec(spec, dataPath);
  await ensureImagePulled(String(opts.Image));
  const created = await docker.createContainer(opts);
  await runtime.postCreate?.(spec, dataPath);
  return { containerId: created.id };
}

export async function inspectServer(
  serverId: string
): Promise<ContainerStateView | null> {
  const container = await findByServerId(serverId);
  if (!container) return null;
  try {
    return projectInspect(await container.inspect());
  } catch {
    return null;
  }
}

export async function startServer(serverId: string): Promise<void> {
  const container = await requireByServerId(serverId);
  await container.start().catch((err: { statusCode?: number }) => {
    // 304 = already started.
    if (err?.statusCode !== 304) throw err;
  });
}

export async function stopServer(
  serverId: string,
  timeoutSeconds: number
): Promise<void> {
  const container = await requireByServerId(serverId);
  await container.stop({ t: timeoutSeconds }).catch((err: { statusCode?: number }) => {
    if (err?.statusCode !== 304) throw err;
  });
}

export async function killServer(serverId: string): Promise<void> {
  const container = await requireByServerId(serverId);
  await container.kill().catch(() => {});
}

export async function removeServer(serverId: string): Promise<void> {
  const container = await findByServerId(serverId);
  if (!container) return;
  await container.remove({ force: true });
}

export async function setRestartPolicy(
  serverId: string,
  policy: "no" | "unless-stopped"
): Promise<void> {
  const container = await requireByServerId(serverId);
  await container.update({ RestartPolicy: { Name: policy } });
}

export async function waitForServer(
  serverId: string,
  condition?: "not-running"
): Promise<{ statusCode: number | null }> {
  const container = await requireByServerId(serverId);
  const result = await container.wait(
    condition ? { condition } : undefined
  );
  return { statusCode: result?.StatusCode ?? null };
}

export async function serverStats(serverId: string): Promise<unknown> {
  const container = await requireByServerId(serverId);
  return new Promise((resolve, reject) => {
    (
      container as unknown as {
        stats: (
          opts: { stream: false },
          cb: (err: Error | null, data: unknown) => void
        ) => void;
      }
    ).stats({ stream: false }, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

/** Raw (still docker-framed) logs. The caller demuxes, as it always did. */
export async function serverLogs(
  serverId: string,
  opts: { tail?: number; since?: number; timestamps?: boolean }
): Promise<Buffer> {
  const container = await requireByServerId(serverId);
  const out = (await container.logs({
    follow: false,
    stdout: true,
    stderr: true,
    tail: opts.tail ?? 500,
    timestamps: opts.timestamps ?? false,
    ...(opts.since ? { since: opts.since } : {}),
  } as unknown as { follow: false })) as unknown as Buffer;
  return out;
}

export async function serverLogStream(
  serverId: string,
  opts: { tail?: number }
): Promise<Readable> {
  const container = await requireByServerId(serverId);
  return (await container.logs({
    follow: true,
    stdout: true,
    stderr: true,
    tail: opts.tail ?? 200,
    timestamps: false,
  })) as unknown as Readable;
}

/**
 * Run a command inside a server's container.
 *
 * The command is caller-supplied — it is how the panel runs `rcon-cli`
 * — and that is a deliberate, bounded grant: exec lands inside a
 * Minecraft container the agent could already reach over RCON, not on
 * the host. It is scoped by the label lookup, so it cannot target the
 * database or a neighbour stack.
 */
export async function execInServer(
  serverId: string,
  cmd: string[]
): Promise<{ output: string; exitCode: number | null }> {
  if (cmd.length === 0) throw badRequest("Empty command");
  const container = await requireByServerId(serverId);
  const info = await container.inspect();
  if (!info.State?.Running) throw badRequest("Container is not running");
  return execCollect(container, cmd);
}

/**
 * Merge extra env into an existing server container by recreating it.
 *
 * The HostConfig is reused verbatim from the container we made earlier,
 * so this cannot introduce a mount or a capability the runtime provider
 * wouldn't have produced. Forbidden keys are stripped again here for the
 * same reason they are stripped at create time.
 */
const FORBIDDEN_ENV_KEYS = new Set(["UID", "GID", "RUN_AS_ROOT", "SKIP_SUDO"]);

export async function mergeServerEnv(
  serverId: string,
  extra: Record<string, string>
): Promise<{ containerId: string }> {
  const container = await requireByServerId(serverId);
  const info = await container.inspect();
  const envMap: Record<string, string> = {};
  for (const line of info.Config?.Env ?? []) {
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    envMap[line.slice(0, eq)] = line.slice(eq + 1);
  }
  Object.assign(envMap, extra);
  for (const key of Object.keys(envMap)) {
    if (key.startsWith("__COFEMINE_") || FORBIDDEN_ENV_KEYS.has(key.toUpperCase())) {
      delete envMap[key];
    }
  }

  const wasRunning = info.State?.Running === true;
  if (wasRunning) await container.stop({ t: 20 }).catch(() => {});
  await container.remove({ force: true });
  const created = await docker.createContainer({
    name: info.Name.replace(/^\//, ""),
    Image: info.Config.Image,
    Env: Object.entries(envMap).map(([k, v]) => `${k}=${v}`),
    ExposedPorts: info.Config.ExposedPorts,
    Labels: info.Config.Labels,
    Entrypoint: info.Config.Entrypoint ?? undefined,
    Tty: false,
    OpenStdin: true,
    StdinOnce: false,
    HostConfig: info.HostConfig,
  });
  return { containerId: created.id };
}

/**
 * One-shot loader-installer container: JDK image, the server's own /data
 * bound in, no socket, no other mounts. The bind source is derived from
 * the server id here — the agent never names a path.
 */
export async function runInstaller(input: {
  serverId: string;
  image: string;
  cmd: string[];
  env: string[];
}): Promise<{ exitCode: number; logs: Buffer }> {
  assertInstallerImage(input.image);
  const dataPath = dataPathFor(input.serverId);
  await ensureImagePulled(input.image);
  const temp = await docker.createContainer({
    Image: input.image,
    Cmd: input.cmd,
    WorkingDir: "/data",
    Env: input.env,
    HostConfig: {
      Binds: [`${dataPath}:/data`],
      AutoRemove: false,
      NetworkMode: config.DOCKER_NETWORK,
      ExtraHosts: ["host.docker.internal:host-gateway"],
      SecurityOpt: ["no-new-privileges"],
      PidsLimit: 512,
    },
    Tty: false,
  });
  try {
    await temp.start();
    const result = await temp.wait();
    const logs = (await temp.logs({
      stdout: true,
      stderr: true,
      follow: false,
    })) as unknown as Buffer;
    return { exitCode: result?.StatusCode ?? -1, logs };
  } finally {
    await temp.remove({ force: true }).catch(() => {});
  }
}

export function assertKnownServer(serverId: string): void {
  if (!SERVER_ID_RE.test(serverId)) throw notFound("Unknown server");
}

export { labelKey };

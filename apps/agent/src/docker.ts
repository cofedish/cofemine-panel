import Docker from "dockerode";
import { config } from "./config.js";

export const docker = new Docker(
  config.DOCKER_HOST_URL
    ? { host: new URL(config.DOCKER_HOST_URL).hostname, port: Number(new URL(config.DOCKER_HOST_URL).port || 2375), protocol: new URL(config.DOCKER_HOST_URL).protocol.replace(":", "") as "http" | "https" }
    : { socketPath: config.DOCKER_SOCKET }
);

export async function ensureNetwork(name: string): Promise<void> {
  const networks = await docker.listNetworks({
    filters: JSON.stringify({ name: [name] }),
  });
  if (networks.length === 0) {
    await docker.createNetwork({ Name: name, Driver: "bridge" });
  }
}

/**
 * Idempotently make sure a named Docker volume exists. Used for the
 * maven-cache CA bundle (shared between the cache sidecar and every
 * MC container that should trust its leaf certs) so the agent doesn't
 * need a host-side bind path that may or may not exist depending on
 * how the operator deployed the panel.
 */
export async function ensureVolume(name: string): Promise<void> {
  const list = await docker.listVolumes({
    filters: JSON.stringify({ name: [name] }),
  });
  const found = (list.Volumes ?? []).some((v) => v.Name === name);
  if (!found) {
    await docker.createVolume({ Name: name });
  }
}

/**
 * Run a shell script in a throwaway alpine container with the given
 * volume binds. This is the standard pattern for touching a named
 * volume when the agent has no host-side mount path of its own.
 *
 * Callers pass binds as `<volume>:<mountpoint>` so a single run can
 * work across several volumes at once — which is how the CA material
 * is kept consistent between the private, public and legacy volumes
 * without three separate container launches.
 */
export async function runInVolumes(
  binds: string[],
  script: string
): Promise<void> {
  // Make sure the helper image is available — pull only when missing,
  // so offline / air-gapped setups that pre-loaded it still work.
  const have = await docker.listImages({ filters: { reference: ["alpine:3"] } });
  if (have.length === 0) {
    await new Promise<void>((resolve, reject) => {
      docker.pull("alpine:3", (err: unknown, stream: NodeJS.ReadableStream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (e) => (e ? reject(e) : resolve()));
      });
    });
  }

  const c = await docker.createContainer({
    Image: "alpine:3",
    Cmd: ["sh", "-c", script],
    HostConfig: {
      Binds: binds,
      AutoRemove: true,
    },
  });
  await c.start();
  // Wait so the container has time to finish; AutoRemove fires on exit.
  try {
    await c.wait();
  } catch {
    // AutoRemove may race with wait — that's fine, the write happened.
  }
}

/**
 * Build the shell fragment that writes one text file. Content is
 * base64-encoded so we never have to shell-escape arbitrary bytes
 * (PEM has newlines, but no NULs).
 */
export function writeFileScript(file: {
  path: string;
  content: string;
  mode?: number;
}): string {
  const b64 = Buffer.from(file.content, "utf8").toString("base64");
  return [
    `echo '${b64}' | base64 -d > '${file.path}'`,
    `chmod ${(file.mode ?? 0o644).toString(8)} '${file.path}'`,
  ].join(" && ");
}

/**
 * Write a small set of text files into a single named Docker volume.
 * Files are written with mode 0644 unless overridden; the CA keyfile
 * asks for 0600 because squid refuses to read a world-readable private
 * key.
 */
export async function writeFilesToVolume(
  volumeName: string,
  files: Array<{ path: string; content: string; mode?: number }>
): Promise<void> {
  const dirs = new Set<string>();
  for (const f of files) {
    const lastSlash = f.path.lastIndexOf("/");
    if (lastSlash > 0) dirs.add(f.path.slice(0, lastSlash));
  }
  const parts: string[] = [];
  if (dirs.size > 0) {
    parts.push(`mkdir -p ${[...dirs].map((d) => `'${d}'`).join(" ")}`);
  }
  for (const f of files) parts.push(writeFileScript(f));
  await runInVolumes([`${volumeName}:/dst`], parts.join(" && "));
}

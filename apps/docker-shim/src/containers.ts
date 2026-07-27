import type Dockerode from "dockerode";
import { Writable } from "node:stream";
import { config } from "./config.js";
import { docker, notFound } from "./docker.js";

/**
 * Container addressing.
 *
 * Callers name a **server id**, never a container id. The lookup is
 * filtered on `<prefix>.serverId`, so the set of containers this
 * service will act on is exactly the set it created. A compromised
 * agent cannot inspect, exec into, or delete anything else on the host
 * — not the panel's own containers, not the database, not a neighbour
 * stack's workload.
 *
 * This is the property that makes the split worth doing. Keep it: do
 * not add an endpoint that takes a container id or name.
 */
export function labelKey(suffix: string): string {
  return `${config.LABEL_PREFIX}.${suffix}`;
}

export async function findByServerId(
  serverId: string
): Promise<Dockerode.Container | null> {
  const matches = await docker.listContainers({
    all: true,
    filters: JSON.stringify({
      label: [`${labelKey("serverId")}=${serverId}`],
    }),
  });
  const first = matches[0];
  return first ? docker.getContainer(first.Id) : null;
}

export async function requireByServerId(
  serverId: string
): Promise<Dockerode.Container> {
  const found = await findByServerId(serverId);
  if (!found) throw notFound(`No managed container for server ${serverId}`);
  return found;
}

export type ManagedContainerSummary = {
  serverId: string;
  containerId: string;
  name: string;
  image: string;
  state: string;
  status: string;
  labels: Record<string, string>;
};

export async function listManaged(): Promise<ManagedContainerSummary[]> {
  const rows = await docker.listContainers({
    all: true,
    filters: JSON.stringify({ label: [`${labelKey("managed")}=true`] }),
  });
  return rows.map((c) => ({
    serverId: c.Labels[labelKey("serverId")] ?? "",
    containerId: c.Id,
    name: (c.Names[0] ?? "").replace(/^\//, ""),
    image: c.Image,
    state: c.State,
    status: c.Status,
    labels: c.Labels,
  }));
}

/**
 * Projection of `docker inspect` returned to the agent.
 *
 * Deliberately a subset. The raw inspect payload carries the host's
 * bind paths, the full env (including the RCON password and, for
 * CurseForge servers, the API key) and the resolved image digest —
 * none of which the agent needs, and all of which would flow onward
 * into panel responses if something forgot to filter.
 */
export type ContainerStateView = {
  containerId: string;
  name: string;
  image: string;
  running: boolean;
  status: string;
  exitCode: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  restartPolicy: string | null;
  /** IP on the panel's own docker network, for the map proxy. */
  networkIp: string | null;
  ports: Array<{ container: number; protocol: string; host: number | null }>;
  /** Panel-managed labels only. */
  labels: Record<string, string>;
};

export function projectInspect(
  info: Dockerode.ContainerInspectInfo
): ContainerStateView {
  const networks = info.NetworkSettings?.Networks ?? {};
  const ours = networks[config.DOCKER_NETWORK];
  const ports: ContainerStateView["ports"] = [];
  for (const [key, bindings] of Object.entries(
    info.NetworkSettings?.Ports ?? {}
  )) {
    const [portStr, protocol] = key.split("/");
    const hostPort = Array.isArray(bindings) && bindings[0]?.HostPort;
    ports.push({
      container: Number(portStr),
      protocol: protocol ?? "tcp",
      host: hostPort ? Number(hostPort) : null,
    });
  }
  const labels: Record<string, string> = {};
  for (const [k, v] of Object.entries(info.Config?.Labels ?? {})) {
    if (k.startsWith(`${config.LABEL_PREFIX}.`)) labels[k] = v;
  }
  return {
    containerId: info.Id,
    name: (info.Name ?? "").replace(/^\//, ""),
    image: info.Config?.Image ?? "",
    running: info.State?.Running === true,
    status: info.State?.Status ?? "unknown",
    exitCode: info.State?.ExitCode ?? null,
    startedAt: info.State?.StartedAt ?? null,
    finishedAt: info.State?.FinishedAt ?? null,
    restartPolicy: info.HostConfig?.RestartPolicy?.Name ?? null,
    networkIp: ours?.IPAddress || null,
    ports,
    labels,
  };
}

/** Collects a demultiplexed exec stream into one string. */
export async function execCollect(
  container: Dockerode.Container,
  cmd: string[]
): Promise<{ output: string; exitCode: number | null }> {
  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  await new Promise<void>((resolve, reject) => {
    (
      container as unknown as {
        modem: {
          demuxStream: (
            source: NodeJS.ReadableStream,
            stdout: Writable,
            stderr: Writable
          ) => void;
        };
      }
    ).modem.demuxStream(stream, sink, sink);
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  const details = await exec.inspect().catch(() => null);
  return {
    output: Buffer.concat(chunks).toString("utf8"),
    exitCode: details?.ExitCode ?? null,
  };
}

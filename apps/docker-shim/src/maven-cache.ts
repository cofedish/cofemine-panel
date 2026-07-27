import type { ContainerInfo } from "dockerode";
import { docker, notFound } from "./docker.js";
import {
  CA_KEY_VOLUME_NAME,
  CA_LEGACY_VOLUME_NAME,
  distributeCaMaterial,
} from "./ca-volumes.js";

/**
 * Lifecycle management for the maven-cache sidecar.
 *
 * Lives here rather than in the agent because recreating a container
 * means calling `createContainer` with a HostConfig — the one primitive
 * that turns "RCE in the agent" into "root on the host". The agent asks
 * for a recreate with an upstream proxy URL and CA material; the mounts,
 * image and network come from the existing container's own spec, never
 * from the request.
 */
const COMPOSE_CONTAINER_NAME = "cofemine-maven-cache-1";

async function findSidecar(): Promise<ContainerInfo | undefined> {
  const all = await docker.listContainers({ all: true });
  return (
    all.find((c) => c.Names.some((n) => n === `/${COMPOSE_CONTAINER_NAME}`)) ??
    all.find((c) => c.Labels["com.docker.compose.service"] === "maven-cache")
  );
}

export async function mavenCacheStatus(): Promise<{
  running: boolean;
  upstreamProxy: string | null;
  caMounted: boolean;
  startedAt: string | null;
  image: string | null;
}> {
  const existing = await findSidecar();
  if (!existing) {
    return {
      running: false,
      upstreamProxy: null,
      caMounted: false,
      startedAt: null,
      image: null,
    };
  }
  const inspect = await docker.getContainer(existing.Id).inspect();
  const env = inspect.Config?.Env ?? [];
  const upstream =
    env
      .find((e) => e.startsWith("UPSTREAM_PROXY="))
      ?.slice("UPSTREAM_PROXY=".length) ?? null;
  return {
    running: inspect.State?.Running ?? false,
    upstreamProxy: upstream || null,
    caMounted: (inspect.HostConfig?.Binds ?? []).some((b) =>
      b.startsWith(`${CA_KEY_VOLUME_NAME}:`)
    ),
    startedAt: inspect.State?.StartedAt ?? null,
    image: inspect.Config?.Image ?? null,
  };
}

/**
 * Stop → remove → create-with-new-env → start. Docker exposes no live
 * env mutation, so pushing a new UPSTREAM_PROXY (or newly seeded CA
 * material) into squid means a new container from the same image.
 */
export async function recreateMavenCache(input: {
  upstreamProxy: string;
  caCertPem: string;
  caKeyPem: string;
}): Promise<{ name: string; upstreamProxy: string | null; ca: string | null }> {
  const { configured } = await distributeCaMaterial(
    input.caCertPem,
    input.caKeyPem
  );

  const existing = await findSidecar();
  if (!existing) {
    throw notFound("maven-cache container not found — is the service running?");
  }
  const container = docker.getContainer(existing.Id);
  const inspect = await container.inspect();

  const target = input.upstreamProxy.trim();
  const env = (inspect.Config?.Env ?? []).filter(
    (line) => !line.startsWith("UPSTREAM_PROXY=")
  );
  if (target) env.push(`UPSTREAM_PROXY=${target}`);

  const oldName = inspect.Name.replace(/^\//, "");
  const networkSettings = inspect.NetworkSettings?.Networks ?? {};
  const networkName = Object.keys(networkSettings)[0] ?? "cofemine_mcnet";
  // Preserve the service alias so MC containers keep resolving
  // `maven-cache` after a recreate.
  const rawAliases: string[] =
    (networkSettings[networkName] as { Aliases?: string[] } | undefined)
      ?.Aliases ?? [];
  const aliases = rawAliases.filter(
    (a) => typeof a === "string" && !a.startsWith(inspect.Id.slice(0, 12))
  );
  if (!aliases.includes("maven-cache")) aliases.push("maven-cache");

  const hostConfig = inspect.HostConfig ?? {};
  // Drop a pre-split bind of the legacy volume: it no longer carries a
  // key, so leaving it at /etc/cofemine/ca silently puts squid into
  // splice-only mode.
  const binds = (hostConfig.Binds ?? []).filter(
    (b) => !b.startsWith(`${CA_LEGACY_VOLUME_NAME}:`)
  );
  if (!binds.some((b) => b.startsWith(`${CA_KEY_VOLUME_NAME}:`))) {
    binds.push(`${CA_KEY_VOLUME_NAME}:/etc/cofemine/ca:ro`);
  }
  hostConfig.Binds = binds;

  try {
    await container.stop({ t: 5 });
  } catch (err) {
    if ((err as { statusCode?: number })?.statusCode !== 304) throw err;
  }
  await container.remove({ force: true });

  // Image *tag* rather than the resolved sha: a local rebuild garbage
  // collects the old sha and the recreate would fail with "no such image".
  const imageRef =
    inspect.Config?.Image && inspect.Config.Image.length > 0
      ? inspect.Config.Image
      : inspect.Image;
  const created = await docker.createContainer({
    name: oldName,
    Image: imageRef,
    Env: env,
    ExposedPorts: inspect.Config?.ExposedPorts ?? {},
    Labels: inspect.Config?.Labels ?? {},
    HostConfig: hostConfig,
    NetworkingConfig: {
      EndpointsConfig: { [networkName]: { Aliases: aliases } },
    },
  });
  await created.start();

  return {
    name: oldName,
    upstreamProxy: target || null,
    ca: configured ? "configured" : null,
  };
}

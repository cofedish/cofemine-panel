import type { ContainerCreateOptions } from "dockerode";
import { config } from "../config.js";
import type {
  MinecraftRuntimeProvider,
  ServerSpec,
} from "./runtime-provider.js";

const IMAGE = process.env.AGENT_MC_IMAGE ?? "itzg/minecraft-server:latest";

/**
 * Resolve the itzg image tag for a given Java major version. itzg
 * publishes pre-baked variants (`:java8`, `:java17`, `:java21`,
 * `:java21-graalvm`, etc.) that boot much faster than asking the
 * `:latest` image to install Java on first start. We map only the
 * versions we expose in the wizard dropdown — anything else falls
 * back to the agent-default IMAGE so a brand-new MC version can run
 * before the panel learns about its Java requirement.
 *
 * Without this, the user's modpack on MC 1.20.1 was crashing at
 * boot because :latest currently ships Java 25, and spark's async
 * profiler's native lib SIGSEGVs on it.
 */
function imageForJavaHint(hint: string | undefined): string {
  if (!hint || hint === "auto") return IMAGE;
  switch (hint) {
    case "8":
      return "itzg/minecraft-server:java8";
    case "11":
      return "itzg/minecraft-server:java11";
    case "17":
      return "itzg/minecraft-server:java17";
    case "21":
      return "itzg/minecraft-server:java21";
    default:
      return IMAGE;
  }
}

/** Map our abstract types onto itzg's TYPE env. */
const TYPE_MAP: Record<string, string> = {
  VANILLA: "VANILLA",
  PAPER: "PAPER",
  PURPUR: "PURPUR",
  FABRIC: "FABRIC",
  FORGE: "FORGE",
  NEOFORGE: "NEOFORGE",
  MOHIST: "MOHIST",
  QUILT: "QUILT",
  // Modpack sources — itzg figures out loader + MC version from the pack
  // and sets up mods/ + world accordingly.
  MODRINTH: "MODRINTH",
  CURSEFORGE: "AUTO_CURSEFORGE",
};

export class ItzgRuntimeProvider implements MinecraftRuntimeProvider {
  readonly key = "itzg";

  createContainerSpec(spec: ServerSpec, dataPath: string): ContainerCreateOptions {
    // Install-phase retry knobs for mc-image-helper. Only matters for
    // modpack-source types (Modrinth / CurseForge) where the helper
    // downloads hundreds of jars and any one of them can time out on a
    // flaky CDN — each retry resumes without redownloading files that
    // already landed on /data. Defaults (server env) win over the
    // agent-level defaults.
    const installRetryDefaults: Record<string, string> =
      spec.type === "MODRINTH" || spec.type === "CURSEFORGE"
        ? {
            MAX_RETRIES: config.AGENT_MC_MAX_RETRIES,
            RETRY_BACKOFF: config.AGENT_MC_RETRY_BACKOFF,
          }
        : {};

    const envMap: Record<string, string> = {
      EULA: spec.eulaAccepted ? "TRUE" : "FALSE",
      TYPE: TYPE_MAP[spec.type] ?? "VANILLA",
      VERSION: spec.version,
      MEMORY: `${spec.memoryMb}M`,
      ENABLE_RCON: "true",
      RCON_PASSWORD: `rcon-${spec.id}`,
      ...installRetryDefaults,
      ...spec.env,
    };
    // The Java-version hint is panel-internal — we strip it from the
    // env passed to itzg below, but read it here first to decide
    // which image variant to start the container with.
    const javaImage = imageForJavaHint(spec.env.__COFEMINE_JAVA_VERSION);
    // Panel-internal state flags that should never leak into the itzg
    // container. Used for bookkeeping (e.g. "use install proxy") and
    // consumed by the API before hitting the agent.
    for (const k of Object.keys(envMap)) {
      if (k.startsWith("__COFEMINE_")) delete envMap[k];
    }
    const env = Object.entries(envMap).map(([k, v]) => `${k}=${v}`);

    const portBindings: Record<string, Array<{ HostPort: string }>> = {};
    const exposed: Record<string, Record<string, never>> = {};
    for (const p of spec.ports) {
      const key = `${p.container}/${p.protocol}`;
      exposed[key] = {};
      portBindings[key] = [{ HostPort: String(p.host) }];
    }

    // Container memory limit needs headroom on top of the JVM heap.
    // The user-facing "memory" knob feeds itzg's MEMORY env, which
    // becomes Xms/Xmx — pure heap. JVM also needs space for the
    // native side: metaspace (Forge mod classes can take 1-2 GB on
    // big modpacks), JIT code cache, GC bookkeeping, off-heap
    // allocations (NIO buffers, tons of mods use Unsafe), thread
    // stacks. Without headroom the kernel cgroup-OOMs the process
    // the moment heap + native crosses the limit — exactly the
    // exit-137 the user just hit.
    //
    // Heuristic: 25% of heap, capped at 4 GB and floored at 1 GB.
    // For 16 GB heap → 4 GB headroom → 20 GB container limit. For
    // 1 GB toy server → 1 GB headroom → 2 GB container.
    const headroomMb = Math.max(
      1024,
      Math.min(4096, Math.floor(spec.memoryMb * 0.25))
    );
    const containerMemoryMb = spec.memoryMb + headroomMb;
    const hostConfig: ContainerCreateOptions["HostConfig"] = {
      Binds: [`${dataPath}:/data`],
      PortBindings: portBindings,
      RestartPolicy: { Name: "unless-stopped" },
      Memory: containerMemoryMb * 1024 * 1024,
      // Pin swap to memory so the kernel can't swap-thrash the JVM
      // — disk-backed swap would tank tick rate before OOM-killing.
      MemorySwap: containerMemoryMb * 1024 * 1024,
      NetworkMode: config.AGENT_DOCKER_NETWORK,
      // Make `host.docker.internal` resolve to the docker host's
      // gateway IP from inside the MC container, regardless of which
      // custom bridge network the container ends up on. Without this,
      // a download-proxy running on the host that the user pointed
      // at via 127.0.0.1 / 172.17.0.1 / etc. is unreachable from
      // cofemine_mcnet — those addresses belong to default bridge,
      // not ours. The user's panel-configured proxy host is rewritten
      // to host.docker.internal in materializeEnv when it looks
      // loopbacky, so the JVM tunnels into the host correctly.
      ExtraHosts: ["host.docker.internal:host-gateway"],
    };
    if (spec.cpuLimit) {
      hostConfig.NanoCpus = Math.floor(spec.cpuLimit * 1e9);
    }

    const labels: Record<string, string> = {
      [`${config.AGENT_LABEL_PREFIX}.managed`]: "true",
      [`${config.AGENT_LABEL_PREFIX}.serverId`]: spec.id,
      [`${config.AGENT_LABEL_PREFIX}.name`]: spec.name,
      [`${config.AGENT_LABEL_PREFIX}.type`]: spec.type,
      [`${config.AGENT_LABEL_PREFIX}.version`]: spec.version,
    };

    return {
      name: spec.containerName,
      Image: javaImage,
      Env: env,
      ExposedPorts: exposed,
      Tty: false,
      OpenStdin: true,
      StdinOnce: false,
      Labels: labels,
      HostConfig: hostConfig,
    };
  }
}

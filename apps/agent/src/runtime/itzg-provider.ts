import type { ContainerCreateOptions } from "dockerode";
import { config } from "../config.js";
import type {
  MinecraftRuntimeProvider,
  ServerSpec,
} from "./runtime-provider.js";

const IMAGE = process.env.AGENT_MC_IMAGE ?? "itzg/minecraft-server:latest";

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

    const hostConfig: ContainerCreateOptions["HostConfig"] = {
      Binds: [`${dataPath}:/data`],
      PortBindings: portBindings,
      RestartPolicy: { Name: "unless-stopped" },
      Memory: spec.memoryMb * 1024 * 1024,
      NetworkMode: config.AGENT_DOCKER_NETWORK,
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
      Image: IMAGE,
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

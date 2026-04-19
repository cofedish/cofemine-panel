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
};

export class ItzgRuntimeProvider implements MinecraftRuntimeProvider {
  readonly key = "itzg";

  createContainerSpec(spec: ServerSpec, dataPath: string): ContainerCreateOptions {
    const envMap: Record<string, string> = {
      EULA: spec.eulaAccepted ? "TRUE" : "FALSE",
      TYPE: TYPE_MAP[spec.type] ?? "VANILLA",
      VERSION: spec.version,
      MEMORY: `${spec.memoryMb}M`,
      ENABLE_RCON: "true",
      RCON_PASSWORD: `rcon-${spec.id}`,
      ...spec.env,
    };
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

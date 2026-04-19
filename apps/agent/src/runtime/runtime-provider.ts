import type { ContainerCreateOptions } from "dockerode";

/** Incoming server definition from the panel-api. */
export interface ServerSpec {
  id: string;
  name: string;
  containerName: string;
  type: string;
  version: string;
  memoryMb: number;
  cpuLimit?: number | null;
  ports: Array<{ host: number; container: number; protocol: "tcp" | "udp" }>;
  env: Record<string, string>;
  eulaAccepted: boolean;
}

/**
 * A MinecraftRuntimeProvider translates an abstract ServerSpec into Docker
 * operations. Implementations are free to use different base images; the
 * default is `itzg/minecraft-server`.
 */
export interface MinecraftRuntimeProvider {
  readonly key: string;
  createContainerSpec(
    spec: ServerSpec,
    dataPath: string
  ): ContainerCreateOptions;
  /** Optional hook run right after the container is created. */
  postCreate?(spec: ServerSpec, dataPath: string): Promise<void>;
}

/**
 * Supported Minecraft server types. These map to the `TYPE` env var of
 * the itzg/minecraft-server image, but are represented here as an abstract
 * enum so non-itzg runtimes can map them too.
 */
export const SERVER_TYPES = [
  "VANILLA",
  "PAPER",
  "PURPUR",
  "FABRIC",
  "FORGE",
  "NEOFORGE",
  "MOHIST",
  "QUILT",
] as const;
export type ServerType = (typeof SERVER_TYPES)[number];

export const SERVER_TYPE_LOADERS: Record<ServerType, string[]> = {
  VANILLA: [],
  PAPER: ["paper"],
  PURPUR: ["purpur"],
  FABRIC: ["fabric"],
  FORGE: ["forge"],
  NEOFORGE: ["neoforge"],
  MOHIST: ["forge"],
  QUILT: ["quilt", "fabric"],
};

export const SERVER_STATUS = [
  "stopped",
  "starting",
  "running",
  "stopping",
  "crashed",
  "unknown",
] as const;
export type ServerStatus = (typeof SERVER_STATUS)[number];

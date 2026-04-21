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
  /**
   * Modpack sources — user picks a pack, the runtime detects loader +
   * game version from the pack metadata automatically. TYPE env var on
   * the container becomes MODRINTH / AUTO_CURSEFORGE respectively.
   */
  "MODRINTH",
  "CURSEFORGE",
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
  MODRINTH: [],
  CURSEFORGE: [],
};

/** Types whose loader + MC version are inferred from the pack itself. */
export const MODPACK_SOURCE_TYPES = ["MODRINTH", "CURSEFORGE"] as const;
export const isModpackSource = (t: string): boolean =>
  (MODPACK_SOURCE_TYPES as readonly string[]).includes(t);

export const SERVER_STATUS = [
  "stopped",
  "starting",
  "running",
  "stopping",
  "crashed",
  "unknown",
] as const;
export type ServerStatus = (typeof SERVER_STATUS)[number];

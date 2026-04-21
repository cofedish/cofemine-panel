/**
 * Typed metadata for the ~40 most-used keys in server.properties.
 * The UI reads from here to render proper controls: booleans as toggles,
 * enums as selects, numbers with ranges, strings with hints.
 *
 * Reference: https://minecraft.wiki/w/Server.properties
 */

export type PropertyGroup =
  | "world"
  | "gameplay"
  | "players"
  | "network"
  | "security"
  | "performance";

export type PropertyDef =
  | {
      key: string;
      label: string;
      help?: string;
      type: "boolean";
      default: boolean;
      group: PropertyGroup;
    }
  | {
      key: string;
      label: string;
      help?: string;
      type: "number";
      min?: number;
      max?: number;
      step?: number;
      default: number;
      group: PropertyGroup;
    }
  | {
      key: string;
      label: string;
      help?: string;
      type: "enum";
      options: string[];
      default: string;
      group: PropertyGroup;
    }
  | {
      key: string;
      label: string;
      help?: string;
      type: "string";
      default?: string;
      monospace?: boolean;
      long?: boolean;
      group: PropertyGroup;
    };

export const GROUP_LABELS: Record<PropertyGroup, string> = {
  world: "World",
  gameplay: "Gameplay",
  players: "Players",
  network: "Network & RCON",
  security: "Security",
  performance: "Performance",
};

export const PROPERTY_DEFS: PropertyDef[] = [
  // ---- World ----
  {
    key: "level-name",
    label: "World name",
    type: "string",
    default: "world",
    group: "world",
  },
  {
    key: "level-seed",
    label: "World seed",
    help: "Leave blank for random.",
    type: "string",
    monospace: true,
    group: "world",
  },
  {
    key: "level-type",
    label: "World type",
    type: "enum",
    options: [
      "minecraft:normal",
      "minecraft:flat",
      "minecraft:large_biomes",
      "minecraft:amplified",
      "minecraft:single_biome_surface",
    ],
    default: "minecraft:normal",
    group: "world",
  },
  {
    key: "generate-structures",
    label: "Generate structures",
    help: "Villages, strongholds, etc.",
    type: "boolean",
    default: true,
    group: "world",
  },
  {
    key: "max-world-size",
    label: "Max world size",
    type: "number",
    min: 1,
    max: 29999984,
    default: 29999984,
    group: "world",
  },
  {
    key: "view-distance",
    label: "View distance",
    help: "Chunks loaded around each player.",
    type: "number",
    min: 3,
    max: 32,
    default: 10,
    group: "world",
  },
  {
    key: "simulation-distance",
    label: "Simulation distance",
    type: "number",
    min: 3,
    max: 32,
    default: 10,
    group: "world",
  },
  {
    key: "spawn-protection",
    label: "Spawn protection radius",
    help: "0 disables protection around spawn.",
    type: "number",
    min: 0,
    max: 64,
    default: 16,
    group: "world",
  },

  // ---- Gameplay ----
  {
    key: "gamemode",
    label: "Default gamemode",
    type: "enum",
    options: ["survival", "creative", "adventure", "spectator"],
    default: "survival",
    group: "gameplay",
  },
  {
    key: "difficulty",
    label: "Difficulty",
    type: "enum",
    options: ["peaceful", "easy", "normal", "hard"],
    default: "normal",
    group: "gameplay",
  },
  {
    key: "hardcore",
    label: "Hardcore",
    help: "Players are banned on death.",
    type: "boolean",
    default: false,
    group: "gameplay",
  },
  {
    key: "pvp",
    label: "PvP",
    type: "boolean",
    default: true,
    group: "gameplay",
  },
  {
    key: "spawn-animals",
    label: "Spawn animals",
    type: "boolean",
    default: true,
    group: "gameplay",
  },
  {
    key: "spawn-monsters",
    label: "Spawn monsters",
    type: "boolean",
    default: true,
    group: "gameplay",
  },
  {
    key: "spawn-npcs",
    label: "Spawn villagers",
    type: "boolean",
    default: true,
    group: "gameplay",
  },
  {
    key: "allow-flight",
    label: "Allow flight",
    help: "Let players fly without being kicked (for plugins, etc.)",
    type: "boolean",
    default: false,
    group: "gameplay",
  },
  {
    key: "allow-nether",
    label: "Allow Nether",
    type: "boolean",
    default: true,
    group: "gameplay",
  },
  {
    key: "force-gamemode",
    label: "Force gamemode on join",
    type: "boolean",
    default: false,
    group: "gameplay",
  },
  {
    key: "enable-command-block",
    label: "Enable command blocks",
    type: "boolean",
    default: false,
    group: "gameplay",
  },

  // ---- Players ----
  {
    key: "max-players",
    label: "Max players",
    type: "number",
    min: 1,
    max: 2147483647,
    default: 20,
    group: "players",
  },
  {
    key: "motd",
    label: "Message of the day",
    help: "Shown in the server list. Supports § colour codes.",
    type: "string",
    long: true,
    default: "A Minecraft Server",
    group: "players",
  },
  {
    key: "white-list",
    label: "Whitelist enabled",
    type: "boolean",
    default: false,
    group: "players",
  },
  {
    key: "enforce-whitelist",
    label: "Enforce whitelist",
    help: "Kick non-whitelisted players on reload.",
    type: "boolean",
    default: false,
    group: "players",
  },
  {
    key: "online-mode",
    label: "Online mode",
    help: "Verify player accounts against Mojang. Disabling allows cracked clients.",
    type: "boolean",
    default: true,
    group: "players",
  },
  {
    key: "player-idle-timeout",
    label: "Idle timeout (minutes)",
    help: "0 = never kick.",
    type: "number",
    min: 0,
    max: 10080,
    default: 0,
    group: "players",
  },
  {
    key: "op-permission-level",
    label: "OP permission level",
    help: "1 = bypass spawn, 2 = cheats, 3 = multiplayer-ops, 4 = server-ops.",
    type: "enum",
    options: ["1", "2", "3", "4"],
    default: "4",
    group: "players",
  },

  // ---- Network & RCON ----
  {
    key: "server-port",
    label: "Server port",
    type: "number",
    min: 1,
    max: 65535,
    default: 25565,
    group: "network",
  },
  {
    key: "server-ip",
    label: "Bind address",
    help: "Leave blank to bind on all interfaces.",
    type: "string",
    monospace: true,
    group: "network",
  },
  {
    key: "enable-query",
    label: "Enable query protocol",
    type: "boolean",
    default: false,
    group: "network",
  },
  {
    key: "query.port",
    label: "Query port",
    type: "number",
    min: 1,
    max: 65535,
    default: 25565,
    group: "network",
  },
  {
    key: "enable-rcon",
    label: "Enable RCON",
    help: "Panel uses RCON for console commands. Disabling breaks the Console tab.",
    type: "boolean",
    default: true,
    group: "network",
  },
  {
    key: "rcon.port",
    label: "RCON port",
    type: "number",
    min: 1,
    max: 65535,
    default: 25575,
    group: "network",
  },
  {
    key: "rcon.password",
    label: "RCON password",
    type: "string",
    monospace: true,
    group: "network",
  },
  {
    key: "network-compression-threshold",
    label: "Packet compression threshold",
    help: "Packets above this size are compressed. -1 disables.",
    type: "number",
    min: -1,
    max: 65535,
    default: 256,
    group: "network",
  },

  // ---- Security ----
  {
    key: "prevent-proxy-connections",
    label: "Block proxy connections",
    type: "boolean",
    default: false,
    group: "security",
  },
  {
    key: "enforce-secure-profile",
    label: "Enforce secure chat profile",
    type: "boolean",
    default: true,
    group: "security",
  },
  {
    key: "function-permission-level",
    label: "Datapack function perm level",
    type: "enum",
    options: ["1", "2", "3", "4"],
    default: "2",
    group: "security",
  },

  // ---- Performance ----
  {
    key: "sync-chunk-writes",
    label: "Sync chunk writes",
    help: "Slower but crash-safe. Disable only on reliable storage.",
    type: "boolean",
    default: true,
    group: "performance",
  },
  {
    key: "entity-broadcast-range-percentage",
    label: "Entity broadcast range %",
    type: "number",
    min: 10,
    max: 500,
    default: 100,
    group: "performance",
  },
  {
    key: "max-tick-time",
    label: "Max tick time (ms)",
    help: "-1 disables the watchdog.",
    type: "number",
    min: -1,
    max: 300000,
    default: 60000,
    group: "performance",
  },
  {
    key: "max-chained-neighbor-updates",
    label: "Max chained neighbor updates",
    type: "number",
    min: 0,
    max: 1000000,
    default: 1000000,
    group: "performance",
  },
];

export const DEFS_BY_GROUP = PROPERTY_DEFS.reduce<
  Record<PropertyGroup, PropertyDef[]>
>(
  (acc, d) => {
    (acc[d.group] ||= []).push(d);
    return acc;
  },
  {
    world: [],
    gameplay: [],
    players: [],
    network: [],
    security: [],
    performance: [],
  }
);

export const KNOWN_KEYS = new Set(PROPERTY_DEFS.map((d) => d.key));

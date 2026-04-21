/**
 * Typed metadata for itzg/minecraft-server container env vars. The wizard
 * uses this to render proper controls instead of a raw KEY=VALUE textbox.
 *
 * Source: https://docker-minecraft-server.readthedocs.io/en/latest/variables/
 * We cover the variables that are actually useful during initial server
 * creation; niche JVM/image plumbing stays in the "custom" fallback.
 */

export type EnvGroup = "gameplay" | "world" | "spawning" | "jvm" | "advanced";

export const ENV_GROUP_LABELS: Record<EnvGroup, string> = {
  gameplay: "Gameplay",
  world: "World & seed",
  spawning: "Spawning & entities",
  jvm: "JVM & runtime",
  advanced: "Advanced",
};

export type EnvDef =
  | {
      key: string;
      label: string;
      help?: string;
      type: "boolean";
      default?: boolean;
      group: EnvGroup;
    }
  | {
      key: string;
      label: string;
      help?: string;
      type: "number";
      min?: number;
      max?: number;
      step?: number;
      default?: number;
      group: EnvGroup;
    }
  | {
      key: string;
      label: string;
      help?: string;
      type: "enum";
      options: string[];
      default?: string;
      group: EnvGroup;
    }
  | {
      key: string;
      label: string;
      help?: string;
      type: "string";
      default?: string;
      monospace?: boolean;
      long?: boolean;
      group: EnvGroup;
    };

export const ENV_DEFS: EnvDef[] = [
  /* ------------------------- Gameplay ------------------------- */
  {
    key: "DIFFICULTY",
    label: "Difficulty",
    type: "enum",
    options: ["peaceful", "easy", "normal", "hard"],
    default: "normal",
    group: "gameplay",
  },
  {
    key: "MODE",
    label: "Default gamemode",
    type: "enum",
    options: ["survival", "creative", "adventure", "spectator"],
    default: "survival",
    group: "gameplay",
  },
  {
    key: "HARDCORE",
    label: "Hardcore",
    help: "Players get banned on death.",
    type: "boolean",
    default: false,
    group: "gameplay",
  },
  {
    key: "PVP",
    label: "PvP",
    type: "boolean",
    default: true,
    group: "gameplay",
  },
  {
    key: "MAX_PLAYERS",
    label: "Max players",
    type: "number",
    min: 1,
    max: 999,
    default: 20,
    group: "gameplay",
  },
  {
    key: "MOTD",
    label: "Message of the day",
    help: "Shown in the server list. Supports § colour codes.",
    type: "string",
    long: true,
    default: "A Minecraft Server",
    group: "gameplay",
  },
  {
    key: "ONLINE_MODE",
    label: "Online mode",
    help: "Require Mojang-authenticated clients. Disable to allow cracked clients.",
    type: "boolean",
    default: true,
    group: "gameplay",
  },
  {
    key: "WHITELIST",
    label: "Whitelist",
    help: "Comma-separated usernames. Leave blank to disable.",
    type: "string",
    monospace: true,
    group: "gameplay",
  },
  {
    key: "ENFORCE_WHITELIST",
    label: "Enforce whitelist",
    help: "Kick non-whitelisted players on reload.",
    type: "boolean",
    default: false,
    group: "gameplay",
  },
  {
    key: "OPS",
    label: "Server operators",
    help: "Comma-separated usernames granted OP on first boot.",
    type: "string",
    monospace: true,
    group: "gameplay",
  },
  {
    key: "ICON",
    label: "Server icon URL",
    help: "64x64 PNG that shows next to the MOTD in the server list.",
    type: "string",
    group: "gameplay",
  },

  /* ------------------------- World ------------------------- */
  {
    key: "LEVEL",
    label: "World folder name",
    type: "string",
    default: "world",
    group: "world",
  },
  {
    key: "SEED",
    label: "World seed",
    help: "Leave blank for random.",
    type: "string",
    monospace: true,
    group: "world",
  },
  {
    key: "LEVEL_TYPE",
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
    key: "GENERATE_STRUCTURES",
    label: "Generate structures",
    help: "Villages, strongholds, shipwrecks…",
    type: "boolean",
    default: true,
    group: "world",
  },
  {
    key: "VIEW_DISTANCE",
    label: "View distance",
    help: "Chunks loaded around each player.",
    type: "number",
    min: 3,
    max: 32,
    default: 10,
    group: "world",
  },
  {
    key: "SIMULATION_DISTANCE",
    label: "Simulation distance",
    type: "number",
    min: 3,
    max: 32,
    default: 10,
    group: "world",
  },
  {
    key: "SPAWN_PROTECTION",
    label: "Spawn protection",
    help: "Radius in blocks around spawn. 0 disables.",
    type: "number",
    min: 0,
    max: 64,
    default: 16,
    group: "world",
  },

  /* ------------------------- Spawning ------------------------- */
  {
    key: "SPAWN_ANIMALS",
    label: "Spawn animals",
    type: "boolean",
    default: true,
    group: "spawning",
  },
  {
    key: "SPAWN_MONSTERS",
    label: "Spawn monsters",
    type: "boolean",
    default: true,
    group: "spawning",
  },
  {
    key: "SPAWN_NPCS",
    label: "Spawn villagers",
    type: "boolean",
    default: true,
    group: "spawning",
  },
  {
    key: "ALLOW_FLIGHT",
    label: "Allow flight",
    help: "Prevents anti-fly kick. Needed for some plugins.",
    type: "boolean",
    default: false,
    group: "spawning",
  },
  {
    key: "ALLOW_NETHER",
    label: "Allow Nether",
    type: "boolean",
    default: true,
    group: "spawning",
  },
  {
    key: "FORCE_GAMEMODE",
    label: "Force gamemode on join",
    type: "boolean",
    default: false,
    group: "spawning",
  },
  {
    key: "ENABLE_COMMAND_BLOCK",
    label: "Enable command blocks",
    type: "boolean",
    default: false,
    group: "spawning",
  },

  /* ------------------------- JVM & runtime ------------------------- */
  {
    key: "USE_AIKAR_FLAGS",
    label: "Use Aikar's JVM flags",
    help: "Recommended GC tuning for Paper/Spigot servers ≥2 GB RAM.",
    type: "boolean",
    default: false,
    group: "jvm",
  },
  {
    key: "JVM_OPTS",
    label: "Extra JVM options",
    help: "Passed to java directly, e.g. -XX:+UseG1GC.",
    type: "string",
    monospace: true,
    long: true,
    group: "jvm",
  },
  {
    key: "TZ",
    label: "Timezone",
    help: "IANA TZ name, e.g. Europe/Moscow or America/New_York.",
    type: "string",
    default: "UTC",
    group: "jvm",
  },

  /* ------------------------- Advanced ------------------------- */
  {
    key: "NETWORK_COMPRESSION_THRESHOLD",
    label: "Packet compression threshold",
    help: "Packets above this size are compressed. -1 disables.",
    type: "number",
    min: -1,
    max: 65535,
    default: 256,
    group: "advanced",
  },
  {
    key: "SNOOPER_ENABLED",
    label: "Snooper telemetry",
    type: "boolean",
    default: false,
    group: "advanced",
  },
];

export const ENV_DEFS_BY_GROUP = ENV_DEFS.reduce<Record<EnvGroup, EnvDef[]>>(
  (acc, d) => {
    (acc[d.group] ||= []).push(d);
    return acc;
  },
  { gameplay: [], world: [], spawning: [], jvm: [], advanced: [] }
);

export const ENV_KNOWN_KEYS = new Set(ENV_DEFS.map((d) => d.key));

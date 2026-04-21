/**
 * Typed metadata for itzg/minecraft-server container env vars.
 * Source: https://docker-minecraft-server.readthedocs.io/en/latest/variables/
 *
 * Covers ~90 settings across many groups — the subset that is actually
 * useful for end-users creating/managing servers. Excluded:
 * - panel-managed vars (EULA, TYPE, VERSION, MEMORY, ENABLE_RCON,
 *   RCON_PASSWORD) — these come from the wizard/runtime, not the form
 * - niche image plumbing that shouldn't be exposed casually
 *
 * The form can filter by current server type (`appliesTo` + type-specific
 * groups) so Paper-only vars don't clutter a Fabric wizard.
 */

export type EnvGroup =
  | "gameplay"
  | "world"
  | "spawning"
  | "players"
  | "resource-pack"
  | "network"
  | "rcon"
  | "security"
  | "performance"
  | "jvm"
  | "modpack"
  | "lifecycle"
  | "proxy"
  | "paper"
  | "purpur"
  | "forge"
  | "neoforge"
  | "fabric"
  | "quilt"
  | "mohist"
  | "advanced";

export const ENV_GROUP_LABELS: Record<EnvGroup, string> = {
  gameplay: "Gameplay",
  world: "World & seed",
  spawning: "Spawning & entities",
  players: "Players & ops",
  "resource-pack": "Resource pack",
  network: "Network",
  rcon: "RCON & query",
  security: "Security",
  performance: "Performance",
  jvm: "JVM & runtime",
  modpack: "Modpack sources",
  lifecycle: "Lifecycle",
  proxy: "Proxy (BungeeCord/Velocity)",
  paper: "Paper options",
  purpur: "Purpur options",
  forge: "Forge options",
  neoforge: "NeoForge options",
  fabric: "Fabric options",
  quilt: "Quilt options",
  mohist: "Mohist options",
  advanced: "Advanced",
};

export const ENV_GROUP_ORDER: EnvGroup[] = [
  "gameplay",
  "world",
  "spawning",
  "players",
  "resource-pack",
  "network",
  "rcon",
  "security",
  "performance",
  "jvm",
  "modpack",
  "lifecycle",
  "proxy",
  "paper",
  "purpur",
  "forge",
  "neoforge",
  "fabric",
  "quilt",
  "mohist",
  "advanced",
];

/** Shown open by default (others start collapsed). */
export const ENV_DEFAULT_OPEN: EnvGroup[] = ["gameplay"];

type Common = {
  key: string;
  label: string;
  help?: string;
  group: EnvGroup;
  /** Optional filter: only show when current server type is in this list. */
  appliesTo?: readonly string[];
};

export type EnvDef =
  | (Common & { type: "boolean"; default?: boolean })
  | (Common & {
      type: "number";
      min?: number;
      max?: number;
      step?: number;
      default?: number;
    })
  | (Common & { type: "enum"; options: string[]; default?: string })
  | (Common & {
      type: "string";
      default?: string;
      monospace?: boolean;
      long?: boolean;
      placeholder?: string;
    });

export const ENV_DEFS: EnvDef[] = [
  /* ============================= GAMEPLAY ============================= */
  { key: "DIFFICULTY", label: "Difficulty", type: "enum", options: ["peaceful", "easy", "normal", "hard"], default: "normal", group: "gameplay" },
  { key: "MODE", label: "Default gamemode", type: "enum", options: ["survival", "creative", "adventure", "spectator"], default: "survival", group: "gameplay" },
  { key: "HARDCORE", label: "Hardcore", help: "Players get banned on death.", type: "boolean", default: false, group: "gameplay" },
  { key: "PVP", label: "PvP", type: "boolean", default: true, group: "gameplay" },
  { key: "MAX_PLAYERS", label: "Max players", type: "number", min: 1, max: 999, default: 20, group: "gameplay" },
  { key: "MOTD", label: "Message of the day", help: "Shown in the server list. Supports § colour codes.", type: "string", long: true, default: "A Minecraft Server", group: "gameplay" },
  { key: "ONLINE_MODE", label: "Online mode", help: "Require Mojang-authenticated clients. Disable for cracked clients.", type: "boolean", default: true, group: "gameplay" },
  { key: "ALLOW_FLIGHT", label: "Allow flight", help: "Prevents anti-fly kick. Required for some plugins.", type: "boolean", default: false, group: "gameplay" },
  { key: "ALLOW_NETHER", label: "Allow Nether", type: "boolean", default: true, group: "gameplay" },
  { key: "FORCE_GAMEMODE", label: "Force gamemode on join", type: "boolean", default: false, group: "gameplay" },
  { key: "ENABLE_COMMAND_BLOCK", label: "Enable command blocks", type: "boolean", default: false, group: "gameplay" },
  { key: "ICON", label: "Server icon URL", help: "64x64 PNG shown next to MOTD in the server list.", type: "string", group: "gameplay" },
  { key: "OVERRIDE_ICON", label: "Override existing icon", type: "boolean", default: false, group: "gameplay" },
  { key: "PAUSE_WHEN_EMPTY_SECONDS", label: "Pause when empty (seconds)", help: "Server pauses if no players for N seconds. 0 disables.", type: "number", min: 0, max: 86400, default: 0, group: "gameplay" },

  /* ============================== WORLD =============================== */
  { key: "LEVEL", label: "World folder name", type: "string", default: "world", group: "world" },
  { key: "WORLD", label: "World source URL/path", help: "When set, downloads and seeds the world from a ZIP or tar archive.", type: "string", monospace: true, group: "world" },
  { key: "FORCE_WORLD_COPY", label: "Force re-copy world on every start", help: "Useful for short-lived / reset-on-restart servers.", type: "boolean", default: false, group: "world" },
  { key: "SEED", label: "World seed", help: "Leave blank for random.", type: "string", monospace: true, group: "world" },
  { key: "LEVEL_TYPE", label: "World type", type: "enum", options: ["minecraft:normal", "minecraft:flat", "minecraft:large_biomes", "minecraft:amplified", "minecraft:single_biome_surface"], default: "minecraft:normal", group: "world" },
  { key: "GENERATOR_SETTINGS", label: "Generator settings (JSON)", help: "Custom generator JSON; most users leave blank.", type: "string", monospace: true, long: true, group: "world" },
  { key: "GENERATE_STRUCTURES", label: "Generate structures", help: "Villages, strongholds, shipwrecks…", type: "boolean", default: true, group: "world" },
  { key: "VIEW_DISTANCE", label: "View distance", help: "Chunks loaded around each player (vanilla default 10).", type: "number", min: 3, max: 32, default: 10, group: "world" },
  { key: "SIMULATION_DISTANCE", label: "Simulation distance", type: "number", min: 3, max: 32, default: 10, group: "world" },
  { key: "SPAWN_PROTECTION", label: "Spawn protection", help: "Radius in blocks around spawn. 0 disables.", type: "number", min: 0, max: 64, default: 16, group: "world" },
  { key: "MAX_BUILD_HEIGHT", label: "Max build height", type: "number", min: 64, max: 2032, default: 256, group: "world" },
  { key: "MAX_WORLD_SIZE", label: "Max world size (radius)", type: "number", min: 1, max: 29999984, default: 29999984, group: "world" },

  /* ============================ SPAWNING ============================== */
  { key: "SPAWN_ANIMALS", label: "Spawn animals", type: "boolean", default: true, group: "spawning" },
  { key: "SPAWN_MONSTERS", label: "Spawn monsters", type: "boolean", default: true, group: "spawning" },
  { key: "SPAWN_NPCS", label: "Spawn villagers", type: "boolean", default: true, group: "spawning" },
  { key: "ENTITY_BROADCAST_RANGE_PERCENTAGE", label: "Entity broadcast range %", help: "Lower values reduce network traffic for distant entities.", type: "number", min: 10, max: 500, default: 100, group: "spawning" },

  /* ============================= PLAYERS ============================== */
  { key: "OPS", label: "Server operators", help: "Comma-separated usernames granted OP on first boot.", type: "string", monospace: true, group: "players" },
  { key: "OVERRIDE_OPS", label: "Override existing ops.json", type: "boolean", default: false, group: "players" },
  { key: "OP_PERMISSION_LEVEL", label: "OP permission level", help: "1 = spawn-bypass, 2 = cheats, 3 = multiplayer-ops, 4 = server-ops.", type: "enum", options: ["1", "2", "3", "4"], default: "4", group: "players" },
  { key: "FUNCTION_PERMISSION_LEVEL", label: "Datapack function permission level", type: "enum", options: ["1", "2", "3", "4"], default: "2", group: "players" },
  { key: "WHITELIST", label: "Whitelist", help: "Comma-separated usernames. Empty = disabled.", type: "string", monospace: true, group: "players" },
  { key: "OVERRIDE_WHITELIST", label: "Override existing whitelist.json", type: "boolean", default: false, group: "players" },
  { key: "ENFORCE_WHITELIST", label: "Enforce whitelist", help: "Kick non-whitelisted players on reload.", type: "boolean", default: false, group: "players" },
  { key: "PLAYER_IDLE_TIMEOUT", label: "Idle kick timeout (minutes)", help: "0 = never kick.", type: "number", min: 0, max: 10080, default: 0, group: "players" },

  /* ========================== RESOURCE PACK =========================== */
  { key: "RESOURCE_PACK", label: "Resource pack URL", type: "string", monospace: true, group: "resource-pack" },
  { key: "RESOURCE_PACK_SHA1", label: "Resource pack SHA1", help: "Optional but recommended — clients verify integrity.", type: "string", monospace: true, group: "resource-pack" },
  { key: "RESOURCE_PACK_PROMPT", label: "Prompt message", type: "string", long: true, group: "resource-pack" },
  { key: "RESOURCE_PACK_ENFORCE", label: "Require pack", help: "Kick clients that reject the pack.", type: "boolean", default: false, group: "resource-pack" },

  /* ============================= NETWORK ============================== */
  { key: "SERVER_NAME", label: "Server name", type: "string", group: "network" },
  { key: "SERVER_IP", label: "Bind IP", help: "Interface the JVM binds to. Leave blank for all.", type: "string", monospace: true, group: "network" },
  { key: "NETWORK_COMPRESSION_THRESHOLD", label: "Compression threshold (bytes)", help: "Packets above this size are compressed. -1 disables.", type: "number", min: -1, max: 65535, default: 256, group: "network" },
  { key: "USE_NATIVE_TRANSPORT", label: "Use native transport (epoll)", help: "Faster on Linux hosts.", type: "boolean", default: true, group: "network" },
  { key: "PREVENT_PROXY_CONNECTIONS", label: "Block proxy connections", type: "boolean", default: false, group: "network" },
  { key: "RATE_LIMIT", label: "Rate limit (packets/sec)", help: "0 disables.", type: "number", min: 0, max: 1000000, default: 0, group: "network" },

  /* =========================== RCON & QUERY =========================== */
  { key: "RCON_PORT", label: "RCON port", type: "number", min: 1, max: 65535, default: 25575, group: "rcon" },
  { key: "BROADCAST_RCON_TO_OPS", label: "Broadcast RCON commands to ops", type: "boolean", default: true, group: "rcon" },
  { key: "BROADCAST_CONSOLE_TO_OPS", label: "Broadcast console messages to ops", type: "boolean", default: true, group: "rcon" },
  { key: "ENABLE_QUERY", label: "Enable query protocol", help: "Used by external monitoring tools (GameTracker etc).", type: "boolean", default: false, group: "rcon" },
  { key: "QUERY_PORT", label: "Query port", type: "number", min: 1, max: 65535, default: 25565, group: "rcon" },
  { key: "ENABLE_STATUS", label: "Respond to status pings", help: "Lets clients see your MOTD in the server list.", type: "boolean", default: true, group: "rcon" },
  { key: "HIDE_ONLINE_PLAYERS", label: "Hide online players", type: "boolean", default: false, group: "rcon" },

  /* ============================= SECURITY ============================= */
  { key: "ENFORCE_SECURE_PROFILE", label: "Enforce secure chat profile", type: "boolean", default: true, group: "security" },
  { key: "LOG_IPS", label: "Log player IPs", type: "boolean", default: true, group: "security" },
  { key: "TEXT_FILTERING_CONFIG", label: "Text-filtering service config", type: "string", monospace: true, group: "security" },
  { key: "PACKET_SIZE_LIMIT", label: "Max packet size (KB)", type: "number", min: 8, max: 16384, default: 2048, group: "security" },

  /* =========================== PERFORMANCE ============================ */
  { key: "SYNC_CHUNK_WRITES", label: "Sync chunk writes", help: "Slower but crash-safe. Disable only on reliable storage.", type: "boolean", default: true, group: "performance" },
  { key: "MAX_TICK_TIME", label: "Max tick time (ms)", help: "-1 disables watchdog.", type: "number", min: -1, max: 300000, default: 60000, group: "performance" },
  { key: "MAX_CHAINED_NEIGHBOR_UPDATES", label: "Max chained neighbor updates", type: "number", min: 0, max: 1000000, default: 1000000, group: "performance" },
  { key: "REGION_FILE_COMPRESSION", label: "Region file compression", type: "enum", options: ["deflate", "lz4", "none"], default: "deflate", group: "performance" },
  { key: "PLAYER_MOVEMENT_VELOCITY_CHECK", label: "Movement velocity check", type: "boolean", default: true, group: "performance" },

  /* ============================== JVM ================================= */
  { key: "INIT_MEMORY", label: "Initial heap (-Xms)", help: "e.g. 512M, 2G. Leave blank to use MEMORY.", type: "string", monospace: true, group: "jvm" },
  { key: "MAX_MEMORY", label: "Max heap (-Xmx)", help: "Overrides MEMORY. e.g. 4G.", type: "string", monospace: true, group: "jvm" },
  { key: "USE_AIKAR_FLAGS", label: "Use Aikar's JVM flags", help: "Recommended GC tuning for Paper/Spigot-based servers ≥ 2 GB RAM.", type: "boolean", default: false, group: "jvm" },
  { key: "USE_MEOWICE_FLAGS", label: "Use MeowIce's JVM flags", help: "Alternative GC tuning. Newer, aggressive.", type: "boolean", default: false, group: "jvm" },
  { key: "JVM_OPTS", label: "Extra JVM options", help: "Passed to java directly.", type: "string", monospace: true, long: true, group: "jvm" },
  { key: "JVM_XX_OPTS", label: "Extra -XX: options", type: "string", monospace: true, long: true, group: "jvm" },
  { key: "JVM_DD_OPTS", label: "Extra -D system properties", help: "key=value,key=value", type: "string", monospace: true, long: true, group: "jvm" },
  { key: "LOG4J2_XML", label: "Custom log4j2 XML path", type: "string", monospace: true, group: "jvm" },
  { key: "TZ", label: "Timezone", help: "IANA TZ, e.g. Europe/Moscow.", type: "string", default: "UTC", group: "jvm" },
  { key: "UID", label: "Run as UID", type: "number", min: 0, max: 65535, default: 1000, group: "jvm" },
  { key: "GID", label: "Run as GID", type: "number", min: 0, max: 65535, default: 1000, group: "jvm" },

  /* ============================= MODPACK ============================== */
  { key: "MODRINTH_PROJECT", label: "Modrinth project", help: "Slug, ID, or direct version URL. Auto-detects loader+version.", type: "string", monospace: true, group: "modpack", appliesTo: ["MODRINTH"] },
  { key: "MODRINTH_VERSION", label: "Modrinth version override", type: "string", monospace: true, group: "modpack", appliesTo: ["MODRINTH"] },
  { key: "CF_PAGE_URL", label: "CurseForge page URL", type: "string", monospace: true, group: "modpack", appliesTo: ["CURSEFORGE"] },
  { key: "CF_SLUG", label: "CurseForge slug", type: "string", monospace: true, group: "modpack", appliesTo: ["CURSEFORGE"] },
  { key: "CF_FILE_ID", label: "CurseForge file ID", help: "Pins a specific modpack release.", type: "string", monospace: true, group: "modpack", appliesTo: ["CURSEFORGE"] },
  { key: "CF_EXCLUDE_INCLUDE_FILE", label: "CF exclude/include file", help: "Advanced: path to JSON controlling which mods are kept.", type: "string", monospace: true, group: "modpack", appliesTo: ["CURSEFORGE"] },
  { key: "FTB_MODPACK_ID", label: "FTB modpack ID", type: "number", min: 1, group: "modpack" },
  { key: "FTB_MODPACK_VERSION_ID", label: "FTB version ID", type: "number", min: 1, group: "modpack" },
  { key: "GENERIC_PACK", label: "Generic pack URL/path", help: "ZIP of a server directory to unpack over /data.", type: "string", monospace: true, group: "modpack" },
  { key: "REMOVE_OLD_MODS", label: "Remove old mods before install", help: "Prevents stale mod jars from breaking upgrades.", type: "boolean", default: false, group: "modpack" },
  { key: "MODS_FILE", label: "Mods list file path", help: "Newline-separated URLs of mods to download on start.", type: "string", monospace: true, group: "modpack" },

  /* ============================ LIFECYCLE ============================= */
  { key: "STOP_SERVER_ANNOUNCE_DELAY", label: "Shutdown announcement delay (sec)", help: "Seconds between 'server shutting down' and actual stop.", type: "number", min: 0, max: 3600, default: 0, group: "lifecycle" },
  { key: "STOP_DURATION", label: "Graceful stop timeout (sec)", type: "number", min: 1, max: 300, default: 60, group: "lifecycle" },
  { key: "EXEC_DIRECTLY", label: "Exec Java directly (no shell)", help: "Faster shutdown but disables some env wiring.", type: "boolean", default: false, group: "lifecycle" },
  { key: "SKIP_LOG4J_CONFIG", label: "Skip log4j patching", type: "boolean", default: false, group: "lifecycle" },
  { key: "SKIP_SERVER_PROPERTIES", label: "Skip server.properties templating", help: "Keep existing file as-is; don't overlay env values.", type: "boolean", default: false, group: "lifecycle" },
  { key: "REPLACE_ENV_IN_PLACE", label: "Replace \\${ENV} in files", type: "boolean", default: false, group: "lifecycle" },

  /* ============================== PROXY =============================== */
  { key: "PROXY", label: "HTTP(S) proxy", help: "URL of an outbound proxy for downloads, e.g. http://proxy:3128.", type: "string", monospace: true, group: "proxy" },
  { key: "BUNGEECORD_NAME", label: "BungeeCord name", help: "Server identity inside a BungeeCord network.", type: "string", group: "proxy" },
  { key: "VELOCITY_SECRET", label: "Velocity forwarding secret", help: "Required for modern forwarding mode.", type: "string", monospace: true, group: "proxy" },

  /* ============================== PAPER =============================== */
  { key: "PAPER_CHANNEL", label: "Paper release channel", type: "enum", options: ["default", "experimental"], default: "default", group: "paper", appliesTo: ["PAPER"] },
  { key: "PAPER_BUILD", label: "Paper build number", help: "Leave blank for latest.", type: "string", monospace: true, group: "paper", appliesTo: ["PAPER"] },
  { key: "PAPER_DOWNLOAD_URL", label: "Custom Paper download URL", type: "string", monospace: true, group: "paper", appliesTo: ["PAPER"] },

  /* ============================= PURPUR =============================== */
  { key: "PURPUR_BUILD", label: "Purpur build number", type: "string", monospace: true, group: "purpur", appliesTo: ["PURPUR"] },
  { key: "PURPUR_DOWNLOAD_URL", label: "Custom Purpur download URL", type: "string", monospace: true, group: "purpur", appliesTo: ["PURPUR"] },

  /* ============================== FORGE =============================== */
  { key: "FORGE_VERSION", label: "Forge version", help: "Leave blank for Forge recommended for the MC version.", type: "string", monospace: true, group: "forge", appliesTo: ["FORGE"] },
  { key: "FORGE_INSTALLER", label: "Forge installer path", type: "string", monospace: true, group: "forge", appliesTo: ["FORGE"] },
  { key: "FORGE_INSTALLER_URL", label: "Forge installer URL", type: "string", monospace: true, group: "forge", appliesTo: ["FORGE"] },

  /* ============================ NEOFORGE ============================== */
  { key: "NEOFORGE_VERSION", label: "NeoForge version", type: "string", monospace: true, group: "neoforge", appliesTo: ["NEOFORGE"] },
  { key: "NEOFORGE_INSTALLER", label: "NeoForge installer path", type: "string", monospace: true, group: "neoforge", appliesTo: ["NEOFORGE"] },
  { key: "NEOFORGE_INSTALLER_URL", label: "NeoForge installer URL", type: "string", monospace: true, group: "neoforge", appliesTo: ["NEOFORGE"] },

  /* ============================= FABRIC =============================== */
  { key: "FABRIC_LOADER_VERSION", label: "Fabric loader version", type: "string", monospace: true, group: "fabric", appliesTo: ["FABRIC"] },
  { key: "FABRIC_INSTALLER_VERSION", label: "Fabric installer version", type: "string", monospace: true, group: "fabric", appliesTo: ["FABRIC"] },
  { key: "FABRIC_LAUNCHER_VERSION", label: "Fabric launcher version", type: "string", monospace: true, group: "fabric", appliesTo: ["FABRIC"] },

  /* ============================== QUILT ================================ */
  { key: "QUILT_LOADER_VERSION", label: "Quilt loader version", type: "string", monospace: true, group: "quilt", appliesTo: ["QUILT"] },
  { key: "QUILT_INSTALLER_VERSION", label: "Quilt installer version", type: "string", monospace: true, group: "quilt", appliesTo: ["QUILT"] },

  /* ============================= MOHIST =============================== */
  { key: "MOHIST_BUILD", label: "Mohist build number", type: "string", monospace: true, group: "mohist", appliesTo: ["MOHIST"] },

  /* ============================ ADVANCED ============================== */
  { key: "SNOOPER_ENABLED", label: "Snooper telemetry", help: "Legacy anonymous usage data. Off by default.", type: "boolean", default: false, group: "advanced" },
  { key: "ENABLE_JMX_MONITORING", label: "Enable JMX monitoring", help: "Exposes JVM metrics via JMX for profilers.", type: "boolean", default: false, group: "advanced" },
  { key: "INIT_POST_COMMANDS", label: "Post-init shell commands", help: "Run after setup but before JVM start. Advanced.", type: "string", monospace: true, long: true, group: "advanced" },
  { key: "PRE_EXEC_SH", label: "Pre-exec script path", type: "string", monospace: true, group: "advanced" },
];

export const ENV_DEFS_BY_GROUP = ENV_DEFS.reduce<Record<EnvGroup, EnvDef[]>>(
  (acc, d) => {
    (acc[d.group] ||= []).push(d);
    return acc;
  },
  {
    gameplay: [],
    world: [],
    spawning: [],
    players: [],
    "resource-pack": [],
    network: [],
    rcon: [],
    security: [],
    performance: [],
    jvm: [],
    modpack: [],
    lifecycle: [],
    proxy: [],
    paper: [],
    purpur: [],
    forge: [],
    neoforge: [],
    fabric: [],
    quilt: [],
    mohist: [],
    advanced: [],
  }
);

export const ENV_KNOWN_KEYS = new Set(ENV_DEFS.map((d) => d.key));

/** Type-specific groups — only visible when the server type matches. */
const TYPE_SPECIFIC_GROUPS: Partial<Record<EnvGroup, string[]>> = {
  paper: ["PAPER"],
  purpur: ["PURPUR"],
  forge: ["FORGE"],
  neoforge: ["NEOFORGE"],
  fabric: ["FABRIC"],
  quilt: ["QUILT"],
  mohist: ["MOHIST"],
  modpack: ["MODRINTH", "CURSEFORGE"],
};

export function isGroupVisibleForType(
  group: EnvGroup,
  currentType?: string
): boolean {
  const restricted = TYPE_SPECIFIC_GROUPS[group];
  if (!restricted) return true; // generic groups always visible
  if (!currentType) return false; // hide type-specific when type unknown
  return restricted.includes(currentType);
}

export function envDefApplies(d: EnvDef, currentType?: string): boolean {
  if (!d.appliesTo) return true;
  if (!currentType) return false;
  return d.appliesTo.includes(currentType);
}

import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  AGENT_PORT: z.coerce.number().int().default(4100),
  AGENT_HOST: z.string().default("0.0.0.0"),
  AGENT_TOKEN: z.string().min(16),
  AGENT_DATA_ROOT: z.string().default("/var/lib/cofemine/servers"),
  AGENT_BACKUP_ROOT: z.string().default("/var/lib/cofemine/backups"),
  AGENT_DOCKER_NETWORK: z.string().default("cofemine_mcnet"),
  AGENT_LABEL_PREFIX: z.string().default("cofemine"),
  /**
   * Hostname of the maven-cache reverse proxy inside cofemine_mcnet.
   * When set, the agent injects *_INSTALLER_URL overrides into spawned
   * MC containers so mc-image-helper fetches NeoForge/Forge/Fabric/
   * Quilt installers from the cache instead of hitting the real CDN
   * directly. Empty string = disabled (fall back to historical behaviour).
   */
  AGENT_MAVEN_CACHE_HOST: z.string().default(""),
  DOCKER_SOCKET: z.string().default("/var/run/docker.sock"),
  /** If set, the agent talks to a remote Docker daemon via HTTP(s). */
  DOCKER_HOST_URL: z.string().url().optional(),

  /** How many times mc-image-helper retries a failed download during
   * the modpack install phase (Modrinth / CurseForge). The default of 4
   * is itzg's; we bump it to 10 because CF's forgecdn.net is flaky for
   * many regions and each timeout-and-retry cycle still makes progress
   * (already-downloaded jars are kept on disk). Only applies to the
   * install phase — does not affect the running MC server. */
  AGENT_MC_MAX_RETRIES: z.string().default("10"),
  /** Backoff in seconds between retry attempts. Same phase as above. */
  AGENT_MC_RETRY_BACKOFF: z.string().default("10"),

  // ===== Host-protection knobs for spawned MC containers =====
  //
  // Everything below bounds what a Minecraft container can do to the
  // machine. They live here rather than in compose because the agent —
  // not compose — creates these containers.

  /**
   * Log rotation for spawned MC containers.
   *
   * Containers the agent creates inherit the daemon's default logging,
   * and for `json-file` that is *unbounded*. The panel's own services
   * get `max-size` from compose; MC containers had nothing. A modded
   * server in a crash loop, or a mod spamming stack traces, then writes
   * until the host partition is full — which stops Postgres, stops
   * backups, and wedges Docker itself. Any user who can start a server
   * can trigger it.
   *
   * Empty `AGENT_MC_LOG_MAX_SIZE` leaves the daemon default in place.
   */
  AGENT_MC_LOG_MAX_SIZE: z.string().default("10m"),
  AGENT_MC_LOG_MAX_FILE: z.string().default("3"),

  /**
   * Alternative OCI runtime for MC containers only (e.g. `kata-runtime`,
   * `runsc`). Empty = the daemon default, normally `runc`.
   *
   * Mod jars are unsandboxed third-party code that shares the host
   * kernel, so a kernel bug is a host escape. A sandboxed runtime is the
   * only measure that puts a real boundary there: Kata gives each
   * container its own kernel in a lightweight VM (needs /dev/kvm),
   * gVisor intercepts syscalls in userspace (no KVM, but costs more on
   * syscall-heavy work — measure tick times before committing).
   *
   * Applies to MC containers only; the panel's own services stay on the
   * default runtime. The runtime must already be registered in
   * /etc/docker/daemon.json.
   */
  AGENT_MC_RUNTIME: z.string().default(""),

  /**
   * Drop all Linux capabilities from MC containers, adding back only the
   * set itzg needs to chown /data and `gosu` down to uid 1000.
   *
   * On by default: verified against itzg/minecraft-server:java21 with a
   * vanilla 1.20.4 server — it reaches "Done", `gosu` still drops the JVM
   * to uid 1000, and RCON comes up. Costs no performance.
   *
   * Known casualty: profilers that need native sampling (spark's
   * async-profiler mode wants SYS_PTRACE / perf_event access). spark's
   * ordinary JVM sampler is unaffected. Set this to `false` if you need
   * native profiling, and prefer turning it back on afterwards.
   */
  AGENT_MC_CAP_DROP: z
    .string()
    .default("true")
    // NB: not z.coerce.boolean() — that is Boolean("false") === true.
    .transform((v) => v === "true" || v === "1"),

  /**
   * `nofile` ulimit for MC containers. Empty = inherit the daemon's.
   * A big modpack legitimately opens thousands of descriptors, so this
   * is a ceiling against exhaustion, not a tight budget.
   */
  AGENT_MC_NOFILE: z.string().default(""),
});

export const config = schema.parse(process.env);
export type AgentConfig = typeof config;

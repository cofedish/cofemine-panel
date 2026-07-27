import { z } from "zod";

/**
 * Config for the Docker shim.
 *
 * Everything that decides *what a container is allowed to look like*
 * lives here rather than arriving over the wire: the data root that
 * bind mounts are derived from, the network containers join, the label
 * prefix that scopes which containers this service will touch at all.
 * The agent can ask for operations on a server id; it cannot ask for a
 * bind mount, an image, or a privileged flag.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  SHIM_PORT: z.coerce.number().int().default(4200),
  SHIM_HOST: z.string().default("0.0.0.0"),
  /** Shared secret the agent presents. Separate from AGENT_TOKEN so a
   *  leaked agent token doesn't also grant Docker access. */
  SHIM_TOKEN: z.string().min(16),

  /** Host path bind-mounted into Minecraft containers as /data. Bind
   *  sources are always `${DATA_ROOT}/<serverId>` computed here — never
   *  a path supplied by the caller. */
  DATA_ROOT: z.string().default("/var/lib/cofemine/servers"),
  DOCKER_NETWORK: z.string().default("cofemine_mcnet"),
  /** Containers without `<prefix>.managed=true` are invisible to this
   *  service; see containers.ts. */
  LABEL_PREFIX: z.string().default("cofemine"),
  MAVEN_CACHE_HOST: z.string().default(""),

  DOCKER_SOCKET: z.string().default("/var/run/docker.sock"),
  DOCKER_HOST_URL: z.string().url().optional(),

  MC_MAX_RETRIES: z.string().default("10"),
  MC_RETRY_BACKOFF: z.string().default("10"),
  /** Image used for MC containers unless a java-version hint selects a
   *  variant. Kept here so the caller cannot choose an image. */
  MC_IMAGE: z.string().default("itzg/minecraft-server:latest"),
});

export const config = schema.parse(process.env);
export type ShimConfig = typeof config;

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
  DOCKER_SOCKET: z.string().default("/var/run/docker.sock"),
  /** If set, the agent talks to a remote Docker daemon via HTTP(s). */
  DOCKER_HOST_URL: z.string().url().optional(),
});

export const config = schema.parse(process.env);
export type AgentConfig = typeof config;

import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  API_PORT: z.coerce.number().int().default(4000),
  API_HOST: z.string().default("0.0.0.0"),
  API_PUBLIC_URL: z.string().url().default("http://localhost:4000"),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).default(168),
  SECRETS_KEY: z.string().min(1),
  WEB_ORIGIN: z.string().url().default("http://localhost:3000"),
  MODRINTH_USER_AGENT: z
    .string()
    .default("cofemine-panel/0.1 (+https://github.com/cofemine/panel)"),
});

export const config = envSchema.parse(process.env);
export type Config = typeof config;

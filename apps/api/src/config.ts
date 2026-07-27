import { z } from "zod";

/**
 * Placeholder values shipped in `.env.example` / the dev compose. If one
 * of these reaches a real deployment it is not a secret — it is a
 * published constant, and anyone can forge a session or decrypt the
 * integration store with it. Refuse to boot rather than run "secured"
 * by a value that is in the repository.
 */
const PLACEHOLDER_SECRETS = [
  "change-me",
  "changeme",
  "replace_with",
  "replace-me",
  "your-secret",
];

function looksLikePlaceholder(value: string): boolean {
  const lower = value.toLowerCase();
  return PLACEHOLDER_SECRETS.some((needle) => lower.includes(needle));
}

/**
 * Treat "" as absent. Both compose files pass optional vars as
 * `${FOO:-}`, so an unset variable arrives as an empty string rather
 * than as undefined — without this, every optional setting below would
 * fail its own validation the moment the operator didn't set it.
 */
function optional<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((v) => (v === "" ? undefined : v), schema.optional());
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  API_PORT: z.coerce.number().int().default(4000),
  API_HOST: z.string().default("0.0.0.0"),
  API_PUBLIC_URL: z.string().url().default("http://localhost:4000"),
  DATABASE_URL: z.string().min(1),
  // 32 chars is the floor for an HS256 signing key that is worth
  // calling a key. Sessions are the panel's only authentication, and
  // the panel controls the Docker socket.
  JWT_SECRET: z
    .string()
    .min(32, "JWT_SECRET must be at least 32 characters (openssl rand -base64 32)")
    .refine(
      (v) => !looksLikePlaceholder(v),
      "JWT_SECRET is still a placeholder from .env.example — generate a real one with `openssl rand -base64 32`"
    ),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).default(168),
  /**
   * Optional shared secret required by `POST /auth/setup`.
   *
   * First-run setup is trust-on-first-use: while the user table is
   * empty, whoever calls that endpoint first becomes OWNER. On a panel
   * that is reachable before the operator finishes installing, that is
   * a race a stranger can win. Setting this closes the window; leaving
   * it unset preserves the current behaviour (and the API logs a
   * warning while the window is open). `BOOTSTRAP_OWNER_*` in the seed
   * closes it too, by creating the owner before anyone can call.
   */
  SETUP_TOKEN: optional(z.string().min(16)),
  // Validated here as well as in crypto.ts. crypto.ts throws at import
  // time, which surfaces as an opaque stack trace before any config
  // error handling runs; catching it in the schema gives the operator
  // the actual instruction.
  SECRETS_KEY: z
    .string()
    .refine(
      (v) => Buffer.from(v, "base64").length === 32,
      "SECRETS_KEY must decode to exactly 32 bytes (openssl rand -base64 32)"
    )
    .refine(
      (v) => !looksLikePlaceholder(v),
      "SECRETS_KEY is still a placeholder from .env.example — generate a real one with `openssl rand -base64 32`"
    ),
  WEB_ORIGIN: z.string().url().default("http://localhost:3000"),
  /**
   * Public origin of the panel as friends see it, e.g.
   * `https://panel.example.com`. Used to build the client-pack links
   * served from the unauthenticated `/p/*` zone.
   *
   * When unset those links fall back to the request's `Host` header,
   * which is attacker-controlled: a request with a forged Host gets a
   * pack listing pointing at the attacker's domain. Set this and the
   * header stops mattering. (Deliberately NOT `API_PUBLIC_URL` — the
   * links are `<base>/api/p/...`, i.e. they must resolve through the
   * web app's proxy, not the API's own port.)
   */
  PUBLIC_BASE_URL: optional(z.string().url()),
  /**
   * Which peers may set `X-Forwarded-For`. Anything Fastify trusts here
   * can dictate `req.ip`, which drives both the rate limiter's bucket
   * and the IP recorded in the audit log — `true` let any client reset
   * its own rate limit and write a forged IP into the audit trail.
   *
   * The default covers the real topology: Caddy → web (Next rewrite) →
   * api, all on private docker networks. Comma-separated; accepts
   * proxy-addr presets (`loopback`, `linklocal`, `uniquelocal`) and
   * plain CIDRs.
   */
  TRUST_PROXY: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().default("loopback,linklocal,uniquelocal")
  ),
  MODRINTH_USER_AGENT: z
    .string()
    .default("cofemine-panel/0.1 (+https://github.com/cofemine/panel)"),
});

export const config = envSchema.parse(process.env);
export type Config = typeof config;

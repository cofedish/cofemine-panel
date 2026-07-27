/**
 * Redaction of secret-shaped values in `Server.env` before it leaves the
 * API in a response body.
 *
 * Why this exists: `Server.env` is a free-form KV the operator edits in
 * the Env tab, and several flows write secrets into it (the CurseForge
 * API key used to, `RCON_PASSWORD` still comes from the runtime, and
 * operators paste their own `*_TOKEN` / `*_PASSWORD` values). The panel's
 * own convention forbids returning decrypted secrets, so every response
 * that carries `env` runs it through `redactEnv` first.
 *
 * Round-trip safety: the Env tab is a read-modify-write form — it GETs
 * the whole env, lets the user edit any field, then PATCHes the whole
 * object back. Redacting to a fixed sentinel (rather than dropping the
 * key) keeps the form's shape intact, and `restoreRedactedEnv` swaps the
 * sentinel back for the stored value on write. Without that pairing, one
 * save from the Env tab would overwrite every secret with mask text.
 */

/**
 * Value substituted for a secret. Uses the panel-internal `__COFEMINE_`
 * prefix so it is recognisable in logs and can never collide with a real
 * itzg value.
 */
export const REDACTED_ENV_VALUE = "__COFEMINE_REDACTED__";

/**
 * Keys whose value is a secret regardless of suffix.
 */
const SECRET_ENV_KEYS = new Set([
  "CF_API_KEY",
  "RCON_PASSWORD",
  "MODRINTH_API_TOKEN",
]);

/**
 * Suffixes that mark operator-supplied credentials. Matched on the raw
 * key, so `SOME_VENDOR_TOKEN` is covered without an explicit entry.
 */
const SECRET_ENV_SUFFIXES = ["_KEY", "_TOKEN", "_PASSWORD", "_SECRET"];

export function isSecretEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (SECRET_ENV_KEYS.has(upper)) return true;
  return SECRET_ENV_SUFFIXES.some((suffix) => upper.endsWith(suffix));
}

/** Coerce the Prisma `Json` column into the KV shape the rest of the code assumes. */
function asEnvRecord(env: unknown): Record<string, string> {
  if (!env || typeof env !== "object" || Array.isArray(env)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
    out[k] = typeof v === "string" ? v : String(v);
  }
  return out;
}

/**
 * Replace every secret-shaped value with {@link REDACTED_ENV_VALUE}.
 * Empty values stay empty — masking "unset" as "stored" would make the
 * UI claim a credential exists when it doesn't.
 */
export function redactEnv(env: unknown): Record<string, string> {
  const src = asEnvRecord(env);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(src)) {
    out[key] = isSecretEnvKey(key) && value ? REDACTED_ENV_VALUE : value;
  }
  return out;
}

/**
 * Inverse of {@link redactEnv} for the write path: any value that came
 * back as the sentinel means "unchanged", so restore it from what is
 * currently stored. A sentinel with nothing stored behind it is dropped
 * — writing the mask text into the container env would be worse than
 * having no value at all.
 */
export function restoreRedactedEnv(
  next: Record<string, string>,
  current: unknown
): Record<string, string> {
  const stored = asEnvRecord(current);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(next)) {
    if (value !== REDACTED_ENV_VALUE) {
      out[key] = value;
      continue;
    }
    const previous = stored[key];
    if (previous !== undefined) out[key] = previous;
  }
  return out;
}

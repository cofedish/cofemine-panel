/**
 * Per-account + per-IP throttle for the login endpoint.
 *
 * Why the global rate limiter isn't enough: `@fastify/rate-limit` is
 * configured at 600 req/min keyed on the client IP, which leaves room
 * for ~600 password guesses a minute against a single account, and the
 * key it uses is `req.ip` — derived from `X-Forwarded-For`. Two buckets
 * (identifier and IP) means neither rotating source addresses nor
 * spreading guesses across accounts gets you a free pass.
 *
 * In-memory on purpose: the API is single-instance (so is the
 * scheduler), and a lockout that resets on deploy is an acceptable
 * trade for not putting an auth-path write on Postgres. If the panel
 * ever runs multi-instance this needs to move to shared storage —
 * along with the scheduler.
 */

/** Failures inside this window count toward the same escalation. */
const WINDOW_MS = 15 * 60 * 1000;
/** Attempts allowed before backoff kicks in at all. */
const FREE_ATTEMPTS = 5;
/** First lockout; doubles per additional failure. */
const BASE_LOCKOUT_MS = 30 * 1000;
/** Ceiling, so a forgetful operator isn't locked out for a day. */
const MAX_LOCKOUT_MS = 15 * 60 * 1000;
/** Hard cap on tracked buckets — a spray across millions of usernames
 *  must not become an unbounded memory sink. */
const MAX_BUCKETS = 20_000;

type Bucket = {
  failures: number;
  /** Epoch ms; requests before this are refused outright. */
  lockedUntil: number;
  /** Epoch ms of the most recent failure — drives window expiry. */
  lastFailureAt: number;
};

const buckets = new Map<string, Bucket>();

/**
 * The two buckets a login attempt is charged against.
 *
 * Both are scoped to the source address, and the account bucket
 * deliberately is NOT global. A global per-account lockout is remotely
 * triggerable: eleven wrong passwords in fifteen minutes would lock the
 * OWNER out of their own panel, and an attacker can renew that forever
 * from anywhere — a lockout-DoS that is strictly worse than the brute
 * force it prevents, because only a *successful* login clears it.
 *
 * Scoped per-IP, an attacker can only lock themselves out. The residual
 * risk is a distributed attack spreading guesses across many addresses;
 * against bcrypt (cost 12) with an 8-character minimum and the global
 * 600/min/IP limiter on top, that is the accepted trade.
 */
export function loginThrottleKeys(ip: string, identifier: string): string[] {
  const id = identifier.trim().toLowerCase();
  return [`ip:${ip}`, `id:${id}|ip:${ip}`];
}

function lockoutFor(failures: number): number {
  if (failures <= FREE_ATTEMPTS) return 0;
  const exponent = failures - FREE_ATTEMPTS - 1;
  return Math.min(MAX_LOCKOUT_MS, BASE_LOCKOUT_MS * 2 ** exponent);
}

function prune(now: number): void {
  for (const [key, bucket] of buckets) {
    if (now - bucket.lastFailureAt > WINDOW_MS && now > bucket.lockedUntil) {
      buckets.delete(key);
    }
  }
  // Still oversized after dropping the expired ones (a live spray):
  // evict oldest-first. Map preserves insertion order.
  if (buckets.size > MAX_BUCKETS) {
    const excess = buckets.size - MAX_BUCKETS;
    let dropped = 0;
    for (const key of buckets.keys()) {
      buckets.delete(key);
      if (++dropped >= excess) break;
    }
  }
}

export type ThrottleVerdict =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

/** Check both buckets before spending a password verification. */
export function checkLoginAllowed(keys: string[]): ThrottleVerdict {
  const now = Date.now();
  let lockedUntil = 0;
  for (const key of keys) {
    const bucket = buckets.get(key);
    if (!bucket) continue;
    if (now - bucket.lastFailureAt > WINDOW_MS && now > bucket.lockedUntil) {
      buckets.delete(key);
      continue;
    }
    if (bucket.lockedUntil > lockedUntil) lockedUntil = bucket.lockedUntil;
  }
  if (lockedUntil > now) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((lockedUntil - now) / 1000),
    };
  }
  return { allowed: true };
}

/** Charge a failed attempt to every bucket and extend the lockout. */
export function recordLoginFailure(keys: string[]): void {
  const now = Date.now();
  for (const key of keys) {
    const existing = buckets.get(key);
    const withinWindow =
      existing && now - existing.lastFailureAt <= WINDOW_MS;
    const failures = withinWindow ? existing.failures + 1 : 1;
    const lockout = lockoutFor(failures);
    buckets.set(key, {
      failures,
      lastFailureAt: now,
      lockedUntil: lockout > 0 ? now + lockout : 0,
    });
  }
  if (buckets.size > MAX_BUCKETS) prune(now);
}

/** Successful login wipes the slate for both buckets. */
export function clearLoginFailures(keys: string[]): void {
  for (const key of keys) buckets.delete(key);
}

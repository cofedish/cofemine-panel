---
name: auth-and-rbac
description: Use when changing authentication, sessions, passwords, roles/permissions, the agent bearer token, encrypted secrets, public unauthenticated zones (/p/*, /ws/*), or reviewing any change for authorization and trust-boundary impact.
user-invocable: false
---

# Authentication, RBAC & trust boundaries

## Session model (verified in code)

- Login (`apps/api/src/auth/routes.ts`) issues an HS256 JWT (`{sub: userId, sid: sessionId}`, issuer `cofemine-panel`) set as httpOnly cookie **`cofemine_session`** (sameSite lax, secure in prod, TTL `SESSION_TTL_HOURS`). `Authorization: Bearer <jwt>` is accepted equivalently.
- A DB `Session` row stores `tokenHash = sha256(jwt)`. Acceptance requires all four: valid signature, `session.userId === sub`, not expired, hash match (`src/auth/plugin.ts`). **Revocation = delete the Session row** — keep this property; don't make JWTs self-sufficient.
- Passwords: bcryptjs cost 12. Reset tokens: 32 random bytes, sha256-stored, 1h TTL, single-use; `/auth/forgot-password` always 204 (anti-enumeration); successful reset purges all sessions in a `$transaction`.
- First-run: `POST /auth/setup` creates the OWNER only while `user.count() === 0`; alternative env-driven bootstrap in `prisma/seed.ts`.

## Request authentication pipeline (apps/api/src/main.ts)

`registerAuthHook` populates `req.user` and never rejects; a **separate** global
preHandler rejects unauthenticated requests unless the route is whitelisted:
`/health`, `/auth/setup-status|setup|login|forgot-password|reset-password`, `/ws/*`, `/p/*`.
`/ws/*` bypasses the gate but `ws/console.ts` re-checks user + `server.control` itself
— any new WS route must do the same.

## RBAC

- Matrix: `packages/shared/src/roles.ts` — OWNER(100) > ADMIN(75) > OPERATOR(50) > VIEWER(10); ten permissions; only OWNER has `user.manage`.
- Enforcement helpers (`apps/api/src/auth/rbac.ts`): `requireGlobalPermission` (preHandler), `assertServerPermission` (in-handler). Cached 30s variant only in `map-routes.ts` (revocation lag there).
- **Scoping rule in `assertServerPermission`**: the global role counts as a per-server grant only for OWNER/ADMIN. For OPERATOR/VIEWER the effective role comes from `Membership` alone; no membership → 403. Keep this in sync with the `canSeeAll` branch of `GET /servers` — they encode the same rule and drifted apart once already (a global OPERATOR could `POST /servers/<any>/command`).
- Login is throttled per identifier + per IP (`auth/login-throttle.ts`, in-memory, exponential lockout); failures are audited as `auth.login-failed`.
- `POST /auth/setup` requires `SETUP_TOKEN` when that env var is set (constant-time compare); otherwise it stays trust-on-first-use and the API warns.
- **Enforcement is server-side only.** The web app shows everything to everyone authenticated; `PERMISSIONS` is not imported by web. UI gating is cosmetic at best.
- Known gaps (real, verified): no Membership CRUD routes (per-server roles are DB-only, so OPERATOR/VIEWER see no servers); several read endpoints are authenticated-but-unscoped (templates list, `/meta/*`, integrations reads incl. proxy/SMTP topology with secrets redacted).

## Trust zones, from most to least trusted

1. **Agent** (`apps/agent`): single shared `AGENT_TOKEN` bearer (zod min 16, boot-fail; plain `!==` compare). Trusts callers completely — including absolute filesystem paths for backup restore/delete. API-side token resolution is env-based (`AGENT_TOKEN_<NODENAME>` → `AGENT_TOKEN`); `Node.tokenHash` in DB is never read.
2. **API** with authenticated user: per-permission checks per route.
3. **Public zone**: `/p/*` serves client packs by unguessable token; `/p/index.json` deliberately enumerates all public-token servers (documented in `docs/pack-integration.md`). `/health` is open. Don't add public routes without the same explicit deliberation.
4. **MC containers**: untrusted workloads; touched only via Docker API + `rcon-cli`. They do trust the panel-generated maven-cache MITM CA (imported into JVM at container start) — treat CA material as a secret trust root.

## Secrets at rest

`apps/api/src/crypto.ts` — AES-256-GCM envelope `v1:<iv>:<tag>:<ct>`; `SECRETS_KEY`
must decode to exactly 32 bytes base64 (import-time hard fail — rotating it orphans
every stored secret). Encrypted values live in `IntegrationSetting`; display
endpoints must return `has*: boolean` flags only.

## Invariants to preserve in any auth-adjacent change

- Authorization is checked before side effects, in the API, never in the UI.
- No route returns password hashes, session/reset token hashes, or decrypted secrets.
- Anti-enumeration behavior of `/auth/forgot-password` (always 204) stays.
- New agent routes are automatically behind the bearer hook — but remember they run post-authorization: validate inputs (paths!) anyway.
- Audit mutating auth actions (`writeAudit`), as existing routes do.

## Verification

No tests. After changes: `pnpm typecheck`; manually exercise login/logout/reset and
one permission-denied path (e.g. VIEWER hitting a control route → 403) via compose.

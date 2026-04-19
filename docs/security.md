# Security model

This is a self-hosted admin panel with control over Docker containers on the host. Treat it accordingly.

## Session & authentication

- Passwords hashed with **bcrypt** (cost 12).
- Sessions are JWTs signed with `JWT_SECRET` and also stored as `Session` rows with an **sha256-hashed copy of the token**. A request is accepted only if:
  - the JWT verifies,
  - the `sid` claim matches a session row,
  - the row's `tokenHash` matches sha256 of the presented token,
  - and the row has not expired.
- JWT is delivered as an httpOnly, sameSite=lax cookie. In production (`NODE_ENV=production`) it is also `secure`.
- Logout deletes the session row — the token becomes useless even if the cookie is stolen.

## RBAC

- Four roles: **OWNER > ADMIN > OPERATOR > VIEWER**.
- Global role is the default. Per-server `Membership` rows can grant a stronger role on a specific server.
- Permission checks use an allowlist (`PERMISSIONS` in `packages/shared/src/roles.ts`). No permission is implicit.
- The `requireGlobalPermission` / `assertServerPermission` helpers are the only gateways. Routes that mutate state always pass through one.

## Audit log

Every write action emits an `AuditEvent` with user, IP, and the resource id. Events are append-only from the app's perspective — no routes delete them. The log is visible in the UI.

## Secrets

- `SECRETS_KEY` is a 32-byte (base64) key loaded from the environment. It is used with **AES-256-GCM** to encrypt integration secrets (like the CurseForge API key) before they are written to `IntegrationSetting.value`.
- `JWT_SECRET` is only in env.
- Database passwords, `AGENT_TOKEN`, etc. live in env; use your orchestrator's secret manager in production.

## Agent ↔ API

- The agent speaks HTTP with a single shared bearer token. Put the agent behind a VPN or on an internal network; never expose port 4100 to the public internet.
- The API stores only a **sha256 hash** of the token in the DB. The API is the party that initiates calls, so it also needs the plaintext via env — keep it out of logs. Future: per-request asymmetric auth.
- WebSocket console is proxied through the API so the browser never has direct access to the agent.

## Docker socket

- Only the `node-agent` container mounts `/var/run/docker.sock`.
- Neither `panel-api` nor `panel-web` has Docker access.
- The agent uses the Docker Engine SDK (`dockerode`), not shell commands.

## Path traversal

The file manager uses `safeResolve(base, userPath)` which:

1. Strips leading slashes.
2. Resolves against `base`.
3. Rejects if the resolved path is not `base` or a descendant of `base`.

All file read/write/delete endpoints go through it. The API also refuses paths containing `..` at the zod layer.

## Destructive actions

- All destructive UI actions are `confirm()`-gated.
- Deleting a node is blocked if it still has servers.
- Deleting your own user is blocked.

## Rate limits

`@fastify/rate-limit` is wired globally (600 req/min/IP by default). Tune per route as needed.

## What is explicitly NOT covered (yet)

- 2FA / TOTP.
- SSO (OIDC/SAML).
- Token-scoped API keys for scripts.
- Per-server resource quotas beyond the memory/CPU container limit.

These are on the [roadmap](roadmap.md).

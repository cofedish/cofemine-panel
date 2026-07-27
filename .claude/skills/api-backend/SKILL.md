---
name: api-backend
description: Use when changing apps/api — adding or modifying routes, request validation, RBAC checks, audit events, the croner scheduler, agent communication (NodeClient/WS proxy), content-provider integrations, or API error handling.
user-invocable: false
paths:
  - "apps/api/**"
---

# API backend (apps/api)

## Scope & responsibility

Fastify 4 + Prisma 5 + Zod, ESM, executed by `tsx` in production. Owns all domain
state, authentication/authorization, audit, scheduling, and is the only bridge
between browsers and agents. Two entrypoints: `src/main.ts` (panel API) and
`src/map-proxy-main.ts` (map-proxy service — same image, map routes only).

## Entry points & wiring

`src/main.ts` order is load-bearing: helmet/cors/cookie/sensible/rate-limit(600/min)/websocket
→ `registerAuthHook` (populates `req.user`, never rejects) → global auth-gate preHandler
(rejects unless route is whitelisted: `/health`, `/auth/setup*`, `/auth/login`,
`/auth/forgot-password`, `/auth/reset-password`, `/ws/*`, `/p/*`) → error handler →
routes → `startScheduler()`. `bodyLimit` 1 GiB (must match the agent).
Route modules: `auth`, `nodes`, `servers` (+`map-routes`, `public-pack-routes`),
`backups`, `schedules`, `templates`, `users`, `audit`, `integrations`, `meta`, `ws/console`.
Plugins parameterized on `/servers/:id/...` are mounted at **root**, not under a prefix.

## RBAC model

- Matrix in `packages/shared/src/roles.ts` (OWNER>ADMIN>OPERATOR>VIEWER; ten `Permission`s).
- `requireGlobalPermission(perm)` — route preHandler for global resources.
- `assertServerPermission(req, serverId, perm)` — awaited in handlers. The global role counts as a per-server grant only for OWNER/ADMIN; OPERATOR/VIEWER need a `Membership` row on that server or they get 403.
- Responses that carry `Server.env` must pass it through `redactEnv` (`servers/env-redaction.ts`); `PATCH /servers/:id` reverses the sentinel with `restoreRedactedEnv` so the Env tab's round trip is lossless.
- WS console requires `server.control`. Map routes use a 30s-TTL cached variant (`map-routes.ts`) — revocation lags up to 30s there.
- Known gap: no routes manage `Membership` rows (DB-only), so OPERATOR/VIEWER see no servers in practice.

## Persistence & transactions

Prisma against Postgres; schema in `prisma/schema.prisma` (see `database-and-persistence`
skill). Almost no `$transaction` usage — the notable one is password reset (token
consume + session purge). Multi-step flows (create server → call agent → store
containerId) are not transactional; failure leaves partial rows cleaned up ad hoc.

## Agent communication

- `NodeClient` (`src/nodes/node-client.ts`): undici, Bearer token from `AGENT_TOKEN_<NODENAME>` env → `AGENT_TOKEN` fallback. `Node.tokenHash` in DB is vestigial (never read).
- Long ops pass explicit `headersTimeout`/`bodyTimeout` (loader install 20 min, client-mod bulk 60 min).
- Raw-stream exceptions that bypass NodeClient (keep it that way, don't add more): `servers/export-mrpack.ts`, `servers/map-routes.ts` — both re-implement `resolveAgentToken`.
- WS proxy `src/ws/console.ts`: auth + permission, then bidirectional relay to the agent WS; close codes 4401/4404/1011.

## Scheduler (croner)

`src/schedules/scheduler.ts`: in-process `Map<scheduleId, Cron>`, UTC, fully rebuilt
by `restartScheduler()` on every schedule CRUD. Actions `restart|backup|command|announce`.
Not multi-instance safe; not audited; invalid cron strings are skipped with a log.
Backup runs + retention: see `backups-and-schedules` skill.

## Content providers

`ContentProvider` interface (`src/integrations/content-provider.ts`) with
`ModrinthProvider` (public, 3x retry, 5-min compat cache) and `CurseForgeProvider`
(needs API key from encrypted `IntegrationSetting`, no retry). Providers only plan;
the agent executes. The polymorphic `providers` registry in `integrations/routes.ts`
is dead code — call sites use the concrete singletons.

## Secrets

`src/crypto.ts`: AES-256-GCM envelope `v1:<iv>:<tag>:<ct>`; `SECRETS_KEY` must be
exactly 32 bytes base64 (import-time hard fail); `sha256Hex` for session/reset/node
token hashing. Encrypted KV namespaces in `IntegrationSetting`: `curseforge.apiKey`,
`download.proxy.*`, `maven.cache.ca.*`, `smtp.*`. Display endpoints return
`has*: boolean`, never plaintext.

## Error handling & validation

Central handler: `ZodError` → 400 with issues; else `err.statusCode ?? 500`.
Throw idiom: `Object.assign(new Error(msg), { statusCode })`. Zod `.parse()` inside
handlers; shared shapes from `@cofemine/shared`, route-local ones inline. No response
schemas — protect with explicit Prisma `select`.

## Forbidden shortcuts

- No new route without permission check + audit (`writeAudit`) for mutations.
- Don't read `Node.tokenHash` for auth or "fix" it to be authoritative without a real multi-node design pass.
- Don't move scheduler/retention logic into the agent.
- Don't return decrypted secrets or full Prisma models.

## Tests & verification

No tests exist. Verify with `pnpm --filter @cofemine/api typecheck`, then compose up
and exercise the route (UI or curl with the session cookie). Remember: pushing to
`main` deploys to production.

## Known dead/vestigial (don't "wire up" casually)

`config.API_PUBLIC_URL` (never read), `providers` registry, `Node.tokenHash`,
legacy non-prefixed map fallthrough in `map-routes.ts`, near-no-op `materializeEnv`
in `servers/service.ts`, `__COFEMINE_PENDING_MAP_INSTALL` reader in `post-boot.ts`
(nothing writes the key), no-op onSend hook in `main.ts`.

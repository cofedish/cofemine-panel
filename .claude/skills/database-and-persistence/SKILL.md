---
name: database-and-persistence
description: Use when changing the Prisma schema, seed, or anything touching persistent state — new models/fields/enums, Server/Backup/Schedule row lifecycles, the encrypted IntegrationSetting KV, or when reasoning about how schema changes reach production (db push, not migrations).
user-invocable: false
paths:
  - "apps/api/prisma/**"
---

# Database & persistence

## Source of truth

`apps/api/prisma/schema.prisma` (single file). Postgres. Only the API touches the DB.
Client via `src/db.ts`. `BigInt` serialization relies on the `toJSON` prototype patch
in `src/main.ts`.

## THE critical deployment fact: no migrations

There is **no `prisma/migrations/` directory**. Production applies schema with
`prisma db push --skip-generate --accept-data-loss` in a retry loop
(`apps/api/docker-entrypoint.sh`), then runs the idempotent seed, on every boot.

Consequences you must respect:

- A column/model **rename is a drop+create** — production data in it is destroyed on next deploy. Prefer add-new → backfill → remove-old across releases, or call out the data loss explicitly.
- `pnpm db:migrate` / `db:deploy` scripts exist but are unusable (no history) — do not run or recommend them.
- There is no down/rollback path; rolling back images does not roll back schema.
- Dev matches prod: `db push` from the same entrypoint in compose.

## Models (11) — one line each

- `User` — unique email/username, bcrypt password, global `Role`, avatar data-URL.
- `Session` — unique `tokenHash` = sha256(JWT), expiry; delete row = revoke.
- `PasswordResetToken` — sha256 token hash, 1h TTL, single-use `usedAt`, `source`.
- `Node` — agent host + `tokenHash` (write-only/vestigial; env token is authoritative), status, lastSeenAt.
- `Server` — the wide one: nodeId, containerId/Name, runtime (`"itzg"`), type/version/memory/cpu, ports & env JSON, `status` **free-form string** (values from `SERVER_STATUS` in shared, but not DB-enforced), template link, public pack token, CF pack ids, client-pack fields.
- `Template` — type/version/memory/env presets (3 demo rows seeded).
- `Membership` — `@@unique([userId, serverId])` per-server role override. No management routes exist (DB-only today).
- `Backup` — name, `sizeBytes BigInt?`, `status` free-form (`running|success|failed`; `pending` default never written), absolute `path` on the agent host, finishedAt.
- `Schedule` — cron string, `action` (`restart|backup|command|announce`), payload JSON, enabled, lastRunAt.
- `AuditEvent` — nullable userId (SetNull), action, resource, metadata JSON, ip.
- `IntegrationSetting` — key PK → AES-256-GCM ciphertext `value`. The generic encrypted KV (`curseforge.apiKey`, `download.proxy.*`, `maven.cache.ca.*`, `smtp.*`); namespace is convention-only.

## Identity & idempotency

`Server.id` cuid keys everything downstream (container label, data dir, backup dir,
rcon password). Seed idempotence = count checks (users/nodes/templates). Status
strings are reconciled from Docker (`servers/status.ts`) — the DB is a cache of
runtime state, authoritative only for configuration.

## Consistency boundaries

- Rows lead, side effects follow, rows updated after — crashes leave transitional states (`Backup.status="running"` has no reconciler).
- `$transaction` used only where it matters most (password-reset consume + session purge). Server-create/agent-call flows are not transactional.
- Cascade deletes: user → sessions/resets/memberships; server → backups/schedules/memberships rows. **Deleting a Server does not delete backup archives on the agent disk** (known orphan source).

## After changing the schema

1. `pnpm db:generate` (regenerate client), `pnpm typecheck`.
2. Update `prisma/seed.ts` if the change affects seeded rows; the seed must stay idempotent.
3. Update the zod contracts in `packages/shared/src/schemas.ts` and any explicit Prisma `select` lists in routes.
4. State loudly whether `db push` will drop anything on deploy.

## Non-DB persistent state (don't forget it exists)

Agent host filesystem: `DATA_ROOT/<serverId>/` (worlds, mods, `.cofemine-client/`
staging), `BACKUP_ROOT/<serverId>/*.tar.gz`; maven-cache volumes (nginx/squid caches,
CA volume `cofemine_maven_cache_ca`); Postgres volume `db_data`. Browser-side:
localStorage (theme, accent, console history, chat cache).

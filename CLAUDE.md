# Cofemine Panel — project map for Claude

Self-hosted, Docker-first Minecraft server control panel. Servers run as sibling
containers of [`itzg/minecraft-server`](https://github.com/itzg/docker-minecraft-server);
the panel manages their lifecycle, files, backups, schedules, content (mods/modpacks),
live console/chat, and world maps.

Status: MVP in active development. Single-node in practice, multi-node-ready by schema.

## Components

pnpm monorepo (`pnpm-workspace.yaml`: `apps/*`, `packages/*`). One Docker Compose
project (`cofemine`) with six services:

| Service | Code | Role |
|---|---|---|
| `web` | `apps/web` | Next.js 14 App Router UI. Pure API client; no backend logic. Proxies `/api/*` to the API via `next.config.mjs` rewrites (order-sensitive; also implicitly proxies WebSocket upgrades). |
| `api` | `apps/api` | Fastify 4 + Prisma 5 + Zod. Owns auth, RBAC, audit, all domain state in Postgres, the croner scheduler, content providers (Modrinth/CurseForge), and proxying to agents. Runs via `tsx src/main.ts` in prod (not compiled), because `@cofemine/shared` ships raw TS. |
| `map-proxy` | `apps/api` (same image, `src/map-proxy-main.ts`) | Separate process on :4500 serving only live-map routes — isolates BlueMap tile traffic from the API event loop. Not dead code. |
| `agent` | `apps/agent` | Fastify + dockerode node-agent. The only service with `docker.sock`. Creates/starts/stops MC containers, file manager, backups (tar.gz), content install execution, console/chat log streaming. Runs compiled `node dist/main.js`. |
| `db` | — | Postgres. Only the API talks to it. |
| `maven-cache` | `services/maven-cache` | nginx + squid (ssl-bump MITM) + gost caching proxy for loader/CDN downloads (region-block workaround). CA is seeded by the agent into two volumes: `cofemine_maven_cache_ca` (cert + key, sidecar only) and `cofemine_maven_cache_ca_pub` (cert only, MC containers). |

`packages/shared` (`@cofemine/shared`) — zod schemas, roles/permissions matrix,
server types. Published as **raw TypeScript** (`exports` → `src/index.ts`); all three
apps depend on it at build/runtime.

## Entry points

- API: `apps/api/src/main.ts` (bootstrap order matters: plugins → auth hook → global auth gate → routes → scheduler). Container entry: `apps/api/docker-entrypoint.sh` (waits for DB via `prisma db push`, runs seed, execs tsx).
- Map proxy: `apps/api/src/map-proxy-main.ts`.
- Agent: `apps/agent/src/main.ts`.
- Web: `apps/web/src/app/layout.tsx` (root providers) and `apps/web/src/app/(app)/layout.tsx` (AuthGate shell); proxy config in `apps/web/next.config.mjs`.

## Key data flows

- Browser → `web` (same-origin `/api/*` rewrite, httpOnly cookie) → `api` → (Bearer `AGENT_TOKEN`) → `agent` → Docker Engine → MC container. The browser never learns agent or Docker addresses; the agent never sees Postgres.
- Console/chat: browser WS `/api/ws/servers/:id/console` → Next upgrade proxy → API (`src/ws/console.ts`, RBAC-checked) → agent WS → `container.logs` stream + `rcon-cli` exec.
- Backups: API creates `Backup` row (`running`) → agent tars `/data` inline → API records `success|failed` + path/size. Archives live only on the agent host (`BACKUP_ROOT/<serverId>/`), never cross the wire.
- Content install: API builds an install plan (provider APIs) → agent executes (download into `/data/<target>` or modpack env merge + container recreate; itzg does the actual pack download on next boot).
- Live maps: browser → web rewrite → `map-proxy` → agent `GET /servers/:id/proxy/:port/*` → container's BlueMap/dynmap port.

## Sources of truth

- Domain state (users, sessions, nodes, servers, backups metadata, schedules, audit, encrypted integration settings): **Postgres via `apps/api/prisma/schema.prisma`**. No other service touches the DB.
- Container runtime state: **Docker Engine**, indexed only by `cofemine.*` labels; the API reconciles `Server.status` from agent `/servers/state`.
- Server files & backup archives: **agent host filesystem** (`DATA_ROOT/<serverId>`, `BACKUP_ROOT/<serverId>`), bind-mounted at identical paths in host and agent.
- API contracts and roles: `packages/shared/src/{schemas,roles,server-types}.ts`.
- Deployment truth: `docker-compose.prod.yml` + `.github/workflows/deploy.yml` (docs in `docs/` are partially stale — trust compose/code first; see `.claude/skills/project-architecture/references.md`).

## Architecture boundaries (enforce these)

- Only the **agent** may use dockerode / `docker.sock`. Never add Docker calls to the API or web.
- Only the **API** may use Prisma/Postgres. The agent is stateless (no DB, no timers/cron); scheduling and retention logic live in the API.
- The **web** app calls the API exclusively through `apps/web/src/lib/api.ts` (the only `fetch` site) against same-origin `/api`. No `NEXT_PUBLIC_*` API URLs, no direct agent calls.
- RBAC is enforced **server-side only** (`assertServerPermission` / `requireGlobalPermission` in `apps/api/src/auth/rbac.ts`). The web UI intentionally does not hide by role — never treat UI visibility as authorization.
- A **global** OPERATOR/VIEWER role is not a grant on every server — only OWNER/ADMIN work that way. Scoped roles need a `Membership` row. `assertServerPermission` and the `canSeeAll` branch of `GET /servers` must keep encoding the same rule.
- Agent trusts the API entirely (single Bearer token). Anything reaching the agent is post-authorization; user-supplied paths must still pass `safeResolve` (`apps/agent/src/paths.ts`), backup archive paths `resolveArchivePath`, and outbound URLs `assertSafeDownloadUrl` (`apps/agent/src/security.ts`).

## Critical invariants

- Every `/servers/*` API route must call `assertServerPermission(req, id, perm)` (or `requireGlobalPermission`) before side effects; mutating handlers write `writeAudit(...)`.
- Sessions: JWT (HS256) + DB `Session` row with `tokenHash = sha256(jwt)`; both must validate. Revocation = delete the row.
- `SECRETS_KEY` must decode to exactly 32 bytes base64 (API hard-fails at import). Integration secrets are AES-256-GCM `v1:<iv>:<tag>:<ct>` in `IntegrationSetting`.
- Backup retention only ever deletes backups with `status: "success"` AND name prefix `scheduled-`. The `manual-`/`scheduled-` name prefix is load-bearing — do not rename backups or "simplify" the filter.
- `DATA_ROOT`/`BACKUP_ROOT` are bind-mounted at the **identical absolute path** in host and agent (MC containers and agent must resolve the same paths). Never convert them to named volumes.
- `bodyLimit` is 1 GiB in **both** API and agent (base64 chunked uploads); keep them in sync.
- Env keys prefixed `__COFEMINE_` are panel-internal and stripped before reaching MC containers (`itzg-provider.ts`). The same pass strips `UID`/`GID`/`RUN_AS_ROOT`/`SKIP_SUDO`, which `serverEnvSchema` also rejects API-side — either alone would let `server.edit` run the JVM as root in-container.
- `CF_API_KEY` is never persisted in `Server.env`; it is injected into the spec by `materializeEnv` at provision time. Any response carrying `env` goes through `redactEnv` (`apps/api/src/servers/env-redaction.ts`), and `PATCH /servers/:id` reverses the sentinel via `restoreRedactedEnv`.
- The maven-cache CA private key lives only in `cofemine_maven_cache_ca_key` (mounted by the sidecar). New MC containers mount `cofemine_maven_cache_ca_pub` (cert + `.ready` + `import.sh`); containers created before the split still bind the legacy `cofemine_maven_cache_ca`, which the agent keeps public-only and whose `ca.key` it truncates on every seed. Never write key material to the pub or legacy volume.
- Any route that turns a caller-supplied filename into a write path uses a bare-filename check (`assertBareClientFilename`), and any caller-supplied URL the agent fetches goes through `assertSafeDownloadUrl`. The agent writes as root next to `docker.sock` — traversal there is host RCE, not a misplaced file.
- Chunked upload zod schemas must keep `chunkIndex`/`totalChunks` fields, or zod strips them and uploads silently corrupt.
- Schema changes deploy via `prisma db push --accept-data-loss` (there are **no migrations**) — a column rename is a drop+create and destroys data. Treat destructive schema edits as production data-loss events.
- All text files are LF (`.gitattributes`); `.sh` files break in containers with CRLF.
- Installs are `--frozen-lockfile` in CI and all three Dockerfiles, and each Dockerfile copies **every** workspace manifest (a frozen install validates the lockfile against the whole workspace). Commit `pnpm-lock.yaml` with any dependency change or the build fails.
- Untrusted registry HTML never reaches `dangerouslySetInnerHTML` — `SafeHtml` (DOMPurify → DOM nodes) is the only path, and registry URLs go through `safeExternalUrl`.
- Schedules record `createdById`; the scheduler re-checks that user still has `server.edit` before each run and disables the schedule otherwise. Cron is five fields only (six = seconds in croner).
- `/p/index.json` lists only servers with `publicPackListed` — the listing publishes raw pack tokens.

## Commands (verified)

```bash
pnpm typecheck        # tsc --noEmit in all 4 packages — the de-facto quality gate; run before finishing any change
pnpm build            # tsc x3 + next build (slower)
pnpm dev              # tsx watch + next dev for all apps (needs local Postgres/env)
docker compose up --build   # full dev stack
pnpm db:generate      # prisma generate
```

Do NOT use:
- `pnpm lint` — ESLint is not installed anywhere; `next lint` would prompt interactively.
- `pnpm db:migrate` / `db:deploy` — there is no `prisma/migrations/` directory; the real mechanism is `db push` in `apps/api/docker-entrypoint.sh`.
- There are **no tests** in this repo (no runner, no test files). Verification = typecheck + build + manual/compose smoke.

Note for searching: `apps/agent/src/routes/servers.ts` contains a literal NUL byte (control-char regex), so ripgrep treats it as binary — Grep misses it silently; Read the file or use `grep -a`.

## Safe-change rules

- **Every push to `main` auto-deploys to production** (`.github/workflows/deploy.yml`: `check` typecheck job → build images → SSH → `git reset --hard` + `compose up`). The typecheck gate is the only CI check — no tests, no runtime verification. Never commit or push unless the user explicitly asks; always run `pnpm typecheck` first.
- Never read, print, or copy `.env` contents; never write secrets, tokens, or real hostnames/IPs into code, docs, or knowledge files.
- `docs/deployment.md`, `docs/api.md`, `docs/architecture.md`, `docs/roadmap.md` contain known-stale claims — verify against code/compose before relying on them.
- Renaming/removing anything in `packages/shared` breaks API boot (runtime tsx import) and web build simultaneously — check all three consumers.

## Specialized knowledge

Skills in `.claude/skills/` load automatically by task area: `project-architecture`
(cross-service flows, trust boundaries), `api-backend`, `node-agent`, `web-frontend`,
`database-and-persistence`, `auth-and-rbac`, `content-and-modpacks`,
`backups-and-schedules`, `deployment-and-operations`. Manual workflow:
`/add-api-endpoint`. Path-scoped conventions live in `.claude/rules/`.

## Keeping this knowledge current

After changing component boundaries, public contracts (routes, shared schemas),
persistent storage (Prisma schema, on-disk layouts), data flows, trust boundaries,
or correctness invariants — update the affected `.claude/skills/*` and this map.
Do not update knowledge files for minor internal implementation changes.

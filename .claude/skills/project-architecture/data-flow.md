# End-to-end data flows

All flows begin at the browser hitting same-origin `/api/*`, rewritten by
`apps/web/next.config.mjs` to the `api` container (map paths to `map-proxy`).

## Create + start a server

1. Wizard `POST /servers` → API validates (`createServerSchema`), inserts `Server` row, resolves node → agent `POST /servers` with a `ServerSpec`.
2. Agent pulls the itzg image if needed, builds `ContainerCreateOptions` via `ItzgRuntimeProvider` (TYPE/VERSION/MEMORY/ports/`/data` bind/RCON always on), creates the container, returns id.
3. API stores `containerId`/`containerName`. Start: `POST /servers/:id/start` → agent `startWithPortRecovery` (restores restart policy, clears port-squatting zombies).
4. `Server.status` is reconciled lazily from agent `GET /servers/state` (batch) by `apps/api/src/servers/status.ts` — Docker is the runtime source of truth, the DB is a cache here.

Modpack servers (`type: MODRINTH|CURSEFORGE`): the plan sets env (`MODRINTH_MODPACK` / `CF_*`); itzg's mc-image-helper downloads the pack on container boot, not the panel.

## Console & chat (realtime)

Browser WS `wss://<host>/api/ws/servers/:id/console`
→ Next rewrite upgrade proxy → API `src/ws/console.ts`: `requireUser` + `assertServerPermission(id, "server.control")`, then opens upstream WS to agent with Bearer token
→ agent `src/ws/console.ts`: `container.logs({follow, tail:200})`, hand-rolled Docker frame demux → `{type:"log"}` frames; inbound `{type:"command"}` → `rcon-cli` exec.
Chat tab reuses the same socket plus `GET /servers/:id/chat` (API pass-through → agent parses timestamped container logs into say/join/leave/death events; no DB persistence, 2k-line window).

## Backup / restore

Create: API inserts `Backup` row `status:"running"` (name `manual-<ISO>` or `scheduled-<ISO>`) → agent `POST /servers/:id/backups` tars `/data` inline (excludes top-level `cache/` and `logs/` only) into `BACKUP_ROOT/<serverId>/<name>.tar.gz` → API updates row to `success` (path, sizeBytes) or `failed`.
Restore: API `POST /backups/:id/restore` → agent wipes the data dir then extracts the tar from the DB-stored absolute path (non-atomic; no stopped-check on the agent side).
Retention: API-only — scheduled runs and manual prune delete only `success` + `scheduled-` prefixed rows (keep N, default 24), deleting the agent file best-effort and the DB row unconditionally.

## Content install

API builds an `InstallPlan` from provider APIs (Modrinth always on; CurseForge iff API key stored encrypted in `IntegrationSetting`) → agent `POST /servers/:id/install`:
- `target: mods|plugins|datapacks` → download URLs into `/data/<target>` (whole-body buffering).
- `target: modpack-env` → merge env into container config, stop + remove + recreate container (left stopped; next start pulls the pack).
Client-side content: staged under `/data/.cofemine-client/{mods,shaderpacks,resourcepacks}`, exported into `.mrpack` (`GET /servers/:id/export-mrpack`, streamed ZIP) and served publicly via `/p/<token>.mrpack` for launchers (`docs/pack-integration.md` is the current contract).

## Live maps

Browser → web rewrite (`/api/servers/:id/map/*`) → `map-proxy` process → RBAC (cached 30s) → agent `GET /servers/:id/proxy/:port/*` (GET-only, container IP cached 10s) → BlueMap (:8100) or dynmap (:8123) inside the MC container. Map type detection via `/servers/:id/map/probe`.

## Scheduler

croner in the API process (UTC), rebuilt from DB on every schedule CRUD. Actions: `restart`, `backup`, `command`, `announce` — each is just an agent HTTP call; `lastRunAt` stamped after. Not audited, not multi-instance safe, in-flight runs die with the process (rows may stay `running`).

## Acknowledgment & retry semantics

- API→agent calls are single-shot (no retry); failures surface as HTTP errors to the UI. Only provider HTTP (Modrinth) retries (3x backoff).
- Backup/install operations are not idempotent and have no resume; re-running creates/overwrites by name.
- The seed and `db push` on API boot are the only self-healing steps in deployment.

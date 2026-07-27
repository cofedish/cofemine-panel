---
name: project-architecture
description: Use when reasoning across services — tracing a request from browser to Minecraft container, adding a feature that spans web/api/agent, changing trust boundaries, service topology, or cross-service contracts, or deciding where new logic belongs.
user-invocable: false
---

# Project architecture (cross-service)

## Scope

The whole system: how `web`, `api`, `map-proxy`, `agent`, `db`, and `maven-cache`
fit together, which direction dependencies point, and where state lives. For
subsystem depth, the per-area skills (`api-backend`, `node-agent`, `web-frontend`,
`database-and-persistence`, …) take over.

## Component ownership

- `apps/web` — UI only. Talks to same-origin `/api`; Next rewrites route to `api` and `map-proxy` containers. No secrets, no Docker, no DB.
- `apps/api` — the only holder of both sides: Postgres (Prisma) and agent addresses/tokens. Auth, RBAC, audit, scheduler, content-provider APIs, WS console proxying.
- `apps/api` `src/map-proxy-main.ts` — second entrypoint of the same codebase/image, deployed as the `map-proxy` service: only map routes + auth, isolates BlueMap tile fan-out from the API event loop.
- `apps/agent` — Docker executor. Stateless; only service with `docker.sock`. Owns MC container lifecycle, files under `DATA_ROOT/<serverId>`, backup archives under `BACKUP_ROOT/<serverId>`, log/console streaming, install execution, maven-cache sidecar management.
- `packages/shared` — contracts: zod schemas, RBAC matrix, server types. Raw-TS package consumed by all three apps.
- `services/maven-cache` — infra sidecar (nginx/squid/gost) for CDN caching; configured by env + CA volume seeded by the agent.

## Dependency directions (allowed → )

browser → web → api → agent → Docker Engine → MC containers.
api → Postgres. api → Modrinth/CurseForge/Mojang public APIs. agent → CDNs (downloads).
Forbidden: web→agent, web→db, agent→db, agent→api (agent never calls back; it only answers), api→docker.

## Trust boundaries

1. Browser ↔ web/api: session cookie `cofemine_session` (JWT + DB session row). All authorization decisions happen in the API (`auth/rbac.ts`). UI hides nothing by role — that is intentional.
2. api ↔ agent: single shared Bearer `AGENT_TOKEN` (env-resolved per node: `AGENT_TOKEN_<NODENAME>` fallback `AGENT_TOKEN`, constant-time compared). The agent fully trusts authenticated callers, but validates its own inputs anyway — backup paths are confined to the backup root, outbound download URLs must be public https. Anything that widens what the API sends to the agent widens what a compromised API can do to the host.
3. Unauthenticated public zone: `/p/*` (client modpack downloads by token; `/p/index.json` enumerates all public-token servers by design) and `/health`. `/ws/*` bypasses the global auth gate but the WS handler re-checks user + `server.control`.
4. maven-cache MITM: MC containers trust a panel-generated CA (imported into JVM via entrypoint override) so squid can ssl-bump whitelisted CDN hosts. This CA is a real trust root inside every MC container.
5. MC containers themselves are untrusted workloads: the agent only touches them via Docker API and `rcon-cli` exec.

## Identity & idempotency

- `Server.id` (cuid) is the universal key: container label `cofemine.serverId`, data dir name, backup dir name, RCON password derivation (`rcon-<id>`).
- Container identity: labels only; `containerId`/`containerName` cached in DB but re-resolvable.
- Seed (`apps/api/prisma/seed.ts`) is idempotent by count checks (users, nodes, templates) and runs on every API boot.

## Crash & consistency model

- DB row first, side effect second, row updated after (servers, backups). A crash between leaves rows in transitional states (`running` backup, `creating` server) — status reconciliation happens lazily (`servers/status.ts` polls agent state; backups have no reconciler, stuck rows stay).
- The agent has no persistence, no locks, and runs long work inline in HTTP requests; the API's undici timeouts are the only watchdog.
- The croner scheduler is in-process in the API — running two API replicas double-fires every schedule. Single-instance API is an architectural assumption.

## Forbidden shortcuts

- Don't give any service a second data store or move state between services "temporarily".
- Don't bypass `NodeClient` for agent calls in the API (exceptions already exist for raw streaming in `export-mrpack.ts` and `map-routes.ts` — don't add more without need).
- Don't add routes to the agent that accept host paths outside `DATA_ROOT`/`BACKUP_ROOT` semantics.
- Don't make the web app aware of nodes' agent URLs or tokens.

## Verification after cross-service changes

`pnpm typecheck` (all packages), then `docker compose up --build` and exercise the
affected flow (create → start → console → files → backup happy path). No automated
tests exist.

## Supporting files

- [architecture.md](architecture.md) — component relationships and per-service detail.
- [data-flow.md](data-flow.md) — end-to-end flows (create/start, console, backup, install, maps, public packs).
- [references.md](references.md) — docs inventory with per-file trust level (several docs are stale).

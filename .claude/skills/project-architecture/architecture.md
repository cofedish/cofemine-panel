# Component architecture

```
Browser ◄────────► web (Next.js 14, :3000)
                    │  rewrites /api/* (order-sensitive, next.config.mjs)
                    ├────────────► api (Fastify+Prisma, :4000) ◄──► Postgres
                    └─ map paths ► map-proxy (:4500, same image/codebase)
                                     │
                    api & map-proxy ─┤ HTTP/WS + Bearer AGENT_TOKEN
                                     ▼
                                  agent (Fastify+dockerode, :4100) ── docker.sock
                                     │ labels cofemine.*
                                     ▼
                          itzg/minecraft-server containers (one per Server row)
                                     │ HTTPS via maven-cache (nginx/squid/gost)
                                     ▼
                          loader/CDN downloads (cached, optionally ssl-bumped)
```

## web (`apps/web`)

- Next.js 14.2 App Router, all pages client components; `(app)` route group wrapped in `AuthGate` (client-side guard; no middleware).
- Routes: `/` dashboard, `/servers/new` wizard, `/servers/[id]` (10 tabs: overview, console, chat, files, properties, env, backups, schedules, content, diagnostics), `/servers/[id]/map` (full-page map), `/infrastructure` (nodes), `/integrations`, `/administration` (users + audit), `/settings`, plus `/setup`, `/login`, `/forgot-password`, `/reset-password`.
- Single fetch wrapper `src/lib/api.ts`; SWR polling; WebSocket console/chat connect to `/api/ws/servers/:id/console` and ride through the Next rewrite's implicit upgrade proxying.
- Env (server-side only): `API_INTERNAL_URL`, `MAP_PROXY_INTERNAL_URL`. Zero `NEXT_PUBLIC_*`.

## api (`apps/api`)

- Entry `src/main.ts`; plugin/hook order is load-bearing (auth hook → global gate → routes → scheduler). Second entry `src/map-proxy-main.ts` (map routes only).
- Route modules per resource under `src/{auth,nodes,servers,backups,schedules,templates,users,audit,integrations,meta,ws}/`. `servers/routes.ts` (~1500 lines) and `integrations/routes.ts` (~650) are the monoliths.
- Runs under `tsx` in production (raw-TS shared package). `dist/` is built in the image but never executed.
- In-process state to know about: croner job map (scheduler), `loaderJobs` map (background loader installs), permission/node caches in `map-routes.ts` (30–60s TTL), Modrinth compat cache (5 min). All lost on restart; none multi-instance safe.

## agent (`apps/agent`)

- Entry `src/main.ts`; all routes at root; one global bearer preHandler (`/health` exempt).
- `src/runtime/` — `MinecraftRuntimeProvider` interface + single `ItzgRuntimeProvider` implementation (registry hardcodes `"itzg"`).
- `src/routes/servers.ts` (~4500 lines) — lifecycle, files, properties, icons, client-mods staging, loader installers, installed-content enrichment, chat/install-failure log parsing, crash reports, stats, players, mrpack export. Contains a literal NUL byte → ripgrep sees it as binary.
- `src/routes/{backups,install,proxy,maven-cache}.ts`, `src/ws/console.ts`.
- Only app running compiled output (`node dist/main.js` in the image).

## db

Postgres; schema owned by `apps/api/prisma/schema.prisma`; applied by `db push` from the API entrypoint (no migrations directory).

## maven-cache (`services/maven-cache`)

nginx (:80 path-prefixed 40 GB cache) + squid (:8081, ssl-bump for whitelisted CDN hosts using the panel CA, splice otherwise) + gost relays (chain to optional `MAVEN_CACHE_UPSTREAM` host proxy). CA material is split across three volumes seeded by the agent (`apps/agent/src/routes/maven-cache.ts`): `cofemine_maven_cache_ca_key` (cert + private key, mounted only by the sidecar), `cofemine_maven_cache_ca_pub` (cert + `.ready` + `import.sh`, mounted by new MC containers), and the pre-split `cofemine_maven_cache_ca` which older MC containers still bind — kept public-only with `ca.key` truncated on every agent start, since container binds are immutable. The certificate is valid 180 days and carries name constraints, which bind OpenSSL clients but **not** the JVM (it drops anchor constraints) — key confinement is the real control. The agent can also recreate the sidecar container (`POST /maven-cache/recreate`). Wired to MC containers by `ItzgRuntimeProvider` when `AGENT_MAVEN_CACHE_HOST` is set (proxy env + installer URL rewrites + CA import entrypoint).

## Compose topology

Six services in both `docker-compose.yml` (dev, build contexts, `${VAR:?}` guards, web port published) and `docker-compose.prod.yml` (GHCR images, no guards, no published ports, external Caddy network `${CADDY_NETWORK:-caddy}` joined by `web` and `maven-cache`). Networks: `cofemine_internal` (panel services), `cofemine_mcnet` (MC containers + agent). Only `agent` mounts `docker.sock`.

## Multi-node status

Schema-ready (`Node` model, `Server.nodeId`, per-node token convention `AGENT_TOKEN_<NAME>`), but: memberships have no management UI/routes, `Node.tokenHash` is never read (env is authoritative), and compose registers a single `local` node via seed. Treat multi-node as designed-for, not exercised.

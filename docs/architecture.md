# Architecture

## Services

One Compose project (`cofemine`), six services. The browser only ever talks to `web`; the Docker
socket is mounted into exactly one container.

```
        Browser
           │  same-origin /api/* — httpOnly session cookie, no CORS
           ▼
    ┌─────────────┐         ┌──────────────┐
    │     web     │────────►│  map-proxy   │  /servers/:id/map/*
    │  Next.js 14 │         │  Fastify     │  BlueMap + dynmap tiles
    └──────┬──────┘         └──────┬───────┘
           │ /api/*                │
           ▼                       │ Bearer AGENT_TOKEN
    ┌─────────────┐  Prisma  ┌─────▼────┐
    │     api     │─────────►│    db    │  Postgres 16
    │  Fastify 4  │          └──────────┘
    └──────┬──────┘
           │ Bearer AGENT_TOKEN
           ▼
    ┌─────────────┐
    │    agent    │  the only container with /var/run/docker.sock
    │  dockerode  │
    └──────┬──────┘
           │ Docker Engine API
           ▼
    ┌──────────────────────────┐     ┌───────────────┐
    │ itzg/minecraft-server ×N │────►│  maven-cache  │
    │   one per game server    │     │ nginx + squid │
    └──────────────────────────┘     └───────────────┘
```

Each service has one job. `web` never sees the agent or the Docker socket; the agent never sees
Postgres; the API is the only place that knows both sides.

### `web` — Next.js 14 App Router

Renders the dashboard, server list, per-server tabs (console, chat, files, properties, env, content,
client pack, backups, schedules, map, diagnostics), plus infrastructure, integrations, administration
and settings.

`next.config.mjs` rewrites `/api/*` to the API and `/api/servers/:id/map/*` to the map proxy — order
matters, the map rule is more specific and must come first. Keeping the API same-origin is what lets
the session cookie stay httpOnly with no CORS on the browser side; the same rewrite carries the
console WebSocket upgrade.

No backend logic and no server-side data fetching: it is a pure API client. All HTTP goes through
`src/lib/api.ts`. The UI deliberately does not hide controls by role — authorization is server-side
only, so a hidden button would be decoration, not a control.

### `api` — Fastify 4 + Prisma 5 + Zod

Owns every piece of domain state:

- **Auth** — bcrypt (cost 12); JWT pinned to HS256 *and* a `Session` row holding `sha256(jwt)`, both of
  which must validate, so revocation is a row delete. Login is throttled per identifier scoped by
  source address. First-run setup can be gated behind `SETUP_TOKEN`.
- **RBAC** — `OWNER > ADMIN > OPERATOR > VIEWER` from an allowlist matrix in `@cofemine/shared`. A
  global OWNER/ADMIN role applies to every server; OPERATOR and VIEWER need a `Membership` row on the
  specific server. `assertServerPermission` and the `GET /servers` visibility filter encode the same
  rule and must stay in sync.
- **Audit** — an `AuditEvent` row on every mutating action, including scheduler runs.
- **Domain** — `Node`, `Server`, `Template`, `Backup`, `Schedule`, `Membership`, `IntegrationSetting`,
  `Session`, `PasswordResetToken`.
- **Scheduler** — [`croner`](https://github.com/hexagon/croner) in-process, rebuilt on CRUD. Cron is
  five fields only (a sixth means seconds). Each schedule records its creator and that user's
  `server.edit` permission is re-checked before every run.
- **Content providers** — Modrinth and CurseForge behind a shared `ContentProvider` interface;
  integration secrets are AES-256-GCM at rest.
- **Node client** — a thin `undici` client for agents. Tokens come from the environment
  (`AGENT_TOKEN`, or `AGENT_TOKEN_<NODE>`); `Node.tokenHash` is write-only and vestigial — a hash
  cannot be turned back into a token, and nothing reads it.

Responses are projected explicitly. Whole Prisma models are never returned, and env blobs pass through
`redactEnv`, with `restoreRedactedEnv` on the write path so the editor cannot save the mask over a
real secret.

### `map-proxy` — the API image, different entrypoint

Runs `src/map-proxy-main.ts` on :4500 and serves only the live-map routes. It exists because BlueMap
fans out a hundred-plus parallel tile fetches per player movement, and serving that from the panel's
event loop made unrelated pages feel stalled. Same image, same auth hook, same permission checks —
just its own pid, event loop and connection pools. It is not dead code.

### `agent` — Fastify + dockerode

The only service that may touch Docker. It authenticates every inbound request against a single shared
bearer token, so everything reaching it is already post-authorization: the API is its only legitimate
caller.

Responsibilities: container lifecycle, stats and health, the file manager, `server.properties`
read/merge/write, backups and restore, content install execution, `.mrpack` export, log streaming, and
`rcon-cli` exec for console commands. MC container specs are built only by `ItzgRuntimeProvider`, which
maps a `ServerSpec` onto the itzg image and decides mounts, capabilities, limits and network itself —
the API never sends a `HostConfig`.

The agent is stateless: no database, no timers, no job queues. Scheduling, retention and persistence
all live in the API.

### `db` — Postgres 16

Only the API connects to it. Schema is applied with `prisma db push` on boot; there is no migration
history, so destructive schema edits are data-loss events.

### `maven-cache` — nginx + squid + gost

A caching proxy for loader and CDN downloads, on the MC network so every game container can reach it.
nginx caches predictable artifact paths and also serves the public launcher mirror; squid handles
CONNECT traffic and, when a CA is configured, intercepts a small allowlist of artifact CDNs so jar
bodies become cacheable. Mojang session domains are explicitly spliced, never intercepted.

Its CA lives in three volumes: a private one holding the key (mounted only here), a public one with
just the certificate for new game containers, and the original volume kept as public-only material for
containers created before the split, whose binds cannot be changed without recreating them.

### `docker-shim` — scaffold, not wired

An in-progress service intended to hold the Docker socket alone, so the agent's much larger surface
(file manager, uploads, downloads, archive extraction) stops running beside it. Nothing references it
yet. See the hardening plan for the migration inventory.

## Data flow — happy path

1. The wizard posts `POST /api/servers`; the browser hits `web`, which rewrites to `api`.
2. The API validates with a shared Zod schema, writes a `Server` row, resolves the node's agent URL and
   token, and calls `POST /servers` on the agent.
3. The agent builds `ContainerCreateOptions` through `ItzgRuntimeProvider`, pulls the image if missing,
   creates the container and returns its id.
4. The API stores `containerId` and `containerName`.
5. **Start** → `POST /api/servers/:id/start` → agent starts the container, recovering from a port still
   held by a zombie.
6. **Console** → the browser opens `/api/ws/servers/:id/console`; the API checks `server.control`, opens
   an upstream socket to the agent, and the agent streams demuxed Docker logs and runs `rcon-cli`
   inside the container for input.
7. **Backup** → the API creates a `Backup` row in `running`, the agent tars `/data` inline, and the API
   records size, path and final status. Archives never cross the wire; they stay on the agent host.

## Trust boundaries

These are enforced, not conventional — treat a change to any of them as an architectural decision:

- Only the **agent** uses dockerode or the Docker socket. Never add Docker calls to the API or web.
- Only the **API** uses Prisma. The agent has no database access.
- The **web** app talks exclusively to same-origin `/api` through one module. No `NEXT_PUBLIC_*` API
  URLs, no direct agent calls.
- **Authorization is server-side only.** Never treat UI visibility as a permission check.
- The **agent trusts the API entirely.** That is why user-supplied paths still go through
  `safeResolve` or a bare-filename check, backup archives through `resolveArchivePath`, and outbound
  URLs through `assertSafeDownloadUrl`: the agent writes as root next to the Docker socket, so a
  traversal there is host compromise, not a misplaced file.
- The **Docker socket is root-equivalent on the host.** Anything that can drive it can start a
  privileged container. This is the single largest residual risk in the design; see
  [security.md](security.md).

## Multi-node

The schema is ready for it even though deployments are single-node in practice: every `Server` has a
`nodeId`, `NodeClient.forId(nodeId)` resolves the right host and token, and agents are stateless, so
one per Docker host registered under its own name is all it takes. Single-node dev is the same code
path — compose just registers `local` pointing at the bundled agent.

One gap to know about: there is no API surface for creating `Membership` rows yet, so scoped
OPERATOR/VIEWER accounts currently have no reachable server access.

## Why `itzg/minecraft-server`?

It is the de-facto standard Minecraft Docker image: actively maintained, supports every modern server
type, handles version and loader downloads, understands Modrinth and CurseForge modpack sources,
enables RCON, and has sane `/data` defaults. Writing a bespoke runtime would import years of footguns
for no gain. `MinecraftRuntimeProvider` leaves the door open for alternatives.

## Security posture

See [security.md](security.md) for the threat model, what is enforced, and what is knowingly not.

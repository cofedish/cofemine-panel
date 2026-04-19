# Architecture

## Services

```
┌────────────┐      ┌────────────┐      ┌────────────┐
│  panel-web │─────►│  panel-api │─────►│ node-agent │──► Docker Engine
│  Next.js   │ HTTP │  Fastify   │ HTTPS│  Fastify   │      │
│            │ WS   │  Prisma    │ WS   │  dockerode │      ▼
└────────────┘      └────┬───────┘      └────────────┘   itzg/minecraft
                         │ TCP                              (per server)
                         ▼
                   ┌──────────┐
                   │ Postgres │
                   └──────────┘
```

Each service has one job. The panel-web never sees the agent or the Docker socket; the agent never sees Postgres; the API is the only place that knows both sides.

### `panel-web` (Next.js 14)

- Renders dashboard, servers list, server detail (with tabs), nodes, templates, users, audit, integrations, settings.
- Uses Next.js `rewrites()` to proxy `/api/*` → `panel-api`. That keeps the httpOnly session cookie same-origin and removes the need for CORS on the browser side.
- Live console uses a WebSocket via the same rewrite.
- No backend logic — it is a pure client of the API.

### `panel-api` (Fastify + Prisma)

Owns:

- **Auth**: JWT sessions stored in httpOnly cookies, bcrypt password hashing, session rows in Postgres (hashed), `/auth/setup` bootstrap.
- **RBAC**: global roles (`OWNER > ADMIN > OPERATOR > VIEWER`) and per-server memberships with overrides. Every route checks permission explicitly.
- **Audit log**: `AuditEvent` rows on every mutating action.
- **Domain**: `Node`, `Server`, `Template`, `Backup`, `Schedule`, `Membership`, `IntegrationSetting`.
- **Scheduler**: [`croner`](https://github.com/hexagon/croner) runs schedules (restart / backup / command / announce) on a simple in-process loop that rebuilds on CRUD changes.
- **Content providers**: Modrinth + CurseForge behind a shared `ContentProvider` interface. Encrypted API keys (AES-256-GCM) in `IntegrationSetting`.
- **Node client**: thin `undici`-based HTTP client that talks to agents. WebSocket console is proxied via the API.

### `node-agent` (Fastify + dockerode)

- Authenticates inbound requests via a shared bearer token (`AGENT_TOKEN`). The token is stored hashed in the API's `Node` row so the API can re-derive it.
- Provides `MinecraftRuntimeProvider` abstraction. Ships with `ItzgRuntimeProvider` which maps our `ServerSpec` onto the [`itzg/minecraft-server`](https://github.com/itzg/docker-minecraft-server) image: `TYPE=PAPER|VANILLA|FABRIC|…`, `VERSION`, `MEMORY`, port bindings, `/data` bind mount, `ENABLE_RCON=true`.
- Implements server lifecycle, stats, file manager, `server.properties` read/merge/write, backups (tar.gz), restore, content install (download or modpack env var injection), and WebSocket log streaming.
- Uses `rcon-cli` inside the container for console commands.
- All filesystem operations are path-traversal-guarded.

## Data flow — happy path

1. User opens `/servers/new` → fills wizard → `POST /api/servers` (panel-web → panel-api rewrite).
2. API inserts a `Server` row → resolves the node's agent URL + token → calls `POST /servers` on the agent.
3. Agent builds `ContainerCreateOptions` from the `ItzgRuntimeProvider`, creates the container, returns its id.
4. API stores `containerId` + `containerName`, returns success.
5. User clicks **Start** → `POST /api/servers/:id/start` → API calls agent → agent starts container.
6. Console tab opens `ws://.../api/ws/servers/:id/console` → API verifies RBAC, opens an upstream WS to the agent → agent streams demuxed Docker logs + runs `rcon-cli` for commands.
7. Backup: `POST /api/servers/:id/backups` → API creates `Backup` row in state `running` → asks agent to tar `/data` (skipping `cache` + `logs`) → records final size and status.

## Multi-node

Everything is already factored for multi-node:

- Each `Server` row has a `nodeId`.
- `NodeClient.forId(nodeId)` resolves the right host + token.
- Agents are stateless — you can run one on each Docker host and register it under a different name.

Single-node dev is the same code path; the compose file just registers `local` pointing at the bundled agent.

## Why `itzg/minecraft-server`?

It is the de-facto standard Minecraft Docker image: actively maintained, supports all modern server types, handles version/loader downloads, `MODRINTH_PROJECT` / `CF_SERVER_MOD` env vars for modpacks, RCON by default, sane defaults for `/data`. Writing a bespoke runtime would introduce years of footguns for no gain. The `MinecraftRuntimeProvider` interface leaves the door open for alternatives.

## Security posture

See [security.md](security.md).

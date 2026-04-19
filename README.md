# Cofemine Panel

Self-hosted, Docker-first control panel for Minecraft servers. Bring up the panel with `docker compose up`, open the UI, and spin up Vanilla / Paper / Purpur / Fabric / Forge / NeoForge / Mohist / Quilt servers as sibling containers — each with live console, file manager, backups, scheduled tasks, and Modrinth / CurseForge content installers.

> Status: MVP. The architecture, data model, API surface, and happy path (create → start → console → edit `server.properties` → backup) are implemented. Roadmap is tracked in [docs/roadmap.md](docs/roadmap.md).

## Highlights

- **Decoupled services**: `panel-web`, `panel-api`, `node-agent`, Postgres, optional Redis. The frontend never touches `docker.sock` directly.
- **Docker Engine SDK, no shell spaghetti**: node-agent uses `dockerode`.
- **Battle-tested runtime**: MC servers run on [`itzg/minecraft-server`](https://github.com/itzg/docker-minecraft-server) behind a `MinecraftRuntimeProvider` abstraction.
- **Provider pattern for content**: `ModrinthProvider` + `CurseForgeProvider` implement a common `ContentProvider` interface.
- **RBAC**: owner / admin / operator / viewer at both global and per-server scope, with audit log.
- **Realtime console**: WebSocket proxies Docker stdout and `exec` input through the API to the browser.
- **Multi-node ready**: the schema has `Node`, the agent authenticates via a per-node bearer token, and a single-node compose wires one agent locally.

## Quick start (dev)

```bash
cp .env.example .env
# Generate a SECRETS_KEY and pick JWT_SECRET / AGENT_TOKEN
docker compose up --build
```

Open http://localhost:3000 and complete first-run setup. The local node is registered automatically from compose.

## Architecture

```
                 ┌──────────────┐
   Browser ◄────►│   panel-web  │ (Next.js)
                 └──────┬───────┘
                        │ HTTPS / WS
                 ┌──────▼───────┐        ┌──────────┐
                 │   panel-api  │◄──────►│ Postgres │
                 │ (Fastify)    │        └──────────┘
                 └──────┬───────┘
                        │ HTTPS / WS (bearer token)
                 ┌──────▼───────┐
                 │  node-agent  │  (Fastify + dockerode)
                 └──────┬───────┘
                        │ Docker Engine API
                 ┌──────▼───────────────────────────┐
                 │  itzg/minecraft-server container │  per MC server
                 └──────────────────────────────────┘
```

Full architecture write-up: [docs/architecture.md](docs/architecture.md).

## Repository layout

```
apps/
  api/      — Fastify panel API + Prisma + Postgres
  agent/    — Fastify node-agent (talks to Docker, streams logs, runs backups)
  web/      — Next.js 14 frontend
packages/
  shared/   — shared zod schemas and types
docs/       — architecture, deployment, API, security, roadmap
docker-compose.yml
docker-compose.prod.yml
```

## Supported runtimes (today)

Vanilla, Paper, Purpur, Fabric, Forge, NeoForge, Mohist, Quilt — via `itzg/minecraft-server` environment variables. New runtimes can be added by implementing `MinecraftRuntimeProvider`.

## Content installers

- **Modrinth**: project search, version filtering by game version / loader, modpack + mods / plugins / datapacks install via `MODRINTH_PROJECT` or direct download into `/data/mods`.
- **CurseForge**: enabled by pasting an API key in Integrations. Without a key, the UI falls back to manual ZIP import, which is documented, not magic.

## Docs

- [Architecture](docs/architecture.md)
- [Development](docs/development.md)
- [Deployment](docs/deployment.md)
- [API reference](docs/api.md)
- [Security model](docs/security.md)
- [Roadmap](docs/roadmap.md)

## License

MIT.

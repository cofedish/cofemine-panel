# Development

## Prerequisites

- Node.js 20+ (we use TypeScript across the stack)
- pnpm 9 (the repo is a pnpm workspace)
- Docker Desktop / Docker Engine 24+
- `openssl` for generating the `SECRETS_KEY`

## First-time setup

```bash
cp .env.example .env
# required:
#   JWT_SECRET — any long random string
#   AGENT_TOKEN — any long random string
#   SECRETS_KEY — `openssl rand -base64 32`
```

## Run everything via docker compose (recommended)

```bash
docker compose up --build
```

This brings up Postgres, `panel-api`, `node-agent`, and `panel-web`. On first start, `panel-api` runs `prisma migrate deploy` + the seed script (which registers the local node and demo templates). Open http://localhost:3000 — the UI detects the empty user table and redirects you to first-run setup to create the initial OWNER account.

## Run locally without compose

You need a running Postgres (or use `docker compose up db`) and a Docker daemon the agent can reach.

```bash
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm db:seed
pnpm -r --parallel --filter "./apps/*" run dev
```

The web dev server proxies `/api/*` to `http://api:4000`. When running outside compose, set `API_INTERNAL_URL=http://localhost:4000` for the web process.

## Common tasks

- **Prisma Studio**: `cd apps/api && pnpm exec prisma studio`
- **Add a new schema field**: edit `apps/api/prisma/schema.prisma`, then `pnpm db:migrate --name <desc>`.
- **Regenerate the Prisma client** after schema changes: `pnpm db:generate`
- **Type-check everything**: `pnpm typecheck`
- **Reset the database (dev only)**: `cd apps/api && pnpm exec prisma migrate reset`

## Debugging the agent

The agent logs everything at debug level in development. To watch Docker events directly: `docker events --filter 'label=cofemine.managed=true'`.

To inspect a Minecraft container's env: `docker inspect cofemine-mc-<slug>-<id> | jq .Config.Env`.

## Tests

No test suite is included in the MVP. Integration tests would run against a real Postgres and a Docker-in-Docker agent — something to add alongside the first CI pipeline.

## Project layout

```
apps/
  api/    @cofemine/api     Fastify + Prisma
  agent/  @cofemine/agent   Fastify + dockerode
  web/    @cofemine/web     Next.js 14
packages/
  shared/ @cofemine/shared  zod schemas, role matrix, types
```

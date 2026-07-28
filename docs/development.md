# Development

## Prerequisites

- Node.js 20+ — TypeScript across the whole stack
- pnpm 9 — the repo is a pnpm workspace, and the version is pinned in `packageManager`
- Docker Desktop / Docker Engine 24+
- `openssl` for generating secrets

## First-time setup

```bash
cp .env.example .env
```

Three values must be real — the API validates them at startup and refuses to boot on the shipped
placeholders:

```bash
openssl rand -base64 32   # SECRETS_KEY — exactly 32 bytes of base64
openssl rand -hex 32      # JWT_SECRET — at least 32 characters
openssl rand -hex 32      # AGENT_TOKEN
```

## Run everything via Docker Compose (recommended)

```bash
docker compose up --build
```

That brings up six services: `db`, `api`, `map-proxy`, `agent`, `web` and `maven-cache`. On first
start the API waits for Postgres, applies the schema with `prisma db push`, and runs the idempotent
seed, which registers the local node and demo templates. Open <http://localhost:3000> — with an empty
user table the UI redirects you to first-run setup to create the owner account.

Only `web` publishes a host port. The agent is deliberately unreachable from the host.

## Run locally without Compose

You need Postgres (`docker compose up db` is enough) and a Docker daemon the agent can reach.

```bash
pnpm install
pnpm db:generate
pnpm db:push          # apply schema — see the note below
pnpm db:seed
pnpm dev              # tsx watch for api/agent + next dev for web
```

The web dev server proxies `/api/*` to `http://api:4000`, which only resolves inside Compose. Outside
it, set `API_INTERNAL_URL=http://localhost:4000` and `MAP_PROXY_INTERNAL_URL=http://localhost:4500`
for the web process.

## Schema changes — there are no migrations

This is the sharpest edge in the repo. `apps/api/prisma/` contains no `migrations/` directory, and the
entrypoint applies the schema with `prisma db push --accept-data-loss` on every boot.

- **Do not** run `pnpm db:migrate` or `db:deploy`. Those scripts are left over from a migration
  workflow this repo does not use; there is no history for them to operate on. `pnpm db:push` is the
  one that matches what the container entrypoint actually does.
- To change the schema: edit `apps/api/prisma/schema.prisma`, run `pnpm db:generate` to refresh the
  client, and let `db push` reconcile the database.
- `db push` diffs the live schema against the file, so **a column rename is a drop plus a create** and
  the data in it is gone. Additive changes (new nullable columns, new columns with defaults) are safe.
  Anything else against a database you care about needs a dump first.
- To reset a dev database: `docker compose down -v` and bring it back up.

## Common tasks

| Task | Command |
|---|---|
| Type-check everything | `pnpm typecheck` |
| Full build | `pnpm build` |
| Regenerate the Prisma client | `pnpm db:generate` |
| Prisma Studio | `cd apps/api && pnpm exec prisma studio` |
| Re-run the seed | `pnpm db:seed` |

`pnpm typecheck` is the de-facto quality gate — it is what CI runs before any image is built, and it
is the last thing to run before calling a change done.

`pnpm lint` is **not** wired up: ESLint is not installed anywhere, and `next lint` would prompt
interactively.

## Debugging the agent

The agent logs at debug level in development.

```bash
# watch lifecycle events for panel-managed containers
docker events --filter 'label=cofemine.managed=true'

# inspect a game container's env
docker inspect <container> | jq '.[0].Config.Env'

# what the agent actually applied to a container
docker inspect <container> --format \
  'caps={{.HostConfig.CapAdd}} pids={{.HostConfig.PidsLimit}} sec={{.HostConfig.SecurityOpt}}'
```

Containers are found only by their `cofemine.*` labels, never by name — `cofemine.serverId` is the one
that matters.

Note that the agent runs compiled output (`node dist/main.js`), unlike the API and web which run from
source. A `dist/` directory in your working tree is stale build output; never read it as reference.

## Tests

There is no test runner in the repository. Verification is `pnpm typecheck` plus a Compose smoke run.
The highest-value thing to add first would be a table test over `assertServerPermission` (role ×
membership × permission) and a traversal test on the map proxy — both are boundaries that have
regressed before and that type-checking cannot catch.

## Project layout

```
apps/
  api/           @cofemine/api          Fastify 4 + Prisma 5 + Zod
  agent/         @cofemine/agent        Fastify + dockerode (the only Docker client)
  web/           @cofemine/web          Next.js 14 App Router
  docker-shim/   @cofemine/docker-shim  scaffold, not yet wired into the stack
packages/
  shared/        @cofemine/shared       zod schemas, role matrix, server types
services/
  maven-cache/                          nginx + squid + gost caching proxy
```

`@cofemine/shared` is published as **raw TypeScript** — the API imports it at runtime through `tsx`
and the web app transpiles it. A type error there breaks API boot and the web build at the same time,
so run `pnpm typecheck` across the workspace after touching it.

## Conventions

Per-area conventions live in `.claude/rules/` and are worth reading before a first change: API route
patterns, agent path-safety rules, web data-fetching, and the compose/deploy invariants. The project
map in `CLAUDE.md` explains where each piece of state lives and which boundaries are enforced.

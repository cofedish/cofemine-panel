---
name: deployment-and-operations
description: Use when changing docker-compose files, Dockerfiles, the GitHub Actions deploy workflow, entrypoints, env var wiring, the maven-cache sidecar config, or diagnosing deploy/runtime/production issues.
user-invocable: false
paths:
  - "docker-compose.yml"
  - "docker-compose.prod.yml"
  - ".github/**"
  - "services/**"
  - "apps/api/docker-entrypoint.sh"
---

# Deployment & operations

## The pipeline (verified against .github/workflows/deploy.yml)

Push to `main` → matrix-build **4 images** (api, agent, web, maven-cache) → GHCR
(`ghcr.io/<repo>/<svc>`, tags `latest` + `sha-<short>`) → SSH to the prod host →
`git reset --hard origin/main` → `compose -f docker-compose.prod.yml pull` (3 retries)
→ `up -d --force-recreate` → post-deploy health loop (~3 min hitting `/health` inside
the api container). Hard restart (`down && up`) via workflow_dispatch input or
`[reset-stack]`/`[hard-restart]` in the commit message (workaround for stale-veth
networking on the host kernel).

CI runs one gate before the image build: a `check` job (`pnpm install` → `pnpm
db:generate` → `pnpm typecheck`) that `build` depends on. There is still no
lint/test job, and nothing verifies runtime behaviour — a type-correct but broken
push reaches production and is caught only by the health probe. Run
`pnpm typecheck` locally before any push; never push without an explicit user
request.

Rollback = re-deploy a `sha-` tagged image set; note schema changes do NOT roll back
(`db push` has no history).

## Compose topology (both files define the same 6 services)

`db` (Postgres + `db_data` volume) · `maven-cache` · `agent` (the only docker.sock
mount) · `api` · `map-proxy` (api image, `command: tsx src/map-proxy-main.ts`) · `web`.
Networks: `cofemine_internal`, `cofemine_mcnet`; prod adds external
`${CADDY_NETWORK:-caddy}` joined by `web` and `maven-cache` (no published ports in
prod — Caddy reverse-proxies `web:3000`; `docs/Caddyfile.example` is accurate).

Dev/prod deltas that bite:
- Dev has `${VAR:?}` fail-fast guards on AGENT_TOKEN/JWT_SECRET/SECRETS_KEY; **prod does not** — a missing prod env var silently becomes empty (empty `AGENT_TOKEN` also skips local-node seeding).
- Prod omits several vars that then run on in-code defaults (`SESSION_TTL_HOURS`, `MODRINTH_USER_AGENT`, `API_PORT`…).
- `.env.example` lags the compose files (missing `WEB_ORIGIN`, `MAVEN_CACHE_UPSTREAM`, `*_IMAGE`, `CADDY_NETWORK`, `AUDIO_DIR`, `AGENT_MAVEN_CACHE_HOST`, `MAP_PROXY_*`, `API_INTERNAL_URL`…). Add new vars there too.

## Storage invariants

- `${DATA_ROOT:-/var/lib/cofemine/servers}` and `${BACKUP_ROOT:-/var/lib/cofemine/backups}` are **bind mounts at the identical absolute path** host↔agent (MC containers bind the same host paths — a mismatch breaks file access silently). Never convert to named volumes.
- `cofemine_maven_cache_ca_key` (cert + **private key**) is mounted only by `maven-cache`. New MC containers mount `cofemine_maven_cache_ca_pub` (cert-only), created by the agent and absent from compose. `cofemine_maven_cache_ca` is the pre-split volume older MC containers still bind — kept public-only, `ca.key` truncated by the agent on every start.
- `MCNET_CIDR` (optional, `maven-cache`): restricts which source addresses may use squid as a forward proxy. Unset by default because Docker assigns the `cofemine_mcnet` subnet dynamically; without it, neighbours on the shared Caddy network can proxy through it.
- `.local-data/` is the gitignored dev stand-in for these roots.

## Images & entrypoints

All Dockerfiles: multi-stage `node:20-alpine`, pnpm 9.7.0, **`--frozen-lockfile`**
(every stage copies all five workspace manifests + the lockfile, so the frozen
install can validate against the whole workspace). No HEALTHCHECK, no non-root
USER, no devDep pruning.
- **api**: needs `apk add openssl` (Prisma on Alpine); entrypoint waits for DB by retrying `prisma db push --skip-generate --accept-data-loss`, runs the idempotent seed, then `exec pnpm exec tsx src/main.ts`. The tsc `dist/` is built but never executed (shared pkg is raw TS).
- **agent**: fabricates stub package.json files for api/web in the deps stage (pnpm workspace quirk); the only app running compiled `node dist/main.js`.
- **web**: `next build` → `pnpm start`.

## maven-cache service (services/maven-cache)

nginx :80 (path-prefixed 40 GB CDN cache) + squid :8081 (ssl-bump MITM for
whitelisted CDN hosts using the panel CA from the shared volume; splice-only if CA
absent) + gost relays (per-CDN TCP relays; `UPSTREAM_PROXY` from
`MAVEN_CACHE_UPSTREAM` chains through a host-side proxy; `extra_hosts:
host.docker.internal:host-gateway` exists for this). Recreated/managed by the agent
(`/maven-cache/recreate|status`); the API re-pushes proxy+CA config on boot.

## Operational gotchas

- `compose up --force-recreate` clobbers maven-cache proxy/CA state — the API's deferred `applyDownloadProxyToMavenCaches` re-applies it on boot.
- Shell scripts must stay LF (`.gitattributes` enforces; Windows dev machine).
- Deploy docs: trust `docker-compose.prod.yml` + `docs/ci-cd.md` (mostly) + `docs/Caddyfile.example`; **`docs/deployment.md` is misleading** (wrong network/image/volume/migration claims). `docs/ci-cd.md` contains real prod host details — never copy them anywhere.
- Observability = pino stdout via `docker compose logs` + `json-file` rotation in prod. No metrics, no tracing, no error aggregation.

## Verification

For compose/Dockerfile changes: `docker compose config` (syntax), then
`docker compose up --build` locally and check `/health` + one happy-path flow. CI
will build images on push — but remember that push equals production deploy.

---
paths:
  - "docker-compose.yml"
  - "docker-compose.prod.yml"
  - ".github/workflows/**"
  - "services/maven-cache/**"
  - "apps/*/Dockerfile"
  - "apps/api/docker-entrypoint.sh"
  - "docs/Caddyfile.example"
---

# Deployment & compose rules

- **Push to `main` deploys to production automatically** (build 4 images → GHCR → SSH → `git reset --hard` + `compose up -d --force-recreate`). There is no test/typecheck gate in CI. Treat every change to these files as a production change.
- Keep dev and prod compose in sync when adding services/env vars — they define the same six services (`db`, `maven-cache`, `agent`, `api`, `map-proxy`, `web`). Prod has no `${VAR:?}` guards, so a forgotten env var becomes an empty string silently.
- `DATA_ROOT` and `BACKUP_ROOT` must stay bind mounts at the **identical absolute path** on host and in the agent container (MC containers created by the agent bind the same host paths). Never convert to named volumes.
- CA material is split three ways, all with explicit literal `name:` where declared. `cofemine_maven_cache_ca_key` holds `ca.crt` + `ca.key` and is the only one `maven-cache` mounts. `cofemine_maven_cache_ca_pub` (cert-only) is created by the agent and mounted by new MC containers — not declared in compose. `cofemine_maven_cache_ca` is the pre-split volume, still bound by older MC containers; the agent keeps it public-only and truncates its `ca.key`. Never merge them back together.
- Every service carries `no-new-privileges`; `api`/`map-proxy`/`web` also `cap_drop: ALL`. The `agent` drops all caps except `CHOWN`/`DAC_OVERRIDE`/`FOWNER`/`FSETID` and stays root — it chowns `/data` trees, and Docker cannot grant capabilities to a non-root `USER`. `db` and `maven-cache` keep caps because their entrypoints drop privileges themselves.
- Only the `agent` service mounts `docker.sock`. Do not add it elsewhere.
- `map-proxy` is the API image with `command: tsx src/map-proxy-main.ts` — it exists to isolate map tile traffic; don't fold it back into `api`.
- Shell scripts (`docker-entrypoint.sh`, `entrypoint.sh`) must stay LF (`.gitattributes` enforces this) and are executed inside Alpine/Debian containers.
- The API entrypoint applies schema via `prisma db push --accept-data-loss` and re-runs the idempotent seed on every boot — deployment has no migration history; destructive schema changes lose data.
- New env vars consumed by compose should also be added to `.env.example` (it is already missing several — don't widen the gap).
- Installs are `--frozen-lockfile` everywhere (CI + all three Dockerfiles), and each Dockerfile copies **every** workspace `package.json` because a frozen install validates the lockfile against the whole workspace. A dependency change that doesn't commit `pnpm-lock.yaml` fails the build — that is the point.

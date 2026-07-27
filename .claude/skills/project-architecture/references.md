# Documentation inventory & trust levels

Verified against code in 2026-07. Priority on conflict: wired production code >
compose/CI config > docs. Update this table when docs are fixed.

| Doc | Trust | Notes |
|---|---|---|
| `docs/pack-integration.md` | **Current** | Public `/p/*` contract for external launchers; matches `servers/public-pack-routes.ts`. Russian. |
| `docs/Caddyfile.example` | **Current** | Matches prod compose (shared `caddy` network, `reverse_proxy web:3000`). |
| `docs/security.md` | Mostly current | Session/RBAC/crypto claims verified. Omits: maven-cache MITM CA trust root, public `/p/*` enumeration zone. |
| `docs/ci-cd.md` | Mostly current | Matches `deploy.yml` secrets/flow. Stale: says 3 images (now 4 incl. maven-cache), health-wait duration, web port-binding story. Contains real deploy host details — do not propagate. Russian. |
| `docs/development.md` | Partly stale | Claims `prisma migrate deploy` on start — actually `db push`. "No test suite" claim is accurate. Layout omits `services/`. |
| `docs/architecture.md` | Partly stale | Good happy-path narrative, but describes 3-service topology — missing `map-proxy` and `maven-cache`. |
| `docs/roadmap.md` | Stale | Lists as future work things already shipped (password reset, content viewer); CI quality gate still genuinely pending. |
| `docs/api.md` | **Stale** | Documents <half the actual route surface (missing `/meta`, `/p/*`, map routes, ~35 server sub-routes, prune, password reset). Route files are the source of truth. |
| `docs/deployment.md` | **Misleading** | Wrong external network name (`cofemine_public` vs `caddy`), wrong image names, wrong volume story (`mc_data`/`mc_backups` no longer exist), wrong migration mechanism. Prefer `docker-compose.prod.yml` + `docs/ci-cd.md`. |
| `README.md` | Mostly current | Highlights and layout accurate; architecture diagram shares `architecture.md`'s 3-service staleness. |

Known code-vs-doc contradictions to not re-import into knowledge:

- "Agent authenticates via token stored hashed in the Node row" (README/architecture.md) — `Node.tokenHash` is written but **never read**; env vars are authoritative (`node-client.ts`).
- "Prisma runs migrations on start" — there is no `prisma/migrations/`; `db push --accept-data-loss` is the real mechanism.
- api.md's create-server body predates modpack sources (`MODRINTH`/`CURSEFORGE` types).

---
name: node-agent
description: Use when changing apps/agent — Docker container lifecycle, the itzg runtime provider, file manager and path guards, agent-side backups/restore, console log streaming, rcon commands, content install execution, or the maven-cache sidecar management.
user-invocable: false
paths:
  - "apps/agent/**"
---

# Node agent (apps/agent)

## Scope & responsibility

Stateless Fastify service with the Docker socket. Executes what the API asks:
container lifecycle, filesystem under `DATA_ROOT/<serverId>`, backups under
`BACKUP_ROOT/<serverId>`, log/console streaming, install plans, maven-cache sidecar.
No DB, no timers, no queues — every operation runs inline in the HTTP request; the
API owns persistence, scheduling, retries, and timeouts.

## Entry points

`src/main.ts`: pino, `bodyLimit` 1 GiB, `@fastify/websocket`, one global bearer-token
preHandler (`AGENT_TOKEN`, `/health` exempt), then `servers`/`backups`/`install`/
`proxy`/`maven-cache` routes (all at root) + `consoleAgentWs`. Startup ensures data/backup
dirs, docker network, CA reseed (warn-on-fail). Runs compiled: `node dist/main.js`.

## Container model

- Index: `cofemine.*` labels only (`AGENT_LABEL_PREFIX`); `findContainer` is duplicated in `servers.ts`, `ws/console.ts`, `proxy.ts`.
- Lifecycle: `stopReliably` (RestartPolicy→no, SIGTERM 5s, SIGKILL, bounded wait) and `startWithPortRecovery` (restores `unless-stopped`, force-removes labelled port-squatters). Restart = stop+start. Delete = stop + force-remove + `rm -rf` data dir.
- Spec building: only via `getRuntime("itzg")` → `ItzgRuntimeProvider` (`src/runtime/itzg-provider.ts`). Mapping: `TYPE_MAP` (CURSEFORGE→AUTO_CURSEFORGE), `MEMORY=<mb>M`, RCON always on with a **random per-container `RCON_PASSWORD`** (nothing outside the container needs it — `rcon-cli` runs inside), memory limit = heap + clamp(1–4 GB, 25%), `SecurityOpt: no-new-privileges` + `PidsLimit: 512`, `__COFEMINE_JAVA_VERSION` picks the `javaN` image tag, `__COFEMINE_*` keys stripped, **`UID`/`GID`/`RUN_AS_ROOT`/`SKIP_SUDO` stripped** (would make the JVM root in-container; also rejected by `serverEnvSchema` API-side), `JAVA_TOOL_OPTIONS` merged not clobbered, `/data` bind + optional **public** CA volume (`CA_PUB_VOLUME_NAME`, cert only — never the key) + entrypoint override for the maven cache.
- CA volumes are a three-way split (`routes/maven-cache.ts`): `*_ca_key` (cert+key, sidecar only), `*_ca_pub` (cert-only, new MC containers), `*_ca` (the pre-split volume — containers made before the split still bind it, so `seedCaVolumes()` keeps it public-only and **truncates its `ca.key` on every agent start**). Never write key material to the pub or legacy volume.
- The `MinecraftRuntimeProvider` interface/registry is real but single-implementation; `postCreate` is declared and never used.

## File manager & path safety

`safeResolve(base, userPath)` in `src/paths.ts` is THE traversal guard (throws 400) —
used by files/properties/installed-content/install. Client-mods and crash-report
routes use strict bare-filename checks instead — `assertBareClientFilename`
(upload *and* bulk-download; the download half also runs `assertSafeDownloadUrl`,
because filename+URL together were an RCE path into the docker.sock container).
Backup create/restore/delete confine their path with `resolveArchivePath` in
`routes/backups.ts` (this server's backup dir, or the backup root for delete,
`.tar.gz` only); backup names are `[A-Za-z0-9._-]`. `dataDirFor`/`backupDirFor`
validate `serverId` as a path component.
`server.properties` is served with `rcon.password` masked from both the
properties route and the file manager; the mask is dropped on write.
Outbound fetches on a caller's behalf go through `assertSafeDownloadUrl`
(`src/security.ts`): https only, public addresses only, redirects validated per
hop. Applied to `install.ts` downloads and `openHttpStream`; deliberately NOT to
`downloadInstallerJar`, which targets the internal maven-cache over http.
Files API: reads >2 MB return `truncated:true` (no ranged download exists); writes are
UTF-8 or chunked base64 (`.part` append → rename; keep `chunkIndex`/`totalChunks` in
schemas); deletes are recursive; there is no rename/move endpoint.
`server.properties`: `parseProperties`/`mergeProperties` rewrite keys in place
preserving comments/order, appending new keys.

## Console / logs / parsing

WS `/ws/servers/:id/console`: `container.logs({follow, tail:200})` with a hand-rolled
8-byte-frame demux (assumes whole frames per chunk); commands run `rcon-cli` via
docker exec — the WS path has no length cap (HTTP `/command` caps at 1000). ANSI is
stripped only in `parseListOutput` (players) and the chat parser, not in the console
stream. Chat/install-failure endpoints parse timestamped `container.logs` output —
no persistence.

## Crash & concurrency reality (respect it when changing anything here)

- No locks: concurrent mutations of the same `/data` tree can interleave; the only guard is "must be stopped" 409 on loader install.
- Backup crash → truncated tar left behind (no tmp/rename dance); restore crash → wiped-then-partial `/data`; loader-install crash → unbootable server, no rollback; agent crash after stop → container left with RestartPolicy=no.
- Process-local caches (slug/fingerprint/proxy-target) are volatile and fine to lose; `invalidateProxyTarget` exists but is never called (stale container IP up to 10s after recreate).

## Trust boundaries

Single bearer token, compared with `timingSafeEqualStrings` (`src/security.ts`);
the agent fully trusts authenticated callers. Anything reaching it is post-RBAC.
It's the only component that can destroy host data (`rm -rf` data dirs, backup
deletes) — widening its API surface widens blast radius, so new routes still
validate their own paths and URLs rather than assuming the API did.

The container runs as root on purpose (it chowns `/data` trees; Docker can't
grant caps to a non-root `USER`), but compose drops all capabilities except
`CHOWN`/`DAC_OVERRIDE`/`FOWNER`/`FSETID` and sets `no-new-privileges`. With
`docker.sock` mounted the uid was never the boundary — only rootless Docker
would be.

## Config

Zod-validated in `src/config.ts` (boot-fails): `AGENT_TOKEN` (min 16), `AGENT_DATA_ROOT`,
`AGENT_BACKUP_ROOT`, `AGENT_DOCKER_NETWORK`, `AGENT_LABEL_PREFIX`, `AGENT_MAVEN_CACHE_HOST`,
`DOCKER_SOCKET`/`DOCKER_HOST_URL`, ports/retries. Outside the schema: `AGENT_MC_IMAGE`
(undocumented image override). Per-request config arrives as headers (`x-cf-api-key`,
`x-cf-resolve-all`, `x-cofemine-client-server`).

## Search hazard

`src/routes/servers.ts` (~4500 lines) contains a literal NUL byte → ripgrep/Grep
treat it as binary and return nothing. Read it directly or `grep -a`.

## Tests & verification

None. `pnpm --filter @cofemine/agent typecheck`, then compose up and exercise the
flow. The agent must keep building with `tsc` (its Docker image runs `dist/`).

## Known dead code

`GET /servers/:id/state` (unwired), `streamExecOutput`, `createReadStream/WriteStream`
vestiges in `backups.ts`, `backupId` accepted-but-unused, `resourcepack`/`shader`
install kinds with no matching target, stale working-tree `dist/`.

See [failure-modes.md](failure-modes.md) for the failure catalogue.

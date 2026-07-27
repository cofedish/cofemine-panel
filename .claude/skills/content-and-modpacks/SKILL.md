---
name: content-and-modpacks
description: Use when working on mod/plugin/datapack installs, Modrinth or CurseForge integration, modpack servers, client-side packs (.mrpack export, /p/* public downloads, client-mods staging), loader installers, or the maven-cache download pipeline.
user-invocable: false
---

# Content, modpacks & download pipeline

## Scope

The whole content chain: provider search/planning in the API → install execution on
the agent → itzg/mc-image-helper doing modpack downloads at container boot → client
pack export for external launchers → the maven-cache CDN proxy.

## Roles per component

- **API plans, agent executes.** `ContentProvider.planInstall()` returns URLs/env only (`apps/api/src/integrations/content-provider.ts`); no download happens in the API.
- `ModrinthProvider` (`modrinth-provider.ts`): public API, always enabled, 3-attempt retry, 5-min per-project compat cache (re-checks gameVersion+loader pairs — project-level facets give false positives).
- `CurseForgeProvider` (`curseforge-provider.ts`): enabled iff API key stored (encrypted `IntegrationSetting` key `curseforge.apiKey`), no retry; exports `extractLoaders`/`isMinecraftVersion` reused by `servers/service.ts`.
- Agent `routes/install.ts`: `target mods|plugins|datapacks` → `safeResolve` + download into `/data/<target>` (buffers whole body in memory); `target modpack-env` → merge env, stop+remove+**recreate container, left stopped** — the actual pack download happens on next start via itzg's `MODRINTH_MODPACK`/`CF_*` env.
- Server types `MODRINTH`/`CURSEFORGE` (shared `server-types.ts`) are modpack-source types: `createServerSchema` requires `modpack` for them, `version` for plain loaders. `CURSEFORGE` maps to itzg `AUTO_CURSEFORGE`; CF API key reaches the container via env; per-request CF key can arrive as `x-cf-api-key` header on agent routes.

## Client-side packs (launcher integration)

- Staging: `/data/.cofemine-client/{mods,shaderpacks,resourcepacks}` (dot-prefixed so itzg ignores it). Managed by agent `client-mods` routes: list, auto-detect (scans CF cache for Client-tagged files), bulk server-side download (≤200 URLs), chunked base64 upload, delete.
- Export: `GET /servers/:id/export-mrpack` (agent streams a ZIP via `archiver`; API relays raw — one of the two sanctioned NodeClient bypasses). `.mrpack` = `modrinth.index.json` + panel `manifest.json` + `overrides/`; `files` array intentionally empty.
- Public serving: `/p/<token>.mrpack|.json` + `/p/index.json` (unauthenticated by design; token on `Server.publicPackToken`). Contract doc: `docs/pack-integration.md` (current, Russian).
- `clientPackExclusions`, `cfPackProjectId/FileId`, `clientServerAddress/Name` on the `Server` model support this feature.

## Loader installers

Agent `install-modloader`: runs the NeoForge/Forge/Fabric/Quilt installer inside a
throwaway `eclipse-temurin:21-jre-alpine` container; requires server stopped (409);
wipes stale loader paths first (crash mid-install → unbootable, no rollback).
`download-loader-installer` idempotently fetches installer jars to
`/data/.cofemine-<loader>-installer-<ver>.jar`. API tracks background installs in an
in-memory `loaderJobs` map (lost on restart).

## maven-cache pipeline

When `AGENT_MAVEN_CACHE_HOST` is set, `ItzgRuntimeProvider` injects: installer URL
rewrites (NeoForge/Forge), `HTTP(S)_PROXY`/`NO_PROXY`, JVM proxy flags via merged
`JAVA_TOOL_OPTIONS`, the CA volume mount, and an entrypoint override that imports the
panel CA before `exec /start`. The sidecar itself (nginx cache + squid ssl-bump +
gost relays, `services/maven-cache/`) is managed by agent `maven-cache` routes
(status/recreate; container found by compose label, name `cofemine-maven-cache-1`).
API surfaces status/CA at `/integrations/maven-cache/*`; on boot it best-effort
re-pushes proxy+CA config to all nodes (`applyDownloadProxyToMavenCaches` in `main.ts`).

## Idempotency & failure notes

- Installs are not idempotent: re-running re-downloads/overwrites by filename; no dedup or version tracking beyond what's on disk.
- `installed-content` listing enriches files via Modrinth SHA1 lookup + CF fingerprint (process-local caches: slug 10 min, fingerprint 1h; CONCURRENCY=8 pool).
- Modpack env recreate leaves the container stopped by design — the UI tells users to start; don't "fix" by auto-starting without product intent.
- `resourcepack`/`shader` install kinds exist in the agent schema but have **no matching target** — currently dead enum values.
- Distribution-blocked CF files surface as `distributionBlocked` in version listings; the UI falls back to manual ZIP import.

## Verification

No tests. `pnpm typecheck`, then compose up and exercise: search → install a mod on
a stopped+running server, install a modpack (env recreate path), export `.mrpack`,
fetch `/p/index.json`. Watch agent logs for download/proxy errors.

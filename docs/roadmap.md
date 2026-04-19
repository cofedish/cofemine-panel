# Roadmap

The MVP in this repo ships the full happy path (create → start → console → edit properties → backup) and the architecture needed to extend it. Below is what is intentionally out of scope for v0.1.0 and how it fits.

## Short term (v0.2)

- **Better live stats**: stream `docker stats` via WebSocket instead of polling `/stats`.
- **Server membership UI**: today we have the model + permission checks; the UI to assign operators to specific servers is missing.
- **Password reset / change password flow** in the UI.
- **2FA (TOTP)** for OWNER/ADMIN.
- **Import/export server config**: a `GET /servers/:id/export` JSON endpoint already exists; add an import endpoint that consumes it.
- **Prometheus metrics** on `panel-api` and `node-agent`.
- **CI**: lint + typecheck + build per app.

## Mid term (v0.3)

- **S3-compatible backup storage**: introduce a `BackupStorageProvider` interface; the current local-disk implementation becomes one of several.
- **CurseForge manual-upload flow**: drop ZIPs into a modpack import dialog that parses `manifest.json` and downloads referenced CF files.
- **Per-server resource quotas**: disk quota enforcement, not just memory/CPU.
- **Plugin/mod list viewer** that reads the `mods/` or `plugins/` directory and surfaces versions.
- **Multi-node orchestration UX**: node health polling, auto-rebalance hints.

## Long term (v1.0)

- **SSO**: OIDC login.
- **Scoped API tokens** for external automation.
- **Agent-to-API asymmetric auth** (mTLS or ed25519 challenge) to remove the shared-secret model.
- **Observability**: built-in Grafana dashboards and alerting rules.
- **Backup encryption** at rest with per-server keys.
- **Server marketplace**: curated templates + quick-deploy from Modrinth/CurseForge landing.
- **Second runtime provider** (e.g. a bare-jar runner for environments that can't run `itzg/minecraft-server`).

## Known limitations in v0.1.0

- The console assumes `rcon-cli` is present in the container (true for `itzg/minecraft-server`). A pure stdin-based fallback is not wired up.
- Modpack installation via env var requires the itzg image to re-fetch on next start; the UI nudges the user to restart.
- Backups include `/data` minus `cache/` and `logs/`. Tuning via UI is not exposed yet.
- Scheduler runs in-process in the API; if the API is horizontally scaled, duplicate fires are possible. For single-instance deploys this is fine; for HA we would move it onto a distributed queue.

# Agent failure modes (verified against code)

Each entry: failure point → observable effect → recovery → duplicate/data-loss risk.
No automated tests cover any of these; "recovery" means what the code actually does.

## Backup interrupted (agent/node dies mid-`tar.create`)

- Effect: truncated `<name>.tar.gz` remains in `BACKUP_ROOT/<serverId>/`; the API row stays `running` forever if the API also missed the response (no reconciler for backups).
- Recovery: none automatic. A later restore of that file reads a corrupt archive.
- Risk: silent data-loss on restore. No `.tmp`→rename dance exists.

## Restore interrupted (crash between data-dir wipe and extract)

- Effect: server `/data` is empty or partial. `backups.ts` deletes every entry first, then extracts.
- Recovery: manual re-restore only. The agent does not check the container is stopped first.
- Risk: total world loss if the only backup was the one being restored (file itself survives).

## Agent crash after `stopReliably`, before next start

- Effect: container left with `RestartPolicy: no` — it will not come back after host reboot until someone hits Start (which restores `unless-stopped`).
- Recovery: manual Start from the UI.

## Loader install crash (between stale-path wipe and installer finish)

- Effect: `run.sh` / `libraries/<loader>` deleted, installer incomplete → server unbootable; temp `eclipse-temurin` container (AutoRemove:false) may leak stopped.
- Recovery: re-run install-modloader; remove leaked container manually.

## Chunked upload abandoned or raced

- Effect: orphan `<file>.part` remains forever (no session id, TTL, or sweeper); two concurrent uploads of the same filename interleave into one corrupt `.part`.
- Recovery: delete the `.part` via the files API.

## Container recreated while map proxied

- Effect: `proxy.ts` target cache holds the old container IP for up to 10s → 502s/timeouts on map tiles. `invalidateProxyTarget` exists but has no callers.
- Recovery: self-heals within 10s.

## Port conflict on start

- Handled: `startWithPortRecovery` force-removes *cofemine-labelled* containers squatting the requested ports, then retries. Non-labelled squatters still fail the start.

## rcon exec failures (players/commands)

- Effect: `/players` degrades to `{online:0,max:0,players:[]}`; WS `command` replies `{type:"error"}` without closing the socket. Console stream itself continues.

## WS log demux edge

- The hand-rolled demux assumes each `data` chunk contains whole 8-byte-framed messages; a frame split across chunks would garble output. Known fragility, unhandled.

## Docker daemon unreachable

- Effect: dockerode calls throw; routes 500. `/health` stays green (it checks nothing) — the API's node health check hits agent `/health`, so a dead Docker daemon is invisible to node status.

## Unconfirmed / untested scenarios

- Behavior when `DATA_ROOT` disk fills mid-backup or mid-install (likely partial writes, unverified).
- Concurrent reprovision + install on the same server (no serialization; outcome unverified).
- maven-cache CA rotation while MC containers are running (entrypoint imports CA only at container start).

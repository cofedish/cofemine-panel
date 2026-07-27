---
paths:
  - "apps/agent/**/*.ts"
---

# Agent conventions (apps/agent)

- Any filesystem path derived from request input must go through `safeResolve(base, userPath)` (`src/paths.ts`) or an equivalent bare-filename check (reject `/`, `\`, `..`). New file routes must not invent their own resolution.
- Containers are found only via `cofemine.*` labels (`AGENT_LABEL_PREFIX`); never look up by name except the maven-cache sidecar.
- Use `stopReliably` / `startWithPortRecovery` (in `src/routes/servers.ts`) for lifecycle — they manage RestartPolicy and port-squatting zombies. Plain `container.restart()` is deliberately unused.
- MC container specs are built only by `ItzgRuntimeProvider` (`src/runtime/itzg-provider.ts`) via `getRuntime("itzg")`. Env merge order: base → retry defaults → maven-cache defaults → `spec.env` last; `JAVA_TOOL_OPTIONS` is merged, never clobbered; `__COFEMINE_*` keys are stripped before create.
- The agent is stateless: no DB, no timers, no job queues. Long operations run inline in the HTTP request; the API side owns timeouts, retries, and persistence. Don't add background state without an explicit design decision.
- Auth is one global bearer-token preHandler in `src/main.ts` (`/health` exempt). Every new route is automatically covered; don't add per-route auth.
- Chunked uploads follow the `.part` append → rename protocol with `chunkIndex`/`totalChunks` in the zod schema — keep those fields or zod strips them and uploads corrupt.
- `src/routes/servers.ts` contains a literal NUL byte, so ripgrep/Grep treats it as binary and silently returns no matches — Read the file or use `grep -a` when searching it.
- The agent is the only app that runs compiled output (`node dist/main.js`); `dist/` in the working tree is stale — never read it as reference.

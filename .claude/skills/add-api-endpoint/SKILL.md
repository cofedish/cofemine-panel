---
name: add-api-endpoint
description: Guided workflow for adding a new API endpoint end-to-end (shared schema → Fastify route with RBAC + audit → agent route if needed → web client usage), with the project's checks applied. Manual workflow — invoke as /add-api-endpoint <description of the endpoint>.
disable-model-invocation: true
argument-hint: <method+path and what the endpoint should do>
---

# Add an API endpoint

Target endpoint: $ARGUMENTS

## Preconditions

- Confirm the endpoint doesn't already exist: check the route files under
  `apps/api/src/*/routes.ts` (and `servers/routes.ts` sub-routes — it's ~1500 lines;
  also remember agent's `servers.ts` is grep-hostile due to a NUL byte).
- Decide the resource owner: which route module it belongs to, and whether it needs
  an agent counterpart (anything touching containers/files/backups does).
- Decide the permission: global (`requireGlobalPermission`) vs per-server
  (`assertServerPermission`) and which `Permission` from `packages/shared/src/roles.ts`.

## Steps

1. **Contract.** If the request shape is shared with the web app, add/extend a zod
   schema in `packages/shared/src/schemas.ts`; otherwise define it route-locally.
   Chunked-upload shapes must keep `chunkIndex`/`totalChunks` fields explicitly.
2. **API route.** Add the handler in the owning module:
   - zod `.parse()` the body/params/query;
   - permission check before any side effect;
   - errors via `Object.assign(new Error(msg), { statusCode })`;
   - `writeAudit(req, { action: "<resource>.<verb>", resource, metadata })` for mutations;
   - explicit Prisma `select` on responses (no full models);
   - agent calls via `NodeClient` (`forId(nodeId)`), with explicit timeouts for long ops.
   - Mind the mounting scheme in `src/main.ts`: `/servers/:id/...` plugins register at root.
3. **Agent route** (if needed) in the matching `apps/agent/src/routes/*` file:
   auth is automatic (global bearer hook); user-derived paths must pass `safeResolve`;
   remember the agent runs work inline — the API side owns timeouts.
4. **Web client** (if the UI consumes it): call through `src/lib/api.ts` + SWR,
   errors via `dialog.alert`, strings through `useT()` in both en and ru. Note web
   re-declares response types inline — define the type where it's used.
5. **Docs.** If the endpoint is part of the public/launcher surface (`/p/*`),
   update `docs/pack-integration.md`. (`docs/api.md` is already far behind — updating
   it is optional but welcome.)

## Verification (required)

- `pnpm typecheck` — all packages must pass.
- If runnable: `docker compose up --build`, exercise the endpoint (UI or curl with a
  session cookie), including one permission-denied case (403) and one validation
  failure (400).
- Confirm an `AuditEvent` row appears for mutating calls.

## Constraints

- No commit/push unless explicitly requested — pushing `main` deploys to production.
- Never return password/token hashes or decrypted `IntegrationSetting` values.
- Don't add unauthenticated routes; the global-gate whitelist in `main.ts` changes
  only with explicit product intent.

## Report format

State: files changed, route + permission chosen, audit action name, verification
performed (typecheck result; manual checks done or why not possible).

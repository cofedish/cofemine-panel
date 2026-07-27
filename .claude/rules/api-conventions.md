---
paths:
  - "apps/api/**/*.ts"
---

# API conventions (apps/api)

- Validate request bodies with zod `.parse()` inside handlers (no Fastify JSON-schema validation). Reuse schemas from `@cofemine/shared` when the shape is shared with the web app; define route-local schemas inline only for API-only shapes.
- Error idiom: `Object.assign(new Error(msg), { statusCode: 4xx })`; the central handler in `src/main.ts` maps `ZodError` → 400 and `statusCode` → response. Don't introduce a new error framework.
- Every route under `/servers` must call `assertServerPermission(req, serverId, "<perm>")` before side effects; global-scope routes use `requireGlobalPermission("<perm>")` as a preHandler. Both live in `src/auth/rbac.ts`.
- Every mutating handler calls `writeAudit(req, { action, resource, metadata })` (`src/audit/service.ts`). Action names follow `"<resource>.<verb>"`.
- Route plugins parameterized on `/servers/:id/...` are registered at root (no prefix) in `src/main.ts` — follow the existing mounting comments there; do not re-prefix them.
- Talk to agents only through `NodeClient` (`src/nodes/node-client.ts`). Long-running agent calls need explicit `headersTimeout`/`bodyTimeout` opts. Agent tokens come from env (`AGENT_TOKEN[_<NODE>]`), not from `Node.tokenHash` (which is write-only/vestigial).
- Responses leak-protect via explicit Prisma `select` — there are no response serialization schemas. Never return whole Prisma models containing `password`, `tokenHash`, or encrypted `IntegrationSetting.value`.
- Secrets at rest go through `encryptSecret`/`decryptSecret` (`src/crypto.ts`); display endpoints must return `has*: boolean` flags, never decrypted values.
- `Backup.sizeBytes` is BigInt — serialization relies on the `BigInt.prototype.toJSON` patch in `main.ts`.
- The API runs via `tsx` in production; don't rely on anything that only works after `tsc` emit.

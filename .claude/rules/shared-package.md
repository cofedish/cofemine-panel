---
paths:
  - "packages/shared/**"
---

# Shared package (@cofemine/shared)

- This package is published as **raw TypeScript** (`main`/`exports` → `src/index.ts`). The API imports it at runtime through `tsx`; the web app transpiles it via `transpilePackages`. A syntax/type error here breaks API boot and web build simultaneously.
- Changing a zod schema here changes the public API contract. Check all three consumers (`apps/api`, `apps/agent`, `apps/web`) before renaming or tightening anything; run `pnpm typecheck` across the workspace.
- `roles.ts` (`ROLE_RANK`, `PERMISSIONS`, `hasPermission`) is the single RBAC source of truth — permission changes here alter live authorization in the API. The web app does not consume `PERMISSIONS`; don't expect UI updates to follow automatically.
- `filePathSchema` and `writeFileSchema` are security guards (path traversal, size caps) — never loosen them for convenience.
- Keep this package dependency-free except `zod`; it must stay safe to import from any app.

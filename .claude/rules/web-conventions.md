---
paths:
  - "apps/web/**/*.ts"
  - "apps/web/**/*.tsx"
---

# Web conventions (apps/web)

- All HTTP goes through `src/lib/api.ts` (`api.get/post/put/patch/del`, `fetcher` for SWR) against same-origin `/api/...`. Never call `fetch` directly, never reference the API host, never add `NEXT_PUBLIC_*` API URLs.
- Data fetching is SWR + explicit `refreshInterval` polling; mutations are `api.*` then `mutate(key)`. Conditional fetching uses null SWR keys, not early returns (Rules-of-Hooks — see the comment in `server-map.tsx`).
- Error convention: catch `ApiError`, surface via `dialog.alert({ tone: "danger", ... })` or a local error chip; use `useDialog()` from `components/dialog-provider.tsx` — no `window.alert/confirm`.
- User-visible strings go through `useT()` from `src/lib/i18n.tsx` (hand-maintained en/ru dictionary) — add keys to both locales.
- Styling: Tailwind + the CSS-variable token system and component classes (`.tile`, `.card`, `.btn`, `.chip`, `.input`, …) defined in `src/app/globals.css`. Use semantic colors (`surface.*`, `ink`, `accent`, `danger`); no component library, don't add one casually.
- Do not add role-based hiding as a security measure — authorization is API-side only; UI may show controls the API will 403.
- **Never use `dangerouslySetInnerHTML`.** Registry content (mod descriptions) is attacker-controlled and renders on the panel's origin with the operator's session. Render untrusted HTML through the `SafeHtml` component in `components/content-detail-drawer.tsx` — DOMPurify with an allowlist, inserted as DOM nodes, never re-serialised to a string. String-level regex sanitising is what this replaced; do not bring it back.
- URLs from registry metadata (`pageUrl`, `links[].url`, …) go through `safeExternalUrl` (`src/lib/safe-url.ts`) before landing in an `href`. React does not block `javascript:` URLs.
- Security headers (CSP included) live in `next.config.mjs` `headers()`, scoped to non-`/api/*` paths so they don't intersect with the API's and map-proxy's own policies.
- Pages are client components under `src/app/(app)/` behind `AuthGate`; there is no middleware and no server-side data fetching — keep it that way unless the architecture changes deliberately.
- `apps/web/tsconfig.json` does not extend `tsconfig.base.json` — web type rules are weaker (`noUncheckedIndexedAccess` off); don't assume base-config guarantees here.

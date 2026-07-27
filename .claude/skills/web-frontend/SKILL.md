---
name: web-frontend
description: Use when changing apps/web — pages, server-detail tabs, the API client or SWR data fetching, the WebSocket console/chat components, dialogs, theming/design tokens, i18n strings, or the Next.js rewrite proxy.
user-invocable: false
paths:
  - "apps/web/**"
---

# Web frontend (apps/web)

## Scope & responsibility

Next.js 14.2 App Router UI. Pure API client — zero backend logic, zero server-side
data fetching, no middleware, no server actions. Everything interactive is a client
component; the `(app)` route group is wrapped by `AuthGate` (client-side redirect to
`/login` or `/setup`).

## Entry points

- `src/app/layout.tsx` — provider stack (order): Theme → I18n → MotionPref → MusicPref → BackdropBeat → Dialog.
- `src/app/(app)/layout.tsx` — AuthGate + TopNav + backdrop shell.
- `next.config.mjs` — the three order-sensitive rewrites: map paths → `map-proxy`, everything else `/api/*` → `api`. WebSocket upgrades ride rewrite #3 implicitly. Env: `API_INTERNAL_URL`, `MAP_PROXY_INTERNAL_URL` only; **no `NEXT_PUBLIC_*`**.

## Page map

`/` dashboard · `/servers/new` (wizard) · `/servers/[id]` (tab strip) ·
`/servers/[id]/map` (full-page map — deliberately not a tab) · `/infrastructure`
(nodes) · `/integrations` · `/administration` (users + audit tabs) · `/settings` ·
public: `/setup`, `/login`, `/forgot-password`, `/reset-password`.
There are no `/nodes`, `/users`, `/audit`, `/templates` routes — those domains live
inside the pages above (templates have no UI at all).

Server-detail tabs (`TABS` in `src/app/(app)/servers/[id]/page.tsx`):
overview, console (`server-console.tsx`), chat (`server-chat.tsx`), files
(`server-files.tsx`), properties (`server-properties.tsx` + `server-properties-meta.ts`),
env (`server-env-tab.tsx`), backups (`server-backups.tsx`), schedules
(`server-schedules.tsx`), content (`server-content.tsx`, the largest), diagnostics
(`server-diagnostics.tsx`). Player list is a card in Overview, not a tab.

## Data fetching conventions

- All HTTP through `src/lib/api.ts` (`ApiError` with `status`/`data`); SWR with explicit `refreshInterval` (2s map players, 5s server/stats/backups, 10–20s lists, 15s dashboard); mutations = `api.*` then `mutate(key)`.
- Conditional fetches use **null SWR keys**, never early returns before hooks (documented Rules-of-Hooks incident in `server-map.tsx`).
- Flaky/optional endpoints set `shouldRetryOnError: false`; live feeds use `keepPreviousData` to avoid flicker.

## Realtime components

`server-console.tsx` — custom console (no xterm): WS to `/api/ws/servers/:id/console`,
2000-line cap, 2s auto-reconnect, buffer cleared on reconnect, localStorage command
history, tab-completion grammar with `$players`. `server-chat.tsx` shares the same
socket URL + `GET /servers/:id/chat` history catch-up.

## Styling system

Tailwind 3.4 (`darkMode: "class"`) + two-layer CSS-variable tokens in
`src/app/globals.css`: neutrals per `.light`/`.dark`, accents as `.accent-<name>`
classes (7 accents via next-themes + custom AccentProvider). Semantic Tailwind colors
(`base`, `surface.1/2/3`, `line`, `ink`, `accent`, `danger`, …) and component classes
(`.tile`, `.card`, `.btn*`, `.chip`, `.input`, `.select`) live in globals.css. No
component library; primitives in `src/components/` (drawer, dialog-provider, etc.).
framer-motion for transitions, gated by motion pref; lucide-react icons; leaflet for maps.

## i18n

`src/lib/i18n.tsx` — hand-maintained flat en/ru dictionary (~1700 lines), `useT()`
hook. Add every new string to **both** locales; there is no coverage check. Some
admin-page strings are currently untranslated English (known drift).

## Trust & auth posture

Session is an httpOnly cookie — JS never sees tokens. RBAC is API-side only: the UI
renders all controls for every authenticated user and relies on the API to 403.
Don't "fix" this with client-side role gates as a security measure; cosmetic gating
is fine if desired, enforcement is not.

## Type drift hazard

The web app re-declares API response types inline per file (only `ROLES` and
`SERVER_TYPES` come from `@cofemine/shared`). When changing an API response shape,
grep `apps/web/src` for the affected fields — the compiler will NOT catch the drift.

## Tests & verification

None. `pnpm --filter @cofemine/web typecheck` (note: weaker tsconfig than the base —
`noUncheckedIndexedAccess` off), `pnpm --filter @cofemine/web build` for the real
Next.js gate (catches Suspense/useSearchParams issues typecheck misses).

## Known dead/quirks

`/servers/[id]/map/embed` link 404s (no such route); unused deps
`audiomotion-analyzer`, `zod`; `next lint` unusable (ESLint not installed);
hardcoded third-party avatar CDNs (mc-heads.net, crafatar) called from the browser.

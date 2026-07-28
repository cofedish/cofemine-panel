# Screenshots

These are the images the root README embeds. They were captured from a real panel driving real
Minecraft containers — three servers, one of them running — not mocked up.

| File | Screen |
|---|---|
| `dashboard-dark.png` | Server list, dark theme |
| `dashboard-light.png` | The same view in light theme, framed identically |
| `console.png` | Live console on a running server, with RCON command output |
| `content.png` | Modrinth browser, filtered to the server's version and loader |
| `accents.png` | Appearance card: mode, the seven accents, motion, background music |

## Re-capturing them

Bring up the stack, create a couple of servers with recognisable names, start one so the status dots
and player counts are populated, then drive a browser against `http://localhost:3000`. The two
dashboard shots must share a viewport and the same servers, or the side-by-side pair in the README
looks misaligned.

Useful details if you script it:

- Language and theme are read from `localStorage` before the app renders — set `cofemine-lang` to
  `en`, `cofemine-theme` to `light` or `dark`, and `cofemine-motion` to `reduced` so animations do not
  land mid-frame. Setting them in an init script is more reliable than clicking through the UI.
- The login form's identifier field has no `type` attribute, so `input[type=text]` will not match it.
  Address the inputs positionally.
- The settings page scrolls inside its own container, so `window.scrollBy` does not move it. Capture
  the Appearance card as an element instead of cropping a page screenshot.
- Capture at 2× device scale, then downscale to ~1920px wide and re-encode. Straight 2× exports run
  500–650 KB each; the same images land at 40–200 KB with no visible loss, and they live in the
  repository forever.

## Before committing new ones

Screenshots of a control panel leak more than people expect. Check each image for server addresses and
ports, real player names, node hostnames on the Infrastructure page, usernames and source addresses in
the audit log, and anything in the browser chrome around the capture. The safest source is a throwaway
local stack with invented server names — which is what these were.

# Screenshots

The README references the files below by exact name. Once they exist here, delete the HTML comment
wrapper around the `Screenshots` block in [`../../README.md`](../../README.md) and they will render.

They are not committed yet because capturing them means driving an authenticated browser session
against a running panel with real servers in it — an empty panel photographs badly, and a fabricated
one would misrepresent the product.

## Files the README expects

| File | Screen | Notes |
|---|---|---|
| `dashboard-dark.png` | Server list / overview | Dark theme. The pair below it is the same screen, so frame them identically. |
| `dashboard-light.png` | Server list / overview | Light theme, same viewport and same servers as above. |
| `console.png` | A server's Console tab | Catch it mid-output — a booting server with log lines beats an idle prompt. |
| `content.png` | Content tab | Modrinth or CurseForge search with results and a mod card open. |
| `accents.png` | Appearance menu | The seven accent swatches visible. A composite strip of the same view in several accents also works. |

## Capture guidelines

- **Viewport**: 1440×900, browser chrome cropped out. Both dashboard shots must match exactly, or the
  side-by-side comparison in the README will look misaligned.
- **Theme**: switch via the appearance menu (top-right avatar → appearance). Modes are light, dark and
  system; accents are Emerald, Sky, Violet, Ruby, Lucifer, Caramel and Minecraft. The choice persists
  in `localStorage` under `cofemine-theme`.
- **Content**: have two or three servers with real names, at least one running so the status dots and
  player counts are populated. A dashboard of empty placeholder rows undersells it.
- **Format**: PNG, and run them through an optimiser (`oxipng -o4`, `pngquant`) — these land in the
  repository and in every clone.
- **Width**: 2× the display width if you want them crisp on HiDPI; the README constrains them to 49%
  so oversized files are wasted bytes.

## Before you commit them

Screenshots of a control panel leak more than people expect. Check each image for:

- Server addresses, ports and public IPs.
- Real player names and UUIDs, if you would rather not publish them.
- The Integrations page — API keys are masked in the UI, but SMTP hosts, proxy hosts and node
  addresses are not secrets the panel hides, and they are still yours.
- Anything in the audit log: it records usernames and source IPs.
- Browser tabs, bookmarks and notifications in the background.

The safest source for screenshots is a throwaway local stack with invented server names.

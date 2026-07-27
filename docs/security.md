# Security model

This is a self-hosted admin panel with control over Docker containers on the host. Treat it accordingly.

## Session & authentication

- Passwords hashed with **bcrypt** (cost 12).
- Sessions are JWTs signed with `JWT_SECRET` (HS256, algorithm pinned on both sign and verify) and also stored as `Session` rows with an **sha256-hashed copy of the token**. A request is accepted only if:
  - the JWT verifies,
  - the `sid` claim matches a session row,
  - the row's `tokenHash` matches sha256 of the presented token,
  - and the row has not expired.
- JWT is delivered as an httpOnly, sameSite=lax cookie. In production (`NODE_ENV=production`) it is also `secure`.
- Logout deletes the session row — the token becomes useless even if the cookie is stolen.
- `JWT_SECRET` must be ≥32 characters and `SECRETS_KEY` must decode to exactly 32 bytes; both are rejected if they still look like the placeholders from `.env.example`. The API refuses to boot otherwise.

### Brute force

`POST /auth/login` is throttled per **source IP** and per **(account, source IP)**
pair (`apps/api/src/auth/login-throttle.ts`): five free attempts inside a
15-minute window, then an exponential lockout from 30 s up to 15 minutes.
Failures are written to the audit log as `auth.login-failed`.

The account bucket is deliberately scoped to the source address rather than
global. A global per-account lockout is remotely triggerable — eleven wrong
passwords would lock the OWNER out of their own panel, renewable forever from
anywhere, and only a *successful* login clears it. The residual risk is a
distributed attack spreading guesses across many addresses; against bcrypt
(cost 12) with an 8-character minimum plus the global 600/min/IP limiter, that
is the accepted trade.

State is in-process, so it resets on deploy — acceptable for a single-instance
panel, not for a clustered one.

### First-run setup

While the user table is empty, `POST /auth/setup` makes the caller OWNER —
trust-on-first-use. Close that window with either:

- `SETUP_TOKEN` (≥16 chars): the endpoint then requires it, compared in constant time; or
- `BOOTSTRAP_OWNER_*`: the seed creates the owner before anyone can call.

With neither set, the API logs a warning every time `/auth/setup-status`
reports that setup is still required.

## RBAC

- Four roles: **OWNER > ADMIN > OPERATOR > VIEWER**.
- **OWNER and ADMIN** are panel-wide: their global role applies to every server.
- **OPERATOR and VIEWER** are scoped roles: their global role grants nothing on
  any specific server, and access comes from a per-server `Membership` row. A
  scoped user with no membership gets 403, matching what `GET /servers` already
  showed them. (Before this rule existed, a global OPERATOR could run console
  commands on any server in the panel.) A membership may grant *more* than the
  global role — that is the point of memberships, it is not a ceiling.
  > **Operational note:** no route creates `Membership` rows yet — they can only
  > be inserted directly in Postgres. Until such an endpoint exists, OPERATOR and
  > VIEWER accounts have no server access through the panel at all.
- Permission checks use an allowlist (`PERMISSIONS` in `packages/shared/src/roles.ts`). No permission is implicit.
- `requireGlobalPermission` / `assertServerPermission` (`apps/api/src/auth/rbac.ts`) are the only gateways. Routes that mutate state always pass through one, and routes that *create* resources use the global gate even when they also read an existing one (e.g. `POST /servers/:id/clone` needs `server.create`).
- Enforcement is **server-side only**. The web UI does not hide controls by role; never treat UI visibility as authorization.

## Responses & secrets in transit

- Responses are leak-protected with explicit Prisma `select`. `GET /servers/:id` never returns the `Node` row (which carries `tokenHash` and the agent's internal host) or `containerId`.
- `Server.env` is a free-form KV the operator edits, so every response carrying it runs through `redactEnv` (`apps/api/src/servers/env-redaction.ts`): `CF_API_KEY`, `RCON_PASSWORD` and anything ending in `_KEY` / `_TOKEN` / `_PASSWORD` / `_SECRET` come back as `__COFEMINE_REDACTED__`. `PATCH /servers/:id` maps that sentinel back to the stored value, so the Env tab's read-modify-write round trip doesn't overwrite secrets with mask text.
- The CurseForge API key is **not stored** on the server row at all. It is injected into the container spec at provision time (`materializeEnv`) and scrubbed from any row that still carries it on the next repair/reprovision.
- Integration read endpoints (`GET /integrations`, `/download-proxy`, `/maven-cache/*`, `/smtp`) require `integration.manage`, same as the mutations. The content-browse endpoints (`/modrinth/*`, `/curseforge/*`) require `server.edit` — the CurseForge ones spend the operator's API key on every call, so leaving them open let any authenticated user burn the quota and break modpack installs panel-wide.
- `GET /templates` requires `template.manage` and redacts template `env`. It was the one route in that router without a gate.
- `server.properties` is served with `rcon.password` masked — through the dedicated properties route *and* through the file manager, which is a second read path onto the same file and only needs `server.view`. Saving the masked value back is a no-op rather than an overwrite.

## Secrets at rest

- `SECRETS_KEY` is a 32-byte (base64) key loaded from the environment. It is used with **AES-256-GCM** to encrypt integration secrets (CurseForge API key, SMTP password, download-proxy password, the maven-cache CA) before they are written to `IntegrationSetting.value`.
- `JWT_SECRET` is only in env.
- Database passwords, `AGENT_TOKEN`, etc. live in env; use your orchestrator's secret manager in production.
- Rotating `SECRETS_KEY` orphans every stored secret — they are not re-encryptable without the old key.

## Trust boundaries

### Docker socket = root on the host

Only the `agent` container mounts `/var/run/docker.sock`, and **that is the real
security boundary of this panel**. Anything that can talk to the socket can
start a container with the host filesystem bind-mounted, i.e. it is root on the
host. The agent's uid does not change this.

Consequences to keep in mind:

- The agent runs as root *on purpose*: it chowns `/data` trees that root-running
  installer containers leave behind, and Docker cannot grant a capability to a
  non-root `USER` (capabilities are dropped on setuid and compose can't request
  ambient caps). `user: node` + `cap_add: CHOWN` would look safer while silently
  breaking loader installs.
- What is reduced instead: `cap_drop: ALL` with only `CHOWN`, `DAC_OVERRIDE`,
  `FOWNER`, `FSETID` added back, plus `no-new-privileges`. The other services
  (`api`, `map-proxy`, `web`) drop **all** capabilities.
- Genuinely removing socket root-equivalence requires rootless Docker or Podman.
  A socket proxy is defence in depth only — it filters endpoints, not request
  bodies, so it cannot stop `Privileged: true` on a `create` call.

### API ↔ agent

- The agent speaks HTTP with a single shared bearer token, compared in constant time. Put the agent behind a VPN or on an internal network; never expose port 4100 to the public internet.
- The agent trusts authenticated callers completely — everything reaching it is post-authorization. It still validates its own inputs (see below), because "the caller is the API" is an assumption, not a guarantee.
- WebSocket console is proxied through the API so the browser never has direct access to the agent.

### Minecraft containers

MC containers run arbitrary third-party mod code. They are:

- created with `no-new-privileges` and `PidsLimit: 512`;
- refused the env keys `UID`, `GID`, `RUN_AS_ROOT`, `SKIP_SUDO` — rejected by the
  API schema (`serverEnvSchema`) *and* stripped by the agent when it builds the
  spec. Either one alone would let a `server.edit` user run their JVM as root
  inside the container;
- given a **random** RCON password per container instead of a value derived from
  the server id. All containers share `cofemine_mcnet`, so a derivable password
  meant one compromised server could open an RCON console on every other one.
  Nothing outside the container needs the value — the panel runs `rcon-cli`
  *inside* it.

## Path traversal & SSRF (agent)

- `safeResolve(base, userPath)` (`apps/agent/src/paths.ts`) strips leading slashes, resolves against `base`, and rejects anything that isn't `base` or a descendant. The file manager, `server.properties`, installed-content and content installs all go through it. The API also refuses paths containing `..` at the zod layer.
- Backup **create**, **restore** and **delete** all run their path through the same confinement check: the resolved path must live under this server's backup directory (create/restore) or the backup root (delete), and must end in `.tar.gz`. Backup names are additionally restricted to `[A-Za-z0-9._-]` on both sides, because create builds `<name>.tar.gz` from user input.
- Routes that turn a caller-supplied filename into a write path (`/client-mods`, `/client-mods/download`) share one `assertBareClientFilename` check: no separators, no leading dot, allowed extension only. The download half also validates its URL. Both halves matter — that route writes as root in the container holding `docker.sock`, so a traversal there plus an attacker-chosen URL is remote code execution on the host, not just a misplaced file.
- Server ids are validated as path components (`[A-Za-z0-9_-]{1,64}`) before being joined onto `DATA_ROOT` / `BACKUP_ROOT`.
- Downloads the agent performs on a caller's behalf go through `assertSafeDownloadUrl` (`apps/agent/src/security.ts`): https only, no URL credentials, and the hostname must resolve exclusively to public addresses (no RFC1918, loopback, link-local, CGNAT, or `169.254.169.254`). Redirects are followed manually so the check runs on every hop. The one deliberate exception is the loader-installer fetch, which legitimately targets the internal `maven-cache` over plain http.
- The live-map proxy sanitises its wildcard subpath before splicing it into an agent URL, and asserts the normalised path still starts with `/servers/<id>/proxy/<port>/`. That request carries the node's agent token, so a traversal there would be privilege escalation, not a wrong 404.

## The maven-cache MITM CA

The optional `maven-cache` sidecar terminates TLS for a whitelist of CDN hosts so
squid can cache jar *bodies*. That means the panel generates a certificate
authority and installs it into every Minecraft container's JVM truststore. Know
what that implies before enabling it.

- **Three volumes, and the split is the actual security control.**
  `cofemine_maven_cache_ca_key` holds `ca.crt` + `ca.key` and is mounted only by
  the cache sidecar. `cofemine_maven_cache_ca_pub` holds `ca.crt` + `.ready` +
  `import.sh` and is what MC containers mount. `cofemine_maven_cache_ca` is the
  pre-split volume: container binds are immutable, so every MC container created
  before the split still mounts it — the agent therefore keeps it seeded with
  public material only and **truncates `ca.key` there on every seed and on every
  agent start**. That is what removes the key from legacy containers without
  recreating them. The private key never enters a Minecraft container.
- **The certificate is name-constrained** to the CDN domains squid intercepts
  (`forgecdn.net`, `curseforge.com`, `modrinth.com`, `neoforged.net`,
  `minecraftforge.net`, `fabricmc.net`, `quiltmc.org`) — **but this does not
  protect Java clients.** The JDK builds trust anchors as
  `new TrustAnchor(cert, null)`, discarding name constraints carried by the
  anchor itself, so a JVM that trusts this root accepts a leaf it signed for
  any host. Since the JVM (mc-image-helper, the server itself) is the whole
  reason the cert is imported, treat the constraint as covering only
  OpenSSL-based clients (curl/wget in the container, an operator's browser).
  **The control that actually contains a leaked key is confinement** — see the
  volume split above. Verify the JDK behaviour on your own version before
  relying on it either way.
- **It is short-lived (180 days)** — expiry is the only revocation mechanism
  available. The API warns in its logs when fewer than 30 days remain. Rotate it
  in Integrations, then recreate MC containers.
- **Mojang auth domains are never intercepted.** They are excluded from squid's
  bump list, so session traffic is tunnelled without being decrypted, regardless
  of whether a mod honours `NO_PROXY`.
- **squid is not an open proxy — to private space.** Requests to cloud metadata,
  link-local and RFC1918 destinations are denied, as are non-web ports and
  `CONNECT` to anything but 443. It still allows arbitrary *public*
  destinations, because MC containers route all their HTTPS through it —
  narrowing that to a domain allowlist needs real `access_log` data first.
- **Who can reach squid.** In production this sidecar also joins the shared
  external Caddy network, so a container from any other stack on that network
  can use :8081 as a forward proxy to the internet. Set `MCNET_CIDR` to the
  `cofemine_mcnet` subnet (`docker network inspect cofemine_mcnet`) to restrict
  clients. It is unset by default because Docker assigns that subnet
  dynamically and a hardcoded guess would break every install.
- **nginx verifies its upstreams** (`proxy_ssl_verify on`). Without it any
  certificate was accepted and the response cached for 180 days — a poisoned
  `*-installer.jar` would then be executed by mc-image-helper on every server
  that installs a loader.

## Reverse proxies & headers

- `TRUST_PROXY` (default `loopback,linklocal,uniquelocal`) controls which peers may set `X-Forwarded-For`. `req.ip` drives both the rate-limit bucket and the audit log's IP, so trusting everyone let any client reset its own limit and forge its recorded address.
- The API sends a deny-everything CSP (it serves JSON, a PEM and .mrpack binaries — never a document). The map-proxy, which streams third-party HTML from BlueMap/dynmap, sends a same-origin CSP: no third-party script, style, image or `connect-src`, `frame-ancestors 'self'`, `object-src 'none'`.
- `PUBLIC_BASE_URL` should be set on any panel serving public client packs; without it the `/p/*` links are built from the client-supplied `Host` header.

## Public client packs (`/p/*`)

- The token is 128 bits of CSPRNG, looked up with `findUnique`, rotatable and
  revocable. Anyone holding the link can download the pack — including the
  generated `servers.dat` with the server's address — so treat it as a
  bearer credential.
- **Listing is opt-in per server** (`publicPackListed`, default off, toggled in
  the Client Pack tab). `/p/index.json` embeds each raw token in a URL, so
  listing a pack converts an unguessable link into public knowledge. Previously
  every tokened server was listed, which made the token's entropy irrelevant.
  Existing packs are unlisted after upgrade until their owner opts in.
- `/p/*` has its own rate limits (12/min for pack downloads, 30/min for the
  index) on top of the global limiter: a `.mrpack` request makes the agent
  assemble a ZIP of every jar on the server, unauthenticated.
- The maven-cache mirror nginx publishes through Caddy is GET/HEAD-only and rate
  limited — every cache MISS costs an upstream CDN fetch from the operator's IP.

## Untrusted content in the browser

Mod descriptions from Modrinth and CurseForge are attacker-controlled:
publishing on either registry is unmoderated, and the markup renders on the
panel's own origin inside the operator's session. Script execution there is a
full takeover — write a jar through the file manager, create an OWNER, read
anything — and httpOnly cookies do not help, because the requests go out as the
logged-in user.

- Descriptions are sanitised with **DOMPurify** against a tag/attribute
  allowlist and inserted as **DOM nodes**, never re-serialised through
  `innerHTML` (which is what mutation-XSS gadgets need). There is no
  `dangerouslySetInnerHTML` anywhere in the app.
- The previous hand-rolled regex denylist let through `<img src=x/onerror=…>`,
  `<svg/onload=…>`, `<base>`, `<form>` and several `javascript:` forms — HTML5
  accepts `/` as an attribute separator, and one-pass replacement rebuilds
  `<ifr<iframe>ame>` into a working tag. Do not reintroduce string-level
  sanitising.
- URLs from registry metadata go through `safeExternalUrl` before reaching an
  `href`. React does not block `javascript:` URLs — it only warns.
- The web app sends a CSP (`apps/web/next.config.mjs`). `script-src` needs
  `'unsafe-inline'` because the App Router inlines its RSC payload and strict
  nonces would require middleware; the directives doing the real work are
  `base-uri 'none'`, `form-action 'self'`, `connect-src 'self'` and
  `object-src 'none'` — precisely the gadgets that survived the old sanitiser.
  The policy is scoped to non-`/api/*` paths so it doesn't intersect with the
  map-proxy's own policy.

### Known unfixed: the live-map iframe

**This is the largest remaining XSS vector in the panel.** The BlueMap/dynmap
viewer is embedded with `sandbox="allow-same-origin allow-scripts"`, which on
same-origin content provides no isolation: scripts in the frame can reach
`window.top`, read the parent DOM, and call the panel API with the operator's
session. The frame's own CSP does not contain it either, because code that
borrows `parent.fetch` runs under the parent's policy.

The viewer is **not** first-party. BlueMap is a third-party mod and its webroot
sits in the server's data directory, writable through the file manager
(`server.edit`) and by any installed mod. Replacing one `.js` file there makes
opening the Map tab a session theft.

It is not fixed because the obvious fix does not work: dropping
`allow-same-origin` gives the frame an opaque origin, its relative tile fetches
become cross-site, the `SameSite=Lax` session cookie stops being attached, and
the map 401s on every request. A real fix means serving maps from a **separate
origin** with **non-cookie auth** — a scoped, short-lived token the map-proxy
validates — plus Caddy configuration on the operator's side. That is a design
change, not a config tweak.

Until then, treat "who can write to a server's data directory" and "who can
install mods" as equivalent to "who can take over the panel", and be wary of
opening the Map tab on a server running untrusted mods.

## Supply chain

`pnpm install --frozen-lockfile` in CI and in all three Dockerfiles. It used to
be `--frozen-lockfile=false`, so every rebuild re-resolved caret ranges from the
registry — combined with push-to-main auto-deploy, a malicious patch release of
any of ~400 transitive packages would have reached production with nobody in the
loop. Each Dockerfile copies every workspace manifest, because a frozen install
validates the lockfile against the whole workspace.

Transitive packages we cannot reach through our own manifests are pinned with
`pnpm.overrides` in the root `package.json` — currently `protobufjs`,
`@grpc/grpc-js`, `fast-uri`, `postcss` and `brace-expansion`. All are patch or
minor bumps. `protobufjs` is the one that matters most: it carries a
code-injection advisory and arrives in the **agent** via dockerode — the
container holding `docker.sock`.

Run `pnpm audit` before and after dependency changes. Current state: **0
critical, 10 high**, and every remaining high needs a major upgrade —
Next 14 → 15 (8) and Fastify 4 → 5 (`fastify` + `find-my-way`, 2). Those are
migrations with real regression risk, not bumps; do them deliberately.

Drop an override once its parent ships the fixed version itself, and re-audit
rather than assuming.

## Scheduler

Schedules are standing grants to act on a server, so they are treated as such:

- Cron must be a **five-field** expression. croner reads a six-field form as
  second-level, and `* * * * * *` + a `backup` action makes the node tar a
  multi-gigabyte world once a second. Expressions are also parsed at save time,
  so a malformed one is a 400 rather than a silent no-op.
- Jobs run with croner's `protect`, so a slow run is skipped rather than
  stacked.
- `Schedule.createdById` records the author, and **the scheduler re-checks that
  this user still has `server.edit` on the target server before every run**,
  disabling the schedule if not. Without it a `command: "op attacker"` schedule
  outlived the account that created it. Rows predating the column are
  grandfathered with a warning.
- Every run is written to the audit log (`schedule.run`), with the command or
  announcement text — a scheduled console execution belongs in the trail exactly
  like an interactive one.

## Audit log

Every write action emits an `AuditEvent` with user, IP, and the resource id, plus
failed logins and rejected setup attempts. Events are append-only from the app's
perspective — no routes delete them. The log is visible in the UI.

## Destructive actions

- All destructive UI actions are `confirm()`-gated.
- Deleting a node is blocked if it still has servers.
- Deleting your own user is blocked.

## Rate limits

`@fastify/rate-limit` is wired globally (600 req/min/IP by default), with the
dedicated login throttle described above on top. Tune per route as needed.

## What is explicitly NOT covered (yet)

- 2FA / TOTP.
- SSO (OIDC/SAML).
- Token-scoped API keys for scripts.
- Per-server resource quotas beyond the memory/CPU container limit.
- Rootless Docker / Podman — the only thing that would remove the socket's
  root-equivalence.
- Automated tests for the authorization boundaries (there is no test runner in
  this repo).

These are on the [roadmap](roadmap.md).

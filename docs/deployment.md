# Deployment

## Single-host production

`docker-compose.prod.yml` is the deployment unit. It pulls images from GHCR rather than building
locally — CI builds and pushes all four on every merge to `main`, so a normal deploy is `pull` plus
`up -d`.

Images and their overrides: `API_IMAGE` (also used by `map-proxy`), `AGENT_IMAGE`, `WEB_IMAGE`,
`MAVEN_CACHE_IMAGE`. Each defaults to `ghcr.io/cofedish/cofemine-panel/<service>:latest`. Pin them to a
tag if you would rather not track `latest`.

### 1. Prepare the host

```bash
mkdir -p /var/lib/cofemine/servers /var/lib/cofemine/backups
docker network create caddy      # if your reverse proxy stack does not own one already
```

`DATA_ROOT` and `BACKUP_ROOT` must be bind mounts at the **identical absolute path** on the host and
inside the agent, because the agent hands those same paths to Minecraft containers as Docker binds.
Converting them to named volumes makes the agent and the game containers resolve the same path to two
different places, and the panel stops seeing mods and worlds. This is load-bearing, not a preference.

### 2. Write `.env` next to the compose file

Copy `.env.example` — it documents every variable, including the ones that ship empty on purpose.
The minimum for a real deployment:

```bash
POSTGRES_USER=cofemine
POSTGRES_PASSWORD=<random>
POSTGRES_DB=cofemine

# The API validates these at startup and refuses to boot on the shipped placeholders.
SECRETS_KEY=<openssl rand -base64 32>   # exactly 32 bytes of base64
JWT_SECRET=<openssl rand -hex 32>       # >= 32 characters
AGENT_TOKEN=<openssl rand -hex 32>

WEB_ORIGIN=https://panel.example.com
API_PUBLIC_URL=https://panel.example.com/api
PUBLIC_BASE_URL=https://panel.example.com   # else public pack links are built from the Host header

DATA_ROOT=/var/lib/cofemine/servers
BACKUP_ROOT=/var/lib/cofemine/backups

CADDY_NETWORK=caddy
```

Two more ship **empty**, and while they are empty the protections they control are inactive. Both are
site-specific because Docker assigns the subnets:

```bash
# Who may use squid as a forward proxy. In production maven-cache also joins the shared Caddy
# network, so while this is empty any container from any other stack on that network can proxy
# through it.  docker network inspect cofemine_mcnet
MCNET_CIDR=172.28.0.0/16

# The reverse proxy in front of the public mirror. While empty, nginx keys its rate limits on
# Caddy's container IP, so the whole mirror shares one bucket.
TRUSTED_PROXY_CIDR=172.18.0.0/16
```

Optional but worth knowing: `SETUP_TOKEN` closes the first-run window where whoever reaches
`/auth/setup` first becomes owner; `TRUST_PROXY` controls which peers may set `X-Forwarded-For`, which
drives both the rate limiter and the audit log's source address.

### 3. Reverse proxy

`web` publishes no host ports. It joins the external network named by `CADDY_NETWORK` (default
`caddy`), and your proxy reaches it as `web:3000`. Terminate TLS there.

```caddy
panel.example.com {
  reverse_proxy web:3000
}
```

`web` proxies `/api/*` to the API and `/api/servers/:id/map/*` to the map proxy internally, so a single
hostname covers UI, API and WebSockets. A fuller example, including the public launcher mirror, is in
[`Caddyfile.example`](Caddyfile.example).

Only 80 and 443 should be reachable from outside. The agent (`:4100`) and Postgres must never be
published — the agent accepts one bearer token and everything reaching it is treated as already
authorized.

### 4. First run

```bash
docker compose -f docker-compose.prod.yml up -d
```

On boot the API waits for Postgres, applies the schema with `prisma db push --accept-data-loss`, and
runs the idempotent seed. **There is no migration history in this repository.** `db push` reconciles
the live schema against `schema.prisma`, so a column rename is a drop plus a create and destroys the
data in it. Back up the database before deploying a schema change, and treat destructive edits as
production data-loss events.

Then open the panel and create the owner account. Optionally paste a CurseForge API key under
**Integrations**, and generate the maven-cache CA there if you want loader downloads cached.

### 5. Updates

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

Merges to `main` do this automatically over SSH; see [ci-cd.md](ci-cd.md). Networks are deliberately
not torn down on a normal deploy — recreating them has reproducibly left Docker in a state where
containers share a bridge but TCP silently drops. Use the `[reset-stack]` commit marker or the manual
workflow input when you genuinely need a full `down`.

## Host protection for Minecraft containers

Game containers are created by the agent, not by compose, so the `logging:` and `cap_drop:` keys in the
compose file never reach them. They are configured through `AGENT_MC_*` instead:

| Variable | Default | What it does |
|---|---|---|
| `AGENT_MC_LOG_MAX_SIZE` / `_MAX_FILE` | `10m` / `3` | Rotates container logs. Without it they inherit the daemon default, which for json-file is unbounded — a crash-looping server fills the host partition and takes Postgres and backups with it. |
| `AGENT_MC_CAP_DROP` | `true` | Drops every Linux capability except the seven itzg needs to chown `/data` and drop to uid 1000. No performance cost. Set `false` only if you need spark's native profiler. |
| `AGENT_MC_RUNTIME` | *(empty)* | Runs game containers under a sandboxed OCI runtime — `kata-runtime` (own kernel per container, needs `/dev/kvm`) or `runsc` (gVisor, no KVM but higher syscall cost). Must be registered in `/etc/docker/daemon.json` first. |
| `AGENT_MC_NOFILE` | *(empty)* | `nofile` ulimit ceiling. |

Beyond the panel, the measures worth applying on the host itself are an egress filter for the
Minecraft network, disk quotas or a separate filesystem for `DATA_ROOT`, off-host backup replication,
and runtime detection such as Falco. See [security.md](security.md).

## Multi-node

Run one agent per Docker host:

```bash
docker run -d --name cofemine-agent \
  -e AGENT_TOKEN=<the same token the API will use for this node> \
  -e AGENT_DOCKER_NETWORK=cofemine_mcnet \
  -e AGENT_DATA_ROOT=/var/lib/cofemine/servers \
  -e AGENT_BACKUP_ROOT=/var/lib/cofemine/backups \
  --security-opt no-new-privileges:true \
  --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add FSETID \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /var/lib/cofemine/servers:/var/lib/cofemine/servers \
  -v /var/lib/cofemine/backups:/var/lib/cofemine/backups \
  ghcr.io/cofedish/cofemine-panel/agent:latest
```

Then **Infrastructure → Add node** with a name, an internal URL and the token. The API resolves the
token from its own environment as `AGENT_TOKEN_<NAME>` (uppercased), falling back to `AGENT_TOKEN`, so
per-node tokens are set on the API host, not stored in the database.

Do not publish `4100`. Reach the agent over a private network or a VPN — it authenticates one shared
token and grants full control of the Docker daemon behind it.

## Storage

- Server data and backup archives live on the agent host under `DATA_ROOT` and `BACKUP_ROOT`. Archives
  never cross the wire.
- Retention only ever deletes backups that both succeeded and are named `scheduled-`. The
  `manual-`/`scheduled-` prefix is load-bearing — do not rename backups.
- Backups sit on the same disk as the servers they protect, and the retention path can delete them.
  Replicate them off-host (restic, rclone) if they matter.
- `Backup.path` already stores arbitrary paths, so an S3-backed storage provider is a matter of adding
  one that streams the archive elsewhere.

## Observability

- Every service logs pino-structured JSON to stdout, with rotation configured in the compose file.
- `GET /health` on both the API and the agent, unauthenticated.
- The panel's own audit log records every mutating action with actor, source address and resource.
- No Prometheus endpoint yet — it is on the [roadmap](roadmap.md).

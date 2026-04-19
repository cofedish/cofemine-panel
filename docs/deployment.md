# Deployment

## Single-host production

The included `docker-compose.prod.yml` is the starting point. It expects you to build and push images to a registry, then reference them via `API_IMAGE` / `AGENT_IMAGE` / `WEB_IMAGE` env vars.

### 1. Build and push images

```bash
docker build -t ghcr.io/you/panel-api -f apps/api/Dockerfile .
docker build -t ghcr.io/you/panel-agent -f apps/agent/Dockerfile .
docker build -t ghcr.io/you/panel-web -f apps/web/Dockerfile .
docker push ghcr.io/you/panel-api
docker push ghcr.io/you/panel-agent
docker push ghcr.io/you/panel-web
```

### 2. Create a `.env` on the host

```
POSTGRES_USER=...
POSTGRES_PASSWORD=...
POSTGRES_DB=cofemine
JWT_SECRET=...
SECRETS_KEY=...                # openssl rand -base64 32
AGENT_TOKEN=...                # long random
WEB_ORIGIN=https://panel.example.com
API_PUBLIC_URL=https://panel.example.com/api
API_IMAGE=ghcr.io/you/panel-api:v0.1.0
AGENT_IMAGE=ghcr.io/you/panel-agent:v0.1.0
WEB_IMAGE=ghcr.io/you/panel-web:v0.1.0
```

### 3. Reverse proxy

The prod compose attaches `web` to an **external** network named `cofemine_public`. Create it once:

```bash
docker network create cofemine_public
```

Point your reverse proxy (nginx, Caddy, Traefik) at the `web` service on port 3000. Terminate TLS there. A minimal Caddy block:

```
panel.example.com {
  reverse_proxy web:3000
}
```

The web service internally proxies `/api/*` to `api:4000`, so you do not need separate hostnames for API and UI.

### 4. First run

```bash
docker compose -f docker-compose.prod.yml up -d
```

- `panel-api` syncs the DB schema (`prisma db push`) and runs the seed script. When you evolve the schema past the MVP, generate real migration files with `prisma migrate dev` and swap `db push` for `prisma migrate deploy` in `apps/api/Dockerfile`.
- Open the panel → create the OWNER account.
- Paste a CurseForge API key in **Integrations** if desired.

### 5. Updates

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

Prisma runs any new migrations on API start.

## Multi-node deployment

Run one agent per Docker host. On each extra host:

```bash
docker run -d --name cofemine-agent \
  -e AGENT_TOKEN=<long-random> \
  -e AGENT_DOCKER_NETWORK=cofemine_mcnet \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /var/lib/cofemine/servers:/var/lib/cofemine/servers \
  -v /var/lib/cofemine/backups:/var/lib/cofemine/backups \
  -p 4100:4100 \
  ghcr.io/you/panel-agent:v0.1.0
```

Then in the panel, **Nodes → Add node**: give it a name, the URL (`https://node2.internal:4100`), and the token. Protect the agent port behind a VPN or firewall — it must only be reachable from the API.

Servers can then be created on any registered node from the creation wizard.

## Storage

- The dev compose uses named volumes `mc_data` and `mc_backups`. In production, bind-mount them to a fast local disk and make sure your backup retention policy fits.
- For a future S3-compatible backup store, the `Backup.path` column already supports arbitrary paths; add a storage provider that streams the tar.gz to S3 instead of the local filesystem.

## Observability

- Every service writes pino-structured logs to stdout. Ship them to your log stack of choice.
- `GET /health` is exposed by both the API and the agent (no auth required).
- The API exposes no Prometheus endpoint yet — it is on the roadmap.

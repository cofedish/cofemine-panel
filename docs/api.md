# API reference

All routes are prefixed by the API host. In dev compose, the web app proxies them at `/api/*`. Authenticated endpoints require a valid session cookie (`cofemine_session`) or `Authorization: Bearer <jwt>`.

## Auth

| Method | Path | Description |
|--------|------|-------------|
| GET  | `/auth/setup-status` | Returns `{ setupRequired: boolean }` |
| POST | `/auth/setup`        | Create the first OWNER; fails if users exist |
| POST | `/auth/login`        | `{ usernameOrEmail, password }` → sets session cookie |
| POST | `/auth/logout`       | Clears session |
| GET  | `/auth/me`           | Current user |

## Nodes (global: `node.manage`)

| Method | Path | Description |
|--------|------|-------------|
| GET    | `/nodes` | List |
| POST   | `/nodes` | Register a node (`{ name, host, token }`) |
| GET    | `/nodes/:id/health` | Ping the agent; updates `lastSeenAt` |
| DELETE | `/nodes/:id` | Only if no servers attached |

## Servers

Visibility follows membership + global role. OWNER/ADMIN see all servers; OPERATOR/VIEWER see only those they are members of (or explicitly granted).

| Method | Path | Perm |
|--------|------|------|
| GET    | `/servers` | — |
| POST   | `/servers` | `server.create` |
| GET    | `/servers/:id` | `server.view` |
| PATCH  | `/servers/:id` | `server.edit` |
| DELETE | `/servers/:id` | `server.delete` |
| POST   | `/servers/:id/{start,stop,restart,kill}` | `server.control` |
| POST   | `/servers/:id/command` | `server.control` (`{ command }`) |
| POST   | `/servers/:id/clone` | `server.view` |
| GET    | `/servers/:id/files?path=` | `server.view` |
| PUT    | `/servers/:id/files` | `server.edit` (`{ path, content }`) |
| DELETE | `/servers/:id/files?path=` | `server.edit` |
| GET    | `/servers/:id/properties` | `server.view` |
| PUT    | `/servers/:id/properties` | `server.edit` (`{ properties: { key: value } }`) |
| GET    | `/servers/:id/stats` | `server.view` |
| GET    | `/servers/:id/players` | `server.view` |
| GET    | `/servers/:id/export` | `server.view` |

### Create server body

```json
{
  "name": "survival",
  "nodeId": "clxxx",
  "type": "PAPER",
  "version": "1.21.1",
  "memoryMb": 4096,
  "ports": [{ "host": 25565, "container": 25565, "protocol": "tcp" }],
  "env": { "DIFFICULTY": "normal", "MAX_PLAYERS": "20" },
  "eulaAccepted": true
}
```

## Backups

| Method | Path |
|--------|------|
| GET    | `/servers/:id/backups` |
| POST   | `/servers/:id/backups` (`{ name? }`) |
| POST   | `/backups/:id/restore` |
| DELETE | `/backups/:id` |

## Schedules

| Method | Path |
|--------|------|
| GET    | `/servers/:id/schedules` |
| POST   | `/servers/:id/schedules` |
| PATCH  | `/schedules/:id` |
| DELETE | `/schedules/:id` |

Schedule body:

```json
{
  "name": "nightly-backup",
  "cron": "0 4 * * *",
  "action": "backup",
  "payload": null,
  "enabled": true
}
```

Actions: `backup`, `restart`, `command` (`payload.command`), `announce` (`payload.message`, sent as `say ...`).

## Templates (global: `template.manage` to write)

| Method | Path |
|--------|------|
| GET    | `/templates` |
| POST   | `/templates` |
| DELETE | `/templates/:id` |

## Users (global: `user.manage`)

| Method | Path |
|--------|------|
| GET    | `/users` |
| POST   | `/users` |
| PATCH  | `/users/:id` |
| DELETE | `/users/:id` |

## Audit (global: `audit.view`)

| Method | Path |
|--------|------|
| GET    | `/audit?limit=…&offset=…` |

## Integrations

| Method | Path | Perm |
|--------|------|------|
| GET    | `/integrations` | — |
| PATCH  | `/integrations/:key` | `integration.manage` |
| DELETE | `/integrations/:key` | `integration.manage` |
| GET    | `/integrations/modrinth/search` | — |
| GET    | `/integrations/modrinth/projects/:id` | — |
| GET    | `/integrations/modrinth/projects/:id/versions` | — |
| GET    | `/integrations/curseforge/search` | — |
| GET    | `/integrations/curseforge/projects/:id/versions` | — |
| POST   | `/integrations/servers/:id/install/modrinth` | `server.edit` |
| POST   | `/integrations/servers/:id/install/curseforge` | `server.edit` |

## WebSocket

- `WS /ws/servers/:id/console` — bidirectional JSON framing. Server → client messages:
  - `{"type":"log","stream":"stdout"|"stderr","data":"…"}`
  - `{"type":"command-result","data":"…"}`
  - `{"type":"status","message":"…"}`
  - `{"type":"error","message":"…"}`
  - Client → server: `{"type":"command","command":"say hi"}`

## Errors

All errors are JSON with shape `{ "error": "message" }` and the appropriate HTTP status. Validation errors include `issues` from zod.

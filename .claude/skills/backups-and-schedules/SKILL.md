---
name: backups-and-schedules
description: Use when working on backups (create/restore/delete/prune/retention), the croner scheduler, scheduled restarts/commands/announcements, or Backup/Schedule rows and their on-disk archives.
user-invocable: false
---

# Backups & scheduler

## Scope

The full backup lifecycle across API and agent, plus the croner-based scheduler that
drives scheduled restarts, backups, commands, and announcements.

## Ownership split

- **API** (`apps/api/src/backups/routes.ts`, `src/schedules/{routes,scheduler}.ts`): rows, permissions, audit, scheduling, retention policy.
- **Agent** (`apps/agent/src/routes/backups.ts`, 65 lines): the actual tar.gz create/extract/delete on disk. Stateless, no timers.

## Backup lifecycle (verified)

1. API creates `Backup` row `status:"running"`, name `manual-<ISO>` (route) or `scheduled-<ISO>` (scheduler).
2. Agent `POST /servers/:id/backups` runs `tar.create` **inline in the request** → `BACKUP_ROOT/<serverId>/<name>.tar.gz`, cwd = data dir, excluding only top-level `./cache` and `./logs` (NOT `.cache` CF cache, NOT `.cofemine-client`).
3. API updates row → `success` (+`path`, `sizeBytes BigInt`, `finishedAt`) or `failed`. Manual route rethrows agent errors; scheduler swallows them.
4. Restore: agent **wipes the data dir first**, then extracts from the DB-stored absolute path. No stopped-check, non-atomic.
5. Delete: agent failure is ignored; the DB row is removed regardless (archives can orphan; deleting a Server also orphans its archives — cascade removes rows only).

The tarball never crosses the network: the API stores the agent-local absolute path
and passes it back verbatim for restore/delete. The agent trusts these paths without
a guard — a deliberate trusted-API assumption; never expose them to user input.

## Retention (the invariant that must not break)

Prune candidates = `status:"success"` **AND** `name.startsWith("scheduled-")`, newest
N kept. `keep` resolution: `schedule.payload.keep` → `server.env.COFEMINE_BACKUP_KEEP`
→ default 24. Manual backups and failed runs are never pruned — **the `manual-`/
`scheduled-` name prefix is the only protection**. The policy is implemented twice
with no shared code: `scheduler.ts` (auto, per-run) and `backups/routes.ts`
(`POST /servers/:id/backups/prune`, one-shot). Change both together.
DB rows are dropped even when the agent file delete fails (count converges, files may orphan).

## Scheduler mechanics

`src/schedules/scheduler.ts`: croner, all jobs UTC, module-level `Map<scheduleId, Cron>`.
`restartScheduler()` = stop-all + reload enabled schedules from DB, invoked on every
schedule create/patch/delete. Actions validated by `scheduleSchema` (shared):
`restart` | `backup` | `command` (payload.command) | `announce` (payload.message → `say`).
`lastRunAt` stamped after each run.

Security properties — all three are load-bearing, don't "simplify" them away:
- **Cron is five fields only** (`cronExpressionSchema`, re-checked in `reloadJobs`). croner reads a six-field form as seconds, and `* * * * * *` + `backup` tars the world once a second. Expressions are parsed with croner at save time so a bad one is a 400.
- Jobs use croner's `protect: true` — a slow run is skipped, not stacked.
- `Schedule.createdById` + `userHasServerPermission(...)` re-check before **every** run; a schedule whose author lost `server.edit` (or was deleted) is disabled and audited. Null `createdById` = pre-existing row, grandfathered with a warning.
- Each run writes an audit event (`schedule.run`, or `schedule.disabled-unauthorized`) directly via prisma — `writeAudit` needs a request and the scheduler has none.

Known properties (don't accidentally "fix" or worsen):
- In-process only — two API replicas would double-fire everything. Single API instance is assumed.
- `PATCH /schedules/:id` still lacks an audit call.
- A crash mid-run leaves `Backup.status:"running"` forever — there is no reconciler for backups (unlike server status).

## Permissions

List = `server.view`; create/restore/delete/prune = `server.edit`; schedule CRUD =
`server.edit`. WS/console-style control perms are not involved here.

## Failure modes

Truncated tar on agent crash, wiped-then-partial data dir on restore crash, orphaned
archives — catalogued in `.claude/skills/node-agent/failure-modes.md`.

## Verification

No tests. `pnpm typecheck`; compose up → create manual backup, restore it, create a
`* * * * *` backup schedule, watch two runs, confirm prune keeps manual backups and
respects `keep`. Check both retention implementations if you touched the policy.

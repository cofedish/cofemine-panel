#!/bin/sh
# API bootstrap: wait for Postgres, sync schema, seed, then start the server.
# `prisma db push` itself does not retry on P1001 (network unreachable),
# so we wrap it in a small wait loop — cleaner than relying purely on
# depends_on: service_healthy, which has narrow timing windows.
set -eu

MAX_TRIES="${DB_WAIT_RETRIES:-60}"
SLEEP_SECS="${DB_WAIT_INTERVAL:-2}"

echo "bootstrap: waiting for database schema push to succeed (up to ${MAX_TRIES} tries)"
i=1
until pnpm exec prisma db push --skip-generate 2>&1; do
  if [ "$i" -ge "$MAX_TRIES" ]; then
    echo "bootstrap: giving up waiting for db after ${MAX_TRIES} tries" >&2
    exit 1
  fi
  echo "bootstrap: db not ready yet (attempt ${i}/${MAX_TRIES}); sleeping ${SLEEP_SECS}s"
  i=$((i + 1))
  sleep "$SLEEP_SECS"
done

echo "bootstrap: running seed"
pnpm exec tsx prisma/seed.ts

echo "bootstrap: starting API"
# Run through tsx rather than plain node: the panel-api depends on
# @cofemine/shared which is a workspace package exported as .ts source
# (so both dev and prod can consume it without a separate build step).
# tsx is a thin Node loader that resolves .ts on demand; overhead at
# cold start is ~200ms, irrelevant for a control panel, and it keeps
# the monorepo free of the dual-publish dance.
exec pnpm exec tsx src/main.ts

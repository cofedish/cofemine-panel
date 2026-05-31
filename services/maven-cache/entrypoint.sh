#!/bin/sh
# Boot order:
#   1. gost (TCP relays 8001..8012 for nginx; HTTP forward :8082 for
#      squid cache_peer when UPSTREAM_PROXY is set).
#   2. Render squid.conf from template, conditionally including a
#      cache_peer parent block.
#   3. Initialise squid's ssl_db if missing; squid -k parse.
#   4. nginx for the path-prefixed loader cache on :80.
#   5. squid for the MITM forward proxy on :8081.
#
# UPSTREAM_PROXY env (optional):
#   socks5://host.docker.internal:10808 → chain everything via xray
#   http://host.docker.internal:10808   → same, via HTTP CONNECT
#   unset / empty                       → direct egress
#
# nginx ↔ port map (kept in sync with nginx.conf):
#   8001 maven.neoforged.net      8007 maven.quiltmc.org
#   8002 maven.minecraftforge.net 8008 piston-data.mojang.com
#   8003 files.minecraftforge.net 8009 piston-meta.mojang.com
#   8004 meta.fabricmc.net        8010 libraries.minecraft.net
#   8005 maven.fabricmc.net       8011 edge.forgecdn.net
#   8006 meta.quiltmc.org         8012 cdn.modrinth.com

set -eu

# 1. gost ------------------------------------------------------------
FORWARD_FLAG=""
if [ -n "${UPSTREAM_PROXY:-}" ]; then
  FORWARD_FLAG="-F=${UPSTREAM_PROXY}"
  echo "[maven-cache] chaining gost through: ${UPSTREAM_PROXY}"
else
  echo "[maven-cache] UPSTREAM_PROXY unset — gost goes direct"
fi

# Per-CDN TCP relays (used by nginx upstream blocks) + an HTTP forward
# proxy on :8082 used by squid's cache_peer (when configured).
gost \
  -L="tcp://127.0.0.1:8001/maven.neoforged.net:443" \
  -L="tcp://127.0.0.1:8002/maven.minecraftforge.net:443" \
  -L="tcp://127.0.0.1:8003/files.minecraftforge.net:443" \
  -L="tcp://127.0.0.1:8004/meta.fabricmc.net:443" \
  -L="tcp://127.0.0.1:8005/maven.fabricmc.net:443" \
  -L="tcp://127.0.0.1:8006/meta.quiltmc.org:443" \
  -L="tcp://127.0.0.1:8007/maven.quiltmc.org:443" \
  -L="tcp://127.0.0.1:8008/piston-data.mojang.com:443" \
  -L="tcp://127.0.0.1:8009/piston-meta.mojang.com:443" \
  -L="tcp://127.0.0.1:8010/libraries.minecraft.net:443" \
  -L="tcp://127.0.0.1:8011/edge.forgecdn.net:443" \
  -L="tcp://127.0.0.1:8012/cdn.modrinth.com:443" \
  -L="http://127.0.0.1:8082" \
  ${FORWARD_FLAG} &
GOST_PID=$!
sleep 1

# 2. squid.conf render ----------------------------------------------
# When UPSTREAM_PROXY is set we add a parent peer + never_direct so
# squid is FORCED through gost (which chains through xray). Otherwise
# squid goes direct.
if [ -n "${UPSTREAM_PROXY:-}" ]; then
  export SQUID_PEER_BLOCK='cache_peer 127.0.0.1 parent 8082 0 no-query default no-digest no-netdb-exchange
never_direct allow all'
else
  export SQUID_PEER_BLOCK=''
fi

# A 2048-bit DH param for TLS — generated lazily so we don't slow
# image builds. ~5–30s on first start; cached afterwards on the
# /var/spool/squid volume.
if [ ! -f /etc/ssl/dhparam.pem ]; then
  if [ -f /var/spool/squid/dhparam.pem ]; then
    cp /var/spool/squid/dhparam.pem /etc/ssl/dhparam.pem
  else
    echo "[maven-cache] generating DH params (one-time, ~10s)…"
    openssl dhparam -out /etc/ssl/dhparam.pem 2048 2>/dev/null
    cp /etc/ssl/dhparam.pem /var/spool/squid/dhparam.pem
  fi
fi

envsubst '${SQUID_PEER_BLOCK}' < /etc/squid/squid.conf.template > /etc/squid/squid.conf

# 3. CA presence check + ssl_db init --------------------------------
CA_READY=0
if [ -s /etc/cofemine/ca/ca.crt ] && [ -s /etc/cofemine/ca/ca.key ]; then
  if [ -f /etc/cofemine/ca/.ready ] && [ "$(cat /etc/cofemine/ca/.ready 2>/dev/null)" = "1" ]; then
    CA_READY=1
  fi
fi

if [ "$CA_READY" = "1" ]; then
  echo "[maven-cache] CA present — squid MITM enabled"
  chown proxy:proxy /etc/cofemine/ca/ca.crt /etc/cofemine/ca/ca.key 2>/dev/null || true
  chmod 0644 /etc/cofemine/ca/ca.crt
  chmod 0600 /etc/cofemine/ca/ca.key
  # Initialise the per-host leaf cert db once. We always purge and
  # recreate on container start so a CA rotation invalidates old
  # leaf certs (otherwise squid happily serves a leaf signed by the
  # PREVIOUS CA and the client trustless-fails).
  rm -rf /var/spool/squid/ssl_db
  /usr/lib/squid/security_file_certgen -c -s /var/spool/squid/ssl_db -M 8MB
  chown -R proxy:proxy /var/spool/squid/ssl_db
else
  echo "[maven-cache] no CA configured — running squid in splice-only mode"
  # squid refuses to start ssl-bump without cert+key, so when no CA
  # is configured we strip the ssl-bump line entirely. Quick sed:
  # drop the http_port block + every ssl_bump/sslcrtd line, replace
  # with a plain http_port.
  sed -i \
    -e '/^http_port 8081/,/^$/d' \
    -e '/^sslcrtd_program/d' \
    -e '/^sslcrtd_children/d' \
    -e '/^ssl_bump/d' \
    -e '/^tls_outgoing_options/d' \
    /etc/squid/squid.conf
  printf 'http_port 8081\n' | cat - /etc/squid/squid.conf > /etc/squid/squid.conf.tmp
  mv /etc/squid/squid.conf.tmp /etc/squid/squid.conf
fi

# Initialise cache_dir if first run on this volume.
if [ ! -d /var/spool/squid/00 ]; then
  echo "[maven-cache] initialising 40 GB cache_dir…"
  squid -N -z 2>&1 | tail -5 || true
  chown -R proxy:proxy /var/spool/squid
fi

# Validate the rendered config — fail fast so we don't restart-loop
# silently on a typo.
if ! squid -k parse -f /etc/squid/squid.conf 2>/tmp/squid-parse.log; then
  echo '[maven-cache] squid config invalid:'
  cat /tmp/squid-parse.log
  kill $GOST_PID 2>/dev/null || true
  exit 1
fi

# 4. nginx ----------------------------------------------------------
nginx -g 'daemon off;' &
NGINX_PID=$!

# 5. squid ----------------------------------------------------------
squid -N -f /etc/squid/squid.conf &
SQUID_PID=$!

# Health endpoint for compose healthcheck — nginx covers it on :80/healthz.

# Trap signals → propagate.
term() {
  kill -TERM $NGINX_PID $SQUID_PID $GOST_PID 2>/dev/null || true
}
trap term TERM INT

# If any subprocess dies, take the whole container down so docker
# restarts us in a known state.
wait -n $NGINX_PID $SQUID_PID $GOST_PID
EXIT_CODE=$?
echo "[maven-cache] subprocess exited with $EXIT_CODE — shutting down"
kill -TERM $NGINX_PID $SQUID_PID $GOST_PID 2>/dev/null || true
wait || true
exit $EXIT_CODE

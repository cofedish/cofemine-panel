#!/bin/bash
# Use bash explicitly — `wait -n` is a bash-ism and Debian's /bin/sh
# is dash which crashes with "Illegal option -n", silently exiting
# the entrypoint and putting the container into a restart loop.
# Boot order:
#   1. gost (TCP relays 8001..8013 for nginx; HTTP forward :8082 for
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
#   8013 resources.download.minecraft.net (vanilla assets — client launcher use)
#   8014 bmclapi2.bangbang93.com              (API-mimic catch-all for loader list endpoints)

set -eu

# squid runs as `proxy` user but tries to write its access/cache log
# straight to /dev/stdout — which is owned by root in docker (mode
# 600). Without this chmod, squid FATAL-aborts on startup with
# "Cannot open '/dev/stdout' for writing" and the container restart-
# loops. world-writable on a pseudo-fd is safe — it's just a pipe
# into docker's log driver.
chmod 666 /dev/stdout /dev/stderr 2>/dev/null || true

# 1. gost ------------------------------------------------------------
# Docker Desktop adds BOTH A and AAAA records for host.docker.internal;
# gost happily picks the IPv6 one, but xray on the host typically only
# binds IPv4 (127.0.0.1:10808). Result is a silent EOF on first byte.
# Pre-resolve to a literal IPv4 here so gost has no choice.
if [ -n "${UPSTREAM_PROXY:-}" ] && echo "$UPSTREAM_PROXY" | grep -q "host.docker.internal"; then
  HOST_V4="$(getent ahostsv4 host.docker.internal 2>/dev/null | awk '{print $1; exit}')"
  if [ -n "$HOST_V4" ]; then
    UPSTREAM_PROXY="$(echo "$UPSTREAM_PROXY" | sed "s/host.docker.internal/$HOST_V4/")"
    echo "[maven-cache] resolved host.docker.internal → $HOST_V4"
  fi
fi

# Built as an array, not a bare string. UPSTREAM_PROXY reaches this
# container from the panel UI (Integrations → Download Proxy), so an
# unquoted "${FORWARD_FLAG}" would word-split on whitespace and let a
# panel admin smuggle extra gost listeners/flags into this command line.
# Admin-only, hence not urgent — but it costs nothing to close.
FORWARD_ARGS=()
if [ -n "${UPSTREAM_PROXY:-}" ]; then
  FORWARD_ARGS=("-F=${UPSTREAM_PROXY}")
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
  -L="tcp://127.0.0.1:8013/resources.download.minecraft.net:443" \
  -L="tcp://127.0.0.1:8014/bmclapi2.bangbang93.com:443" \
  -L="http://127.0.0.1:8082" \
  "${FORWARD_ARGS[@]}" &
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

# Optional source allowlist. Unset → empty block → any container that
# can reach :8081 may use the proxy (still subject to the destination
# denies). Set MCNET_CIDR to the cofemine_mcnet subnet to keep
# neighbours on the shared Caddy network out.
if [ -n "${MCNET_CIDR:-}" ]; then
  export SQUID_SRC_BLOCK="acl mcnet src ${MCNET_CIDR}
acl mcnet src 127.0.0.1/32
http_access deny !mcnet"
  echo "[maven-cache] restricting proxy clients to ${MCNET_CIDR}"
else
  export SQUID_SRC_BLOCK=''
  echo "[maven-cache] MCNET_CIDR unset — proxy accepts any client that can reach :8081"
fi

envsubst '${SQUID_PEER_BLOCK} ${SQUID_SRC_BLOCK}' < /etc/squid/squid.conf.template > /etc/squid/squid.conf

# 3. CA presence check + ssl_db init --------------------------------
CA_READY=0
if [ -s /etc/cofemine/ca/ca.crt ] && [ -s /etc/cofemine/ca/ca.key ]; then
  if [ -f /etc/cofemine/ca/.ready ] && [ "$(cat /etc/cofemine/ca/.ready 2>/dev/null)" = "1" ]; then
    CA_READY=1
  fi
fi

if [ "$CA_READY" = "1" ]; then
  echo "[maven-cache] CA present — squid MITM enabled"
  # /etc/cofemine/ca is a read-only mount of the shared volume — the
  # agent already chmod'd the files when seeding them, so we don't
  # need to (and can't) change perms here.
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
# Render the real_ip block. Without TRUSTED_PROXY_CIDR every public
# request keys its rate limit on the reverse proxy's container address,
# so the whole mirror shares one bucket. With it, limits apply per real
# client. Never set it to 0.0.0.0/0 — that lets any client spoof its own
# key via X-Forwarded-For.
if [ -n "${TRUSTED_PROXY_CIDR:-}" ]; then
  export NGINX_REAL_IP_BLOCK="set_real_ip_from ${TRUSTED_PROXY_CIDR};
    real_ip_header X-Forwarded-For;
    real_ip_recursive on;"
  echo "[maven-cache] trusting X-Forwarded-For from ${TRUSTED_PROXY_CIDR}"
else
  export NGINX_REAL_IP_BLOCK=''
  echo "[maven-cache] TRUSTED_PROXY_CIDR unset — rate limits key on the socket peer"
fi
envsubst '${NGINX_REAL_IP_BLOCK}' < /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf

if ! nginx -t 2>/tmp/nginx-test.log; then
  echo '[maven-cache] nginx config invalid:'
  cat /tmp/nginx-test.log
  kill $GOST_PID 2>/dev/null || true
  exit 1
fi

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

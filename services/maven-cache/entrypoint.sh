#!/bin/sh
# Boot both gost (per-upstream TCP relays) and nginx.
#
# UPSTREAM_PROXY env (optional):
#   socks5://host.docker.internal:2080   → tunnel each relay through xray
#   http://host.docker.internal:2080     → HTTP CONNECT proxy
#   unset / empty                        → direct TCP forwarding
#
# Each relay listens on a fixed loopback port; nginx upstream blocks
# point at these. The port↔CDN mapping must match nginx.conf:
#
#   8001  maven.neoforged.net
#   8002  maven.minecraftforge.net
#   8003  files.minecraftforge.net
#   8004  meta.fabricmc.net
#   8005  maven.fabricmc.net
#   8006  meta.quiltmc.org
#   8007  maven.quiltmc.org
#   8008  piston-data.mojang.com
#   8009  piston-meta.mojang.com
#   8010  libraries.minecraft.net
#   8011  edge.forgecdn.net
#   8012  cdn.modrinth.com

set -eu

FORWARD_FLAG=""
if [ -n "${UPSTREAM_PROXY:-}" ]; then
  FORWARD_FLAG="-F=${UPSTREAM_PROXY}"
  echo "[maven-cache] gost relays will chain through: ${UPSTREAM_PROXY}"
else
  echo "[maven-cache] UPSTREAM_PROXY unset — gost relays go direct"
fi

# Compose all -L flags into one gost invocation.
# Each relay: "listen on 127.0.0.1:PORT, forward TLS to HOST:443".
# gost auto-detects TLS via "tls" connector when the target port is 443.
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
  ${FORWARD_FLAG} &
GOST_PID=$!

# Give gost ~0.5s to bind its listeners before nginx tries to use them.
sleep 1

# Tail-mode nginx so the container exits cleanly when nginx dies.
nginx -g 'daemon off;' &
NGINX_PID=$!

# Trap signals and propagate to both children. Without this the
# container ignores SIGTERM during `docker stop` and waits the full
# 10s grace period.
term() {
  kill -TERM $NGINX_PID 2>/dev/null || true
  kill -TERM $GOST_PID  2>/dev/null || true
}
trap term TERM INT

# Wait for either to exit; if either dies, take the whole container
# down so docker restarts us in a known state.
wait -n $NGINX_PID $GOST_PID
EXIT_CODE=$?
echo "[maven-cache] subprocess exited with $EXIT_CODE — shutting down"
kill -TERM $NGINX_PID $GOST_PID 2>/dev/null || true
wait || true
exit $EXIT_CODE

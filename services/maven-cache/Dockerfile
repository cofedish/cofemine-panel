# Caching reverse proxy + TLS-intercepting forward proxy for
# Minecraft loader/CDN downloads. Three layers:
#
#   1. nginx  :80  — path-prefixed cache for predictable loader
#                    installer URLs (NeoForge, Forge, Fabric, Quilt,
#                    Mojang piston, Modrinth/CF "edge" if used).
#   2. squid  :8081 — generic HTTP forward proxy with ssl_bump MITM
#                     for whitelisted CDN hosts, splice for everything
#                     else. Caches jar bodies on disk (40 GB).
#   3. gost  :8001–8012 (loopback) + :8082 — TCP relays nginx points
#                     at, plus an HTTP forward proxy squid uses as
#                     cache_peer when UPSTREAM_PROXY is configured.
#                     gost is what actually chains through xray.
#
# The CA used by squid is *not* baked in — it's seeded into
# /etc/cofemine/ca/{ca.crt,ca.key} by the agent through a shared
# named volume, generated/managed in the panel UI. squid is
# launched in pure splice mode when the CA is absent (no MITM,
# no jar caching, but tunnels still work).
FROM debian:bookworm-slim

ARG GOST_VERSION=3.2.6
ENV DEBIAN_FRONTEND=noninteractive

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        nginx \
        squid-openssl \
        ca-certificates \
        curl \
        gettext-base \
        openssl \
        tini; \
    rm -rf /var/lib/apt/lists/*; \
    arch="$(uname -m)"; \
    case "$arch" in \
      x86_64)  gost_arch="amd64" ;; \
      aarch64) gost_arch="arm64" ;; \
      *) echo "unsupported arch $arch"; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/gost.tar.gz "https://github.com/go-gost/gost/releases/download/v${GOST_VERSION}/gost_${GOST_VERSION}_linux_${gost_arch}.tar.gz"; \
    mkdir -p /tmp/gost-unpack; \
    tar -xzf /tmp/gost.tar.gz -C /tmp/gost-unpack; \
    mv /tmp/gost-unpack/gost /usr/local/bin/gost; \
    chmod +x /usr/local/bin/gost; \
    rm -rf /tmp/gost.tar.gz /tmp/gost-unpack; \
    gost -V

# squid needs an ssl_db, initialised once with security_file_certgen,
# for dynamic per-host leaf cert generation. The db survives between
# runs in /var/spool/squid (cache dir volume) but we still bootstrap
# it in entrypoint to handle fresh installs.
RUN install -d -o proxy -g proxy /var/spool/squid/ssl_db /var/cache/nginx/maven /etc/cofemine/ca

COPY nginx.conf /etc/nginx/nginx.conf
COPY squid.conf.template /etc/squid/squid.conf.template
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# :80   — path-routed cache (loader installers)
# :8081 — squid HTTP/CONNECT proxy with ssl_bump MITM (CF/Modrinth jars)
EXPOSE 80 8081

VOLUME ["/var/cache/nginx/maven", "/var/spool/squid"]

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]

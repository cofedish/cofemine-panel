# Minimal caching reverse proxy for Minecraft loader/CDN downloads:
# NeoForge, Forge, Fabric, Quilt, Mojang piston, CurseForge edge,
# Modrinth CDN. Sitting on cofemine_mcnet, every MC container reaches
# it as `http://maven-cache`.
#
# Two-process layout (run via tiny shell supervisor):
#   - gost: optional TCP relays on 127.0.0.1:8001..8009, one per
#     upstream CDN. Each relay tunnels to its CDN through the SOCKS5
#     proxy at $UPSTREAM_PROXY (typically the operator's xray on
#     host.docker.internal:2080). When $UPSTREAM_PROXY is unset, gost
#     forwards plain TCP — useful for dev / Western networks.
#   - nginx: serves :80 on the docker network. Routes by path prefix
#     to one of the gost relays. Caches everything per upstream.
#
# nginx is told its upstream is "127.0.0.1:8001" rather than the real
# CDN — gost takes care of going through xray and reaching the actual
# host. proxy_ssl_name + proxy_set_header Host preserve SNI/Host so
# the CDN's TLS handshake completes with the correct cert.
FROM nginx:1.27-alpine

# gost: single static binary, ~10 MB, supports SOCKS5/HTTP forward
# chains out of the box.
ARG GOST_VERSION=3.2.6
RUN set -eux; \
    apk add --no-cache curl ca-certificates; \
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
    apk del curl; \
    gost -V

COPY nginx.conf /etc/nginx/nginx.conf
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
 && mkdir -p /var/cache/nginx/maven \
 && chown -R nginx:nginx /var/cache/nginx

EXPOSE 80

VOLUME ["/var/cache/nginx/maven"]

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

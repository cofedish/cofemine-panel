import { prisma } from "../db.js";
import { decryptSecret, encryptSecret } from "../crypto.js";

/**
 * Global "Download proxy" — applied to the JVM during modpack install
 * only when a specific server is explicitly marked to use it (per-server
 * flag in env). We keep the config here in IntegrationSetting under
 * namespaced keys so it lives next to the Modrinth/CurseForge integration
 * settings and inherits the same encryption.
 */

export type ProxyProtocol = "socks" | "http";

export type DownloadProxyConfig = {
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username?: string;
  password?: string;
};

const KEYS = {
  enabled: "download.proxy.enabled",
  protocol: "download.proxy.protocol",
  host: "download.proxy.host",
  port: "download.proxy.port",
  username: "download.proxy.username",
  password: "download.proxy.password",
} as const;

async function readOne(key: string): Promise<string | null> {
  const row = await prisma.integrationSetting.findUnique({ where: { key } });
  if (!row) return null;
  try {
    return decryptSecret(row.value);
  } catch {
    return null;
  }
}

async function writeOne(key: string, value: string): Promise<void> {
  const encrypted = encryptSecret(value);
  await prisma.integrationSetting.upsert({
    where: { key },
    create: { key, value: encrypted },
    update: { value: encrypted },
  });
}

async function deleteOne(key: string): Promise<void> {
  await prisma.integrationSetting.delete({ where: { key } }).catch(() => {});
}

/**
 * Read the proxy config if it's configured + enabled. Returns null when
 * the user hasn't set it up or explicitly disabled it.
 */
export async function readDownloadProxy(): Promise<DownloadProxyConfig | null> {
  const [enabledRaw, protocol, host, portRaw, username, password] =
    await Promise.all([
      readOne(KEYS.enabled),
      readOne(KEYS.protocol),
      readOne(KEYS.host),
      readOne(KEYS.port),
      readOne(KEYS.username),
      readOne(KEYS.password),
    ]);
  if (enabledRaw !== "true") return null;
  if (!host || !portRaw) return null;
  const port = Number(portRaw);
  if (!Number.isFinite(port) || port < 1 || port > 65535) return null;
  const proto: ProxyProtocol =
    protocol === "http" || protocol === "socks" ? protocol : "socks";
  return {
    protocol: proto,
    host,
    port,
    username: username ?? undefined,
    password: password ?? undefined,
  };
}

/** Read without leaking the password — for UI read calls. */
export async function readDownloadProxyForDisplay(): Promise<
  (Omit<DownloadProxyConfig, "password"> & {
    enabled: boolean;
    hasPassword: boolean;
  })
> {
  const [enabledRaw, protocol, host, portRaw, username, password] =
    await Promise.all([
      readOne(KEYS.enabled),
      readOne(KEYS.protocol),
      readOne(KEYS.host),
      readOne(KEYS.port),
      readOne(KEYS.username),
      readOne(KEYS.password),
    ]);
  const port = Number(portRaw ?? "0");
  return {
    enabled: enabledRaw === "true",
    protocol:
      protocol === "http" || protocol === "socks" ? protocol : "socks",
    host: host ?? "",
    port: Number.isFinite(port) ? port : 0,
    username: username ?? undefined,
    hasPassword: !!password,
  };
}

type WriteInput = {
  enabled: boolean;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username?: string;
  /** When undefined we keep the existing stored password; when empty
   *  string, clear it; otherwise overwrite. */
  password?: string;
};

export async function writeDownloadProxy(input: WriteInput): Promise<void> {
  await Promise.all([
    writeOne(KEYS.enabled, input.enabled ? "true" : "false"),
    writeOne(KEYS.protocol, input.protocol),
    writeOne(KEYS.host, input.host),
    writeOne(KEYS.port, String(input.port)),
    input.username
      ? writeOne(KEYS.username, input.username)
      : deleteOne(KEYS.username),
    input.password === undefined
      ? Promise.resolve()
      : input.password
        ? writeOne(KEYS.password, input.password)
        : deleteOne(KEYS.password),
  ]);
}

export async function clearDownloadProxy(): Promise<void> {
  await Promise.all(Object.values(KEYS).map((k) => deleteOne(k)));
}

/**
 * If the user pointed the proxy at a loopback / default-bridge
 * address (localhost / 127.0.0.1 / 172.17.0.1 — that last one is
 * the docker0 default-bridge gateway), the MC container running on
 * cofemine_mcnet (a custom bridge) physically can't reach it. The
 * itzg container spec now ships with `host.docker.internal` aliased
 * to the host gateway, so this helper rewrites those loopback-ish
 * IPs to that hostname. The user's panel config stays untouched —
 * we only translate at the moment we hand the value to the JVM.
 */
function rewriteHostForContainer(host: string): string {
  const h = host.trim().toLowerCase();
  if (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "::1" ||
    h === "172.17.0.1"
  ) {
    return "host.docker.internal";
  }
  return host;
}

/**
 * Build the universal `HTTP_PROXY` / `HTTPS_PROXY` URL that
 * curl / wget / Java 11+ HttpClient / reactor-netty (via
 * `proxyWithSystemProperties`) respect. Unlike Java's
 * `-DsocksProxyHost`, which only routes URLConnection traffic,
 * these env vars are honoured by virtually every HTTP client used
 * inside the itzg image.
 *
 * For SOCKS-only proxies we still emit a `socks5://...` URL — most
 * modern tools that read these env vars accept that form. For
 * mixed-mode proxies (xray on 2080) the HTTP path on the same port
 * is what actually carries the traffic in practice.
 */
export function makeProxyUrl(proxy: DownloadProxyConfig): string {
  const host = rewriteHostForContainer(proxy.host);
  const auth =
    proxy.username || proxy.password
      ? `${encodeURIComponent(proxy.username ?? "")}:${encodeURIComponent(
          proxy.password ?? ""
        )}@`
      : "";
  const scheme = proxy.protocol === "socks" ? "socks5" : "http";
  return `${scheme}://${auth}${host}:${proxy.port}`;
}

/**
 * Hosts that should bypass the proxy. Localhost variants so the
 * MC server can talk to its own RCON / mc-monitor without tunnelling.
 * Plus `.ru` because — per the user's xray routing — `.ru` already
 * goes direct on the host and there's no point sending those
 * requests through the proxy chain only to be unwrapped at egress.
 * Plus the docker bridge ranges so inter-container traffic on
 * cofemine_mcnet doesn't get NAT'd through the proxy.
 */
const NO_PROXY_HOSTS =
  "localhost,127.0.0.1,::1,host.docker.internal,*.ru,172.16.0.0/12,10.0.0.0/8,192.168.0.0/16";

/**
 * Translate a proxy config into JVM system properties that reactor-netty
 * (mc-image-helper's HTTP client) respects. Both SOCKS and HTTP proxies
 * are supported.
 */
export function makeJavaToolOptions(proxy: DownloadProxyConfig): string {
  const parts: string[] = [];
  const host = rewriteHostForContainer(proxy.host);
  if (proxy.protocol === "socks") {
    parts.push(`-DsocksProxyHost=${host}`);
    parts.push(`-DsocksProxyPort=${proxy.port}`);
    if (proxy.username) {
      parts.push(`-Djava.net.socks.username=${proxy.username}`);
    }
    if (proxy.password) {
      parts.push(`-Djava.net.socks.password=${proxy.password}`);
    }
  } else {
    parts.push(`-Dhttp.proxyHost=${host}`);
    parts.push(`-Dhttp.proxyPort=${proxy.port}`);
    parts.push(`-Dhttps.proxyHost=${host}`);
    parts.push(`-Dhttps.proxyPort=${proxy.port}`);
    if (proxy.username) {
      parts.push(`-Dhttp.proxyUser=${proxy.username}`);
      parts.push(`-Dhttps.proxyUser=${proxy.username}`);
    }
    if (proxy.password) {
      parts.push(`-Dhttp.proxyPassword=${proxy.password}`);
      parts.push(`-Dhttps.proxyPassword=${proxy.password}`);
    }
  }
  return parts.join(" ");
}

/**
 * Build the env-var bundle for the container: HTTP/HTTPS_PROXY (the
 * universal mechanism most HTTP clients respect) plus NO_PROXY for
 * traffic that should stay direct.
 */
export function makeProxyEnv(
  proxy: DownloadProxyConfig
): Record<string, string> {
  const url = makeProxyUrl(proxy);
  return {
    // Both upper- and lowercase forms — different libraries pick
    // different variants. curl prefers lowercase, Java 11 HttpClient
    // checks both. Set both to avoid surprises.
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    NO_PROXY: NO_PROXY_HOSTS,
    no_proxy: NO_PROXY_HOSTS,
  };
}

/** Server-env flag that opts a server into proxy routing during its next
 *  provision. Stripped from the outgoing container env. */
export const INSTALL_PROXY_ENV_FLAG = "__COFEMINE_INSTALL_PROXY";

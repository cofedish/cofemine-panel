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


import type { FastifyInstance } from "fastify";
import { ProxyAgent, request, type Dispatcher } from "undici";
import { readDownloadProxy, makeProxyUrl } from "../integrations/download-proxy.js";

/**
 * If a download-proxy is configured under Integrations, build an
 * undici dispatcher that tunnels through it. Used for outbound calls
 * to maven.neoforged.net / maven.minecraftforge.net / meta.fabricmc.net
 * etc. — the same upstreams that ETIMEDOUT direct from regions where
 * the user has set up the proxy in the first place.
 *
 * socks5:// is rewritten to http:// because undici's ProxyAgent only
 * speaks HTTP CONNECT (xray's mixed inbound on 2080 accepts both).
 * Refreshed once per minute so a config change doesn't need an api
 * restart to take effect.
 */
let cachedDispatcher: {
  d: Dispatcher | null;
  socksUrl?: string;
  at: number;
} = {
  d: null,
  at: 0,
};
async function getOutboundDispatcher(): Promise<{
  dispatcher?: Dispatcher;
  socksUrl?: string;
}> {
  const now = Date.now();
  if (now - cachedDispatcher.at < 60_000) {
    return cachedDispatcher.d
      ? { dispatcher: cachedDispatcher.d, socksUrl: cachedDispatcher.socksUrl }
      : { socksUrl: cachedDispatcher.socksUrl };
  }
  const proxy = await readDownloadProxy().catch(() => null);
  if (!proxy) {
    cachedDispatcher = { d: null, at: now };
    return {};
  }
  const url = makeProxyUrl(proxy);
  if (url.startsWith("socks")) {
    // SOCKS — return the URL, fetch helper below uses Node's https
    // module + SocksProxyAgent. undici's ProxyAgent only speaks HTTP
    // CONNECT which a SOCKS-only inbound rejects.
    cachedDispatcher = { d: null, socksUrl: url, at: now };
    return { socksUrl: url };
  }
  cachedDispatcher = { d: new ProxyAgent(url), at: now };
  return { dispatcher: cachedDispatcher.d! };
}

/** undici-or-socks-aware GET. Returns {body: string|object, status}. */
async function proxyAwareGet(
  url: string,
  opts: { accept?: "json" | "text"; headersTimeoutMs?: number }
): Promise<{ status: number; body: string }> {
  const out = await getOutboundDispatcher();
  if (out.socksUrl) {
    const [{ SocksProxyAgent }, https] = await Promise.all([
      import("socks-proxy-agent"),
      import("node:https"),
    ]);
    const agent = new SocksProxyAgent(out.socksUrl);
    return new Promise((resolve, reject) => {
      https
        .get(
          url,
          {
            agent: agent as any,
            timeout: opts.headersTimeoutMs ?? 20_000,
            headers: {
              accept: opts.accept === "json" ? "application/json" : "*/*",
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                body: Buffer.concat(chunks).toString("utf8"),
              })
            );
            res.on("error", reject);
          }
        )
        .on("error", reject)
        .on("timeout", function (this: any) {
          this.destroy(new Error("connect timeout"));
        });
    });
  }
  const res = await request(url, {
    method: "GET",
    dispatcher: out.dispatcher,
    headersTimeout: opts.headersTimeoutMs ?? 20_000,
    bodyTimeout: 30_000,
  });
  const body = await res.body.text();
  return { status: res.statusCode, body };
}

/**
 * Minecraft version metadata. Proxies Mojang's public manifest with a small
 * in-memory cache so the wizard's version dropdown doesn't hammer it.
 */

const MOJANG_MANIFEST_URL =
  "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json";

interface VersionEntry {
  id: string;
  type: "release" | "snapshot" | "old_alpha" | "old_beta";
  releaseTime: string;
}

interface CachedManifest {
  latest: { release: string; snapshot: string };
  versions: VersionEntry[];
  fetchedAt: number;
}

let cache: CachedManifest | null = null;
const TTL_MS = 60 * 60 * 1000; // 1h

async function fetchManifest(): Promise<CachedManifest> {
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache;
  const res = await request(MOJANG_MANIFEST_URL, { maxRedirections: 3 });
  if (res.statusCode >= 400) {
    throw new Error(`Mojang manifest HTTP ${res.statusCode}`);
  }
  const raw = (await res.body.json()) as {
    latest: { release: string; snapshot: string };
    versions: Array<{
      id: string;
      type: string;
      releaseTime: string;
    }>;
  };
  cache = {
    latest: raw.latest,
    versions: raw.versions.map((v) => ({
      id: v.id,
      type: v.type as VersionEntry["type"],
      releaseTime: v.releaseTime,
    })),
    fetchedAt: Date.now(),
  };
  return cache;
}

// ---------- Modloader versions ----------
//
// Both the wizard and the per-server "change loader version" dialog
// need the loader's published versions filtered by Minecraft version.
// We fetch from each project's canonical metadata source, cache for
// 1h, and normalise the result so the UI doesn't have to know that
// NeoForge ships a single global versions array while Forge ships a
// per-MC-version maven-metadata.xml.
//
// All four sources are public + key-less.

type LoaderId = "neoforge" | "forge" | "fabric" | "quilt";

type LoaderVersion = {
  /** Version itzg expects in NEOFORGE_VERSION / FORGE_VERSION /
   *  FABRIC_LOADER_VERSION / QUILT_LOADER_VERSION. */
  version: string;
  /** True if no -beta / -rc / -alpha / -pre suffix. */
  stable: boolean;
};

const loaderCache = new Map<
  string,
  { versions: LoaderVersion[]; fetchedAt: number }
>();
const LOADER_TTL_MS = 60 * 60 * 1000;

async function getLoaderVersions(
  loader: LoaderId,
  mcVersion: string
): Promise<LoaderVersion[]> {
  const key = `${loader}|${mcVersion}`;
  const hit = loaderCache.get(key);
  if (hit && Date.now() - hit.fetchedAt < LOADER_TTL_MS) return hit.versions;
  const versions = await fetchLoaderVersions(loader, mcVersion);
  loaderCache.set(key, { versions, fetchedAt: Date.now() });
  return versions;
}

async function fetchLoaderVersions(
  loader: LoaderId,
  mcVersion: string
): Promise<LoaderVersion[]> {
  switch (loader) {
    case "neoforge":
      return fetchNeoForge(mcVersion);
    case "forge":
      return fetchForge(mcVersion);
    case "fabric":
      return fetchFabric();
    case "quilt":
      return fetchQuilt();
  }
}

/** NeoForge maven exposes one flat list of versions like "21.1.95"
 *  (matches MC 1.21.1 — first two segments equal MC's "21.1" with
 *  the leading "1." stripped). 1.20.x predecessor builds use
 *  "20.x.y" so the same rule fits both. */
async function fetchNeoForge(mcVersion: string): Promise<LoaderVersion[]> {
  const res = await proxyAwareGet(
    "https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge",
    { accept: "json" }
  );
  if (res.status >= 400) {
    throw new Error(`maven.neoforged.net HTTP ${res.status}`);
  }
  const body = JSON.parse(res.body) as { versions?: string[] };
  const all = body.versions ?? [];
  const m = /^1\.(\d+)(?:\.(\d+))?/.exec(mcVersion);
  if (!m) return [];
  const major = m[1];
  const minor = m[2] ?? "0";
  const wanted = `${major}.${minor}.`;
  return all
    .filter((v) => v.startsWith(wanted))
    .map((v) => ({ version: v, stable: !/-(beta|alpha|rc|pre)/i.test(v) }))
    .sort((a, b) => compareLoaderVersion(b.version, a.version));
}

/** Forge: maven-metadata.xml has every version. We just regex out
 *  `<version>...</version>` lines instead of pulling an XML parser
 *  in — the schema is simple and stable. Versions are stored as
 *  "<mcVersion>-<forgeVersion>" (e.g. "1.20.1-47.2.0"); strip the
 *  MC prefix so the result matches what FORGE_VERSION expects. */
async function fetchForge(mcVersion: string): Promise<LoaderVersion[]> {
  const res = await proxyAwareGet(
    "https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml",
    { accept: "text", headersTimeoutMs: 30_000 }
  );
  if (res.status >= 400) {
    throw new Error(`maven.minecraftforge.net HTTP ${res.status}`);
  }
  const xml = res.body;
  const versions: string[] = [];
  const re = /<version>([^<]+)<\/version>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) versions.push(m[1]!);
  const prefix = `${mcVersion}-`;
  return versions
    .filter((v) => v.startsWith(prefix))
    .map((v) => ({ version: v.slice(prefix.length), stable: true }))
    .sort((a, b) => compareLoaderVersion(b.version, a.version));
}

/** Fabric loader is MC-version-independent — meta.fabricmc.net returns
 *  a single global list. mcVersion is accepted for API symmetry but
 *  not used. */
async function fetchFabric(): Promise<LoaderVersion[]> {
  const res = await proxyAwareGet(
    "https://meta.fabricmc.net/v2/versions/loader",
    { accept: "json" }
  );
  if (res.status >= 400) {
    throw new Error(`meta.fabricmc.net HTTP ${res.status}`);
  }
  const body = JSON.parse(res.body) as Array<{
    version: string;
    stable: boolean;
  }>;
  return body
    .map((v) => ({ version: v.version, stable: v.stable }))
    .sort((a, b) => compareLoaderVersion(b.version, a.version));
}

async function fetchQuilt(): Promise<LoaderVersion[]> {
  const res = await proxyAwareGet("https://meta.quiltmc.org/v3/versions/loader", {
    accept: "json",
  });
  if (res.status >= 400) {
    throw new Error(`meta.quiltmc.org HTTP ${res.status}`);
  }
  const body = JSON.parse(res.body) as Array<{ version: string }>;
  return body
    .map((v) => ({
      version: v.version,
      stable: !/-(beta|alpha|rc|pre)/i.test(v.version),
    }))
    .sort((a, b) => compareLoaderVersion(b.version, a.version));
}

/** Numeric-aware version compare — positive when `a > b`. Walks
 *  components left-to-right; numeric segments are compared as ints,
 *  the rest lexicographically. Good enough to sort "21.1.95" >
 *  "21.1.10" (the latter is older). */
function compareLoaderVersion(a: string, b: string): number {
  const ap = a.split(/[.\-]/);
  const bp = b.split(/[.\-]/);
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const x = ap[i] ?? "";
    const y = bp[i] ?? "";
    const xn = Number(x);
    const yn = Number(y);
    if (Number.isFinite(xn) && Number.isFinite(yn)) {
      if (xn !== yn) return xn - yn;
    } else {
      const c = x.localeCompare(y);
      if (c !== 0) return c;
    }
  }
  return 0;
}

export async function metaRoutes(app: FastifyInstance): Promise<void> {
  app.get("/mc-versions", async (req) => {
    const q = req.query as { include?: string };
    const include = (q.include ?? "release").split(",");
    try {
      const m = await fetchManifest();
      const versions = m.versions.filter((v) => include.includes(v.type));
      return {
        latest: m.latest,
        versions,
        total: versions.length,
      };
    } catch (err) {
      // Never explode the UI for metadata — return an honest "unavailable"
      // payload and let the frontend fall back to a small static list.
      req.log.warn({ err }, "mc-versions fetch failed");
      return {
        latest: { release: "1.21.1", snapshot: "" },
        versions: [] as VersionEntry[],
        total: 0,
        error: String((err as Error).message),
      };
    }
  });

  app.get("/loader-versions", async (req) => {
    const q = req.query as { loader?: string; mcVersion?: string };
    const loader = (q.loader ?? "").toLowerCase() as LoaderId;
    const mcVersion = q.mcVersion ?? "";
    if (!["neoforge", "forge", "fabric", "quilt"].includes(loader)) {
      return { versions: [], error: "unknown loader" };
    }
    if (!/^1\.\d+(\.\d+)?$/.test(mcVersion)) {
      return { versions: [], error: "invalid mcVersion" };
    }
    try {
      const versions = await getLoaderVersions(loader, mcVersion);
      return { versions, total: versions.length };
    } catch (err) {
      req.log.warn({ err, loader, mcVersion }, "loader-versions fetch failed");
      return {
        versions: [] as LoaderVersion[],
        total: 0,
        error: String((err as Error).message),
      };
    }
  });
}

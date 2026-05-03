import type { FastifyInstance } from "fastify";
import { Agent, request } from "undici";
import { docker } from "../docker.js";
import { config } from "../config.js";

/**
 * Dedicated undici Agent for the map proxy.
 *
 * Why a dedicated agent: BlueMap fires dozens of parallel tile/asset
 * fetches the moment a player moves into a new area, plus a 2-second
 * /maps/.../live/players.json poll on top. With the global undici
 * default (10 connections per origin) the players-poll would queue
 * behind tile downloads and hit headersTimeout, manifesting as an
 * intermittent 502 in the panel UI and players "disappearing" from
 * the side list even though they were still on the server.
 *
 * 64 connections per origin is way more than BlueMap will ever
 * exhaust on a normal server; it's effectively "no queueing".
 */
const proxyAgent = new Agent({
  connections: 64,
  pipelining: 1,
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
});

/**
 * HTTP forwarder from the agent to a managed Minecraft container's
 * internal port.
 *
 * Usage:
 *   GET /servers/:id/proxy/:port/*
 *
 * Resolves the container's IP on the agent's docker network,
 * connects to <ip>:<port>, forwards path + query, and pipes the
 * response body back. Used by the panel for live-map plumbing
 * (dynmap on container port 8123) without exposing the port to the
 * host or to the public internet.
 *
 * Only GET is forwarded — that's everything dynmap and similar
 * read-only viewers need, and it keeps the attack surface tiny.
 */

async function findContainerByServerId(serverId: string) {
  const containers = await docker.listContainers({
    all: false,
    filters: JSON.stringify({
      label: [`${config.AGENT_LABEL_PREFIX}.serverId=${serverId}`],
    }),
  });
  const first = containers[0];
  if (!first) return null;
  return docker.getContainer(first.Id);
}

/**
 * Pick the container's IP on the agent's known docker network. We
 * deliberately don't fall back to "first network we see" — if the
 * container ends up on a stranger network in some setups, we'd
 * rather fail loudly than proxy traffic somewhere unexpected.
 */
function pickContainerIp(
  inspect: import("dockerode").ContainerInspectInfo
): string | null {
  const networks = inspect.NetworkSettings?.Networks ?? {};
  const ours = networks[config.AGENT_DOCKER_NETWORK];
  if (ours?.IPAddress) return ours.IPAddress;
  return null;
}

/**
 * In-memory cache of serverId → resolved container IP/running state.
 *
 * Why this exists: BlueMap fans out 100+ parallel tile/asset fetches
 * the moment a player walks into a new chunk. Without a cache, each
 * proxied request did two Docker API calls (listContainers filtered
 * by label, then container.inspect) over the single docker.sock —
 * which is serialised at the daemon level and quickly becomes the
 * dominant bottleneck. Symptom: the panel page itself stalled on
 * "Loading…" because its API calls were blocked behind the map
 * traffic's queue of Docker lookups.
 *
 * 10s TTL is short enough that a container restart-with-new-IP
 * recovers within one BlueMap-burst window, but long enough to
 * absorb every burst the iframe generates inside that window.
 */
type CachedTarget = { ip: string | null; running: boolean; at: number };
const TARGET_CACHE_TTL_MS = 10_000;
const targetCache = new Map<string, CachedTarget>();

async function resolveContainerTarget(
  serverId: string
): Promise<CachedTarget> {
  const now = Date.now();
  const hit = targetCache.get(serverId);
  if (hit && now - hit.at < TARGET_CACHE_TTL_MS) return hit;
  const container = await findContainerByServerId(serverId);
  if (!container) {
    const miss = { ip: null, running: false, at: now };
    targetCache.set(serverId, miss);
    return miss;
  }
  let inspect: import("dockerode").ContainerInspectInfo;
  try {
    inspect = await container.inspect();
  } catch {
    const miss = { ip: null, running: false, at: now };
    targetCache.set(serverId, miss);
    return miss;
  }
  const target: CachedTarget = {
    ip: pickContainerIp(inspect),
    running: inspect.State?.Running === true,
    at: now,
  };
  targetCache.set(serverId, target);
  if (targetCache.size > 500) {
    const oldest = targetCache.keys().next().value;
    if (oldest) targetCache.delete(oldest);
  }
  return target;
}

/** Drop a cached entry — call when a container is recreated /
 *  destroyed so the next request re-resolves immediately instead of
 *  waiting for the TTL. */
export function invalidateProxyTarget(serverId: string): void {
  targetCache.delete(serverId);
}

/**
 * Translate a failed upstream `request()` call into a short, human-
 * readable failure mode. Walks the `cause` chain because undici wraps
 * the underlying socket error one or two levels deep.
 */
function describeUpstreamFailure(err: unknown): string {
  let e: any = err;
  for (let i = 0; i < 4 && e; i++) {
    const code = e.code;
    if (code === "ECONNREFUSED") return "connection refused — service not listening";
    if (code === "EHOSTUNREACH") return "host unreachable — wrong network?";
    if (code === "ENETUNREACH") return "network unreachable";
    if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT")
      return "connect timeout";
    if (code === "UND_ERR_HEADERS_TIMEOUT") return "headers timeout";
    if (code === "UND_ERR_BODY_TIMEOUT") return "body timeout";
    if (code === "ENOTFOUND") return "DNS lookup failed";
    if (code) return code;
    e = e.cause;
  }
  return err instanceof Error ? err.message : "unknown";
}

export async function proxyAgentRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Params: { id: string; port: string; "*": string };
    Querystring: Record<string, string>;
  }>("/servers/:id/proxy/:port/*", async (req, reply) => {
    const { id, port } = req.params;
    const subpath = (req.params["*"] as string) ?? "";
    const portNum = Number(port);
    if (
      !Number.isFinite(portNum) ||
      portNum < 1 ||
      portNum > 65535
    ) {
      return reply.code(400).send({ error: "Invalid port" });
    }

    // Use the short-TTL cache so a BlueMap tile-burst doesn't hit
    // docker.sock 200x — see resolveContainerTarget for rationale.
    const target = await resolveContainerTarget(id);
    if (!target.running && target.ip === null) {
      // Could be "container missing" or "inspect failed" — either way
      // there's nothing to forward to. Re-check on next TTL tick.
      return reply.code(404).send({ error: "Container not found" });
    }
    if (!target.running) {
      return reply.code(409).send({ error: "Container not running" });
    }
    const ip = target.ip;
    if (!ip) {
      return reply.code(503).send({
        error: `Container is not attached to the ${config.AGENT_DOCKER_NETWORK} network`,
      });
    }

    const qs = req.url.includes("?")
      ? req.url.slice(req.url.indexOf("?"))
      : "";
    const targetUrl = `http://${ip}:${portNum}/${subpath}${qs}`;

    try {
      // Forward the few headers the upstream cares about. Drop hop-by-
      // hop / auth — the upstream only sees what it needs.
      // Crucially we forward `accept-encoding` and `range`: without
      // accept-encoding BlueMap returns uncompressed JSON tiles, which
      // are several times larger and saturate the connection pool;
      // without range BlueMap can't serve byte-range requests for
      // textures.
      const fwdHeaders: Record<string, string> = {
        accept: String(req.headers["accept"] ?? "*/*"),
      };
      const ae = req.headers["accept-encoding"];
      if (ae) fwdHeaders["accept-encoding"] = String(ae);
      const inm = req.headers["if-none-match"];
      if (inm) fwdHeaders["if-none-match"] = String(inm);
      const ims = req.headers["if-modified-since"];
      if (ims) fwdHeaders["if-modified-since"] = String(ims);
      const range = req.headers["range"];
      if (range) fwdHeaders["range"] = String(range);

      const upstream = await request(targetUrl, {
        method: "GET",
        headers: fwdHeaders,
        dispatcher: proxyAgent,
        // Bump from the original 8s/30s. BlueMap can take a few
        // seconds to return a freshly-rendered tile or to flush a
        // large texture; the previous tight timeouts surfaced as
        // periodic 502 spikes the user reported during play.
        headersTimeout: 20_000,
        bodyTimeout: 60_000,
      });

      // Mirror status + relevant content headers. `content-encoding`
      // is critical: BlueMap serves its world tiles as gzipped JSON
      // (`.prbm` / `.json.gz`-style payloads with content-encoding: gzip)
      // and stripping the header makes the browser hand the gzipped
      // bytes to the JS client as plain → silently fails to parse →
      // black map outside the small initial area.
      const passHeaders = [
        "content-type",
        "content-length",
        "content-encoding",
        "vary",
        "cache-control",
        "etag",
        "last-modified",
        "accept-ranges",
      ] as const;
      for (const h of passHeaders) {
        const v = upstream.headers[h];
        if (v) reply.header(h, Array.isArray(v) ? v[0]! : v);
      }
      reply.code(upstream.statusCode);
      return reply.send(upstream.body);
    } catch (err) {
      req.log.warn({ err, targetUrl }, "proxy upstream failed");
      // Surface the actual failure mode so the panel UI / logs can
      // tell apart "the map service isn't listening" (ECONNREFUSED)
      // vs "the container is unreachable on this network" (timeout /
      // EHOSTUNREACH) vs "DNS broke" (ENOTFOUND). The previous
      // generic "Upstream unavailable" hid all of these and made
      // BlueMap/dynmap debugging guesswork.
      const reason = describeUpstreamFailure(err);
      return reply.code(502).send({
        error: `Upstream unavailable (${reason})`,
        target: `${ip}:${portNum}`,
        reason,
      });
    }
  });
}

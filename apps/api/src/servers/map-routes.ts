import type { FastifyInstance } from "fastify";
import { Agent, request } from "undici";
import { prisma } from "../db.js";
import { assertServerPermission } from "../auth/rbac.js";

/**
 * Dedicated undici Agent for panel→agent map proxy hops. Same
 * reasoning as the agent-side pool: BlueMap fans out tile/asset
 * fetches in parallel, and the live-players poll runs alongside.
 * The default 10-conn pool would cause /live/players.json polls to
 * queue behind tile downloads and surface as intermittent 502s in
 * the UI plus players "disappearing" from the side list.
 */
const mapProxyAgent = new Agent({
  connections: 64,
  pipelining: 1,
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
});

/**
 * Live-map proxy. Bridges the panel UI to a dynmap or BlueMap HTTP
 * server running inside the Minecraft container.
 *
 * Routes:
 *   GET /servers/:id/map/probe          → auto-detects which provider
 *                                          (if any) is responding and
 *                                          returns its kind for the UI
 *   GET /servers/:id/map/dynmap/*       → forwards to dynmap on 8123
 *   GET /servers/:id/map/bluemap/*      → forwards to bluemap on 8100
 *   GET /servers/:id/map/* (legacy)     → defaults to dynmap path
 *
 * Design:
 *   • Auth here: only users with server.view can poke the map proxy.
 *     The provider ports themselves never get exposed publicly.
 *   • Body streamed through; relevant content/cache headers mirrored.
 *   • GET-only — same as the agent-side proxy. Chat-send POSTs and
 *     similar control endpoints aren't bridged on purpose.
 */

const PORT_DYNMAP = 8123;
const PORT_BLUEMAP = 8100;

function resolveAgentToken(nodeName: string): string {
  const perNode = process.env[`AGENT_TOKEN_${nodeName.toUpperCase()}`];
  return perNode ?? process.env.AGENT_TOKEN ?? "";
}

/**
 * In-memory cache of serverId → node lookup.
 *
 * Why this exists: BlueMap fires dozens of parallel tile fetches the
 * moment a player walks into a new chunk. The previous code did two
 * Postgres queries per fetch (server.findUnique + node.findUnique),
 * so 100 concurrent tiles meant 200 queries on a Prisma pool of ~10
 * connections. Effect: the entire panel froze while the map was open,
 * because every other page that needed Postgres got queued behind
 * the map's flood.
 *
 * The serverId → node mapping changes only when an admin moves a
 * server between nodes (rare, manual). 60s TTL is plenty.
 */
type CachedNode = { node: Awaited<ReturnType<typeof prisma.node.findUnique>>; at: number };
const NODE_CACHE_TTL_MS = 60_000;
const nodeCache = new Map<string, CachedNode>();

async function resolveServerNode(id: string) {
  const now = Date.now();
  const hit = nodeCache.get(id);
  if (hit && now - hit.at < NODE_CACHE_TTL_MS) return hit.node;
  const server = await prisma.server.findUnique({
    where: { id },
    select: { nodeId: true },
  });
  if (!server) {
    nodeCache.set(id, { node: null, at: now });
    return null;
  }
  const node = await prisma.node.findUnique({ where: { id: server.nodeId } });
  nodeCache.set(id, { node, at: now });
  // Cap cache size — don't grow unbounded if a script hits us with
  // millions of fake server IDs. 500 is comfortably above any real
  // panel's server count.
  if (nodeCache.size > 500) {
    const oldest = nodeCache.keys().next().value;
    if (oldest) nodeCache.delete(oldest);
  }
  return node;
}

/**
 * Permission cache for the map hot-path. Same reasoning as the node
 * cache: assertServerPermission queries `permissions` joined to the
 * user's role on every call, and BlueMap fans out enough requests to
 * exhaust the DB pool. We cache (userId, serverId, perm) → boolean for
 * 30s. Auth still goes through the cookie/JWT validation on every
 * request — it's only the permission lookup that's cached.
 */
type CachedPerm = { ok: boolean; at: number };
const PERM_CACHE_TTL_MS = 30_000;
const permCache = new Map<string, CachedPerm>();

async function assertServerPermissionCached(
  req: import("fastify").FastifyRequest,
  serverId: string,
  perm: string
): Promise<void> {
  // Force JWT/session validation by accessing req.user (populated by
  // the auth hook). If the user isn't authed, this throws via the
  // existing auth pipeline; we don't bypass auth, only the perm check.
  const user = (req as any).user as { id?: string } | undefined;
  const key = user?.id ? `${user.id}|${serverId}|${perm}` : null;
  if (key) {
    const hit = permCache.get(key);
    if (hit && Date.now() - hit.at < PERM_CACHE_TTL_MS) {
      if (hit.ok) return;
      // negative cache: re-run the assert so it throws the proper
      // 403 with the standard error shape
    }
  }
  await assertServerPermission(req, serverId, perm);
  if (key) {
    permCache.set(key, { ok: true, at: Date.now() });
    if (permCache.size > 2000) {
      const oldest = permCache.keys().next().value;
      if (oldest) permCache.delete(oldest);
    }
  }
}

/**
 * Forward one GET to the agent's container proxy on the chosen
 * upstream port. Returns the streamed reply or sends a 502 if the
 * upstream isn't responding.
 */
async function forwardToProvider(
  app: FastifyInstance,
  req: import("fastify").FastifyRequest,
  reply: import("fastify").FastifyReply,
  serverId: string,
  port: number,
  subpath: string,
  errorHint: string
): Promise<unknown> {
  const node = await resolveServerNode(serverId);
  if (!node) return reply.code(404).send({ error: "Server / node not found" });

  const qs = req.url.includes("?")
    ? req.url.slice(req.url.indexOf("?"))
    : "";
  const target = `${node.host.replace(/\/$/, "")}/servers/${serverId}/proxy/${port}/${subpath}${qs}`;

  try {
    // Forward enough of the request for caching + ranged fetches to
    // work end-to-end. accept-encoding is critical: without it the
    // upstream (BlueMap container) returns uncompressed JSON tiles,
    // which are several times larger and exhaust the connection pool.
    const fwdHeaders: Record<string, string> = {
      authorization: `Bearer ${resolveAgentToken(node.name)}`,
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

    const upstream = await request(target, {
      method: "GET",
      headers: fwdHeaders,
      dispatcher: mapProxyAgent,
      headersTimeout: 20_000,
      bodyTimeout: 60_000,
    });
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
    // If the agent itself returned a 502 (its upstream — the map
    // service inside the container — was unreachable), forward its
    // structured `{ error, reason, target }` body instead of masking
    // it with our generic hint. Without this the user sees only
    // "BlueMap is not running" and can't tell apart "config wrong"
    // / "service crashed" / "wrong docker network".
    if (upstream.statusCode === 502) {
      const ct = String(upstream.headers["content-type"] ?? "");
      if (ct.startsWith("application/json")) {
        try {
          const body = (await upstream.body.json()) as {
            error?: string;
            reason?: string;
            target?: string;
          };
          return reply.code(502).send({
            error: errorHint,
            reason: body.reason,
            target: body.target,
            agentMessage: body.error,
          });
        } catch {
          // fall through to the generic path below
        }
      }
    }
    reply.code(upstream.statusCode);
    return reply.send(upstream.body);
  } catch (err) {
    req.log.warn({ err, target }, "map proxy upstream failed");
    return reply.code(502).send({ error: errorHint });
  }
}

/**
 * One-shot ping at a known sentinel path of each provider. Cheaper
 * than a full forward — we just want to know whether anyone is
 * responding on that port.
 */
async function pingProvider(
  nodeHost: string,
  nodeName: string,
  serverId: string,
  port: number,
  sentinelPath: string
): Promise<boolean> {
  const target = `${nodeHost.replace(/\/$/, "")}/servers/${serverId}/proxy/${port}/${sentinelPath}`;
  try {
    const res = await request(target, {
      method: "GET",
      headers: {
        authorization: `Bearer ${resolveAgentToken(nodeName)}`,
        accept: "application/json",
      },
      headersTimeout: 4_000,
      bodyTimeout: 6_000,
    });
    await res.body.dump().catch(() => {});
    return res.statusCode >= 200 && res.statusCode < 400;
  } catch {
    return false;
  }
}

export async function mapRoutes(app: FastifyInstance): Promise<void> {
  // Probe — used by the UI to decide which renderer to mount.
  app.get<{ Params: { id: string } }>(
    "/servers/:id/map/probe",
    async (req, reply) => {
      const { id } = req.params;
      await assertServerPermission(req, id, "server.view");
      const node = await resolveServerNode(id);
      if (!node) return reply.code(404).send({ error: "Not found" });
      // Probe both providers in parallel. dynmap exposes the
      // standalone config JSON we already use; BlueMap exposes
      // settings.json at its root.
      const [dynmap, bluemap] = await Promise.all([
        pingProvider(
          node.host,
          node.name,
          id,
          PORT_DYNMAP,
          "standalone/dynmap_config.json"
        ),
        pingProvider(node.host, node.name, id, PORT_BLUEMAP, "settings.json"),
      ]);
      // dynmap wins ties — its UI is more polished and the player
      // overlay is richer. BlueMap is the fallback for newer MC
      // releases dynmap doesn't support yet.
      const provider: "dynmap" | "bluemap" | null = dynmap
        ? "dynmap"
        : bluemap
          ? "bluemap"
          : null;
      return { provider, dynmap, bluemap };
    }
  );

  // NOTE: register both the bare and wildcard form for each provider.
  // Fastify's wildcard `*` does not reliably match the empty path, so
  // GET /servers/:id/map/bluemap/ (the iframe root) needs its own
  // bare handler — without it the iframe's index.html request fell
  // through to the legacy /map/* route and 404'd.
  const dynmapHandler = async (
    req: import("fastify").FastifyRequest,
    reply: import("fastify").FastifyReply
  ) => {
    const params = req.params as { id: string; "*"?: string };
    const subpath = (params["*"] as string) ?? "";
    await assertServerPermissionCached(req, params.id, "server.view");
    return forwardToProvider(
      app,
      req,
      reply,
      params.id,
      PORT_DYNMAP,
      subpath,
      "Dynmap is not running on this server."
    );
  };
  app.get("/servers/:id/map/dynmap", dynmapHandler);
  app.get("/servers/:id/map/dynmap/*", dynmapHandler);

  const bluemapHandler = async (
    req: import("fastify").FastifyRequest,
    reply: import("fastify").FastifyReply
  ) => {
    const params = req.params as { id: string; "*"?: string };
    const subpath = (params["*"] as string) ?? "";
    await assertServerPermissionCached(req, params.id, "server.view");
    return forwardToProvider(
      app,
      req,
      reply,
      params.id,
      PORT_BLUEMAP,
      subpath,
      "BlueMap is not running on this server."
    );
  };
  app.get("/servers/:id/map/bluemap", bluemapHandler);
  app.get("/servers/:id/map/bluemap/*", bluemapHandler);

  // Backwards-compatible: anything not under /dynmap or /bluemap is
  // probably a stale URL (old client that hit the panel before the
  // dual-provider split). Probe whichever provider is actually
  // listening and route to it instead of hard-coding port 8123 — the
  // hard-code was visible to users as "target: 172.23.0.3:8123,
  // connection refused" on bluemap-only servers.
  app.get<{ Params: { id: string; "*": string } }>(
    "/servers/:id/map/*",
    async (req, reply) => {
      const { id } = req.params;
      const subpath = (req.params["*"] as string) ?? "";
      // The /probe and /dynmap/* and /bluemap/* routes above match
      // first; only legacy paths fall through here.
      if (
        subpath.startsWith("dynmap/") ||
        subpath.startsWith("bluemap/") ||
        subpath === "probe"
      ) {
        return reply.code(404).send({ error: "Use the dedicated subroute" });
      }
      await assertServerPermission(req, id, "server.view");
      // Log loudly: by the time we deployed prefixed routes, nothing
      // in our UI should be hitting this fallthrough. If it fires,
      // something is calling the panel with a stale URL pattern and
      // we want to know about it.
      req.log.warn(
        { serverId: id, subpath, ua: req.headers["user-agent"] },
        "legacy /map/* fallthrough hit — caller is using a non-prefixed map URL"
      );
      const node = await resolveServerNode(id);
      if (!node) return reply.code(404).send({ error: "Server / node not found" });
      const [dynmapUp, bluemapUp] = await Promise.all([
        pingProvider(
          node.host,
          node.name,
          id,
          PORT_DYNMAP,
          "standalone/dynmap_config.json"
        ),
        pingProvider(node.host, node.name, id, PORT_BLUEMAP, "settings.json"),
      ]);
      const port = dynmapUp ? PORT_DYNMAP : bluemapUp ? PORT_BLUEMAP : null;
      if (port === null) {
        return reply.code(502).send({
          error: "Map server unreachable. Is dynmap or bluemap installed?",
          reason: "no provider responded on either 8123 or 8100",
        });
      }
      return forwardToProvider(
        app,
        req,
        reply,
        id,
        port,
        subpath,
        "Map server unreachable. Is dynmap or bluemap installed?"
      );
    }
  );
}

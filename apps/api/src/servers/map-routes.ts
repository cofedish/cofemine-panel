import type { FastifyInstance } from "fastify";
import { request } from "undici";
import { prisma } from "../db.js";
import { assertServerPermission } from "../auth/rbac.js";

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

async function resolveServerNode(id: string) {
  const server = await prisma.server.findUnique({
    where: { id },
    select: { nodeId: true },
  });
  if (!server) return null;
  const node = await prisma.node.findUnique({ where: { id: server.nodeId } });
  return node;
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
    const upstream = await request(target, {
      method: "GET",
      headers: {
        authorization: `Bearer ${resolveAgentToken(node.name)}`,
        accept: req.headers["accept"] ?? "*/*",
        ...(req.headers["if-none-match"]
          ? { "if-none-match": String(req.headers["if-none-match"]) }
          : {}),
        ...(req.headers["if-modified-since"]
          ? {
              "if-modified-since": String(req.headers["if-modified-since"]),
            }
          : {}),
      },
      headersTimeout: 8_000,
      bodyTimeout: 30_000,
    });
    const passHeaders = [
      "content-type",
      "content-length",
      "cache-control",
      "etag",
      "last-modified",
    ] as const;
    for (const h of passHeaders) {
      const v = upstream.headers[h];
      if (v) reply.header(h, Array.isArray(v) ? v[0]! : v);
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

  app.get<{ Params: { id: string; "*": string } }>(
    "/servers/:id/map/dynmap/*",
    async (req, reply) => {
      const { id } = req.params;
      const subpath = (req.params["*"] as string) ?? "";
      await assertServerPermission(req, id, "server.view");
      return forwardToProvider(
        app,
        req,
        reply,
        id,
        PORT_DYNMAP,
        subpath,
        "Dynmap is not running on this server."
      );
    }
  );

  app.get<{ Params: { id: string; "*": string } }>(
    "/servers/:id/map/bluemap/*",
    async (req, reply) => {
      const { id } = req.params;
      const subpath = (req.params["*"] as string) ?? "";
      await assertServerPermission(req, id, "server.view");
      return forwardToProvider(
        app,
        req,
        reply,
        id,
        PORT_BLUEMAP,
        subpath,
        "BlueMap is not running on this server."
      );
    }
  );

  // Backwards-compatible: anything not under /dynmap or /bluemap
  // defaults to dynmap. The previous ServerMap implementation hit
  // /servers/:id/map/standalone/... etc. directly, and we don't want
  // to break it while we migrate.
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
      return forwardToProvider(
        app,
        req,
        reply,
        id,
        PORT_DYNMAP,
        subpath,
        "Map server unreachable. Is dynmap or bluemap installed?"
      );
    }
  );
}

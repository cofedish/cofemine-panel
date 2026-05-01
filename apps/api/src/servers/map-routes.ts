import type { FastifyInstance } from "fastify";
import { request } from "undici";
import { prisma } from "../db.js";
import { assertServerPermission } from "../auth/rbac.js";

/**
 * Live-map proxy. Bridges the panel UI to a dynmap (or compatible)
 * HTTP server running inside the Minecraft container.
 *
 * Path: GET /servers/:id/map/* — everything after `/map/` is
 * forwarded verbatim to the agent's container-proxy on dynmap's
 * default port (8123). The agent then resolves the container's IP
 * on the docker network and forwards the request.
 *
 * Design notes:
 *   • Auth happens here: only users with server.view can poke the
 *     map proxy. The dynmap port itself never gets exposed publicly.
 *   • Body is streamed through (binary tile PNGs would be wasteful
 *     to JSON-parse), and a few content headers are mirrored so
 *     Leaflet's tile-layer caching works.
 *   • Only GET — same as the agent-side proxy. dynmap has chat-send
 *     POST endpoints we don't bridge through, on purpose.
 */

// Default dynmap webserver-port. Configurable via env if a server
// admin moved it; for the MVP we hard-code the upstream default.
const DYNMAP_PORT = 8123;

function resolveAgentToken(nodeName: string): string {
  const perNode = process.env[`AGENT_TOKEN_${nodeName.toUpperCase()}`];
  return perNode ?? process.env.AGENT_TOKEN ?? "";
}

export async function mapRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Params: { id: string; "*": string };
  }>("/servers/:id/map/*", async (req, reply) => {
    const { id } = req.params;
    const subpath = (req.params["*"] as string) ?? "";
    await assertServerPermission(req, id, "server.view");

    const server = await prisma.server.findUnique({
      where: { id },
      select: { nodeId: true },
    });
    if (!server) return reply.code(404).send({ error: "Server not found" });
    const node = await prisma.node.findUnique({
      where: { id: server.nodeId },
    });
    if (!node) return reply.code(404).send({ error: "Node not found" });

    const qs = req.url.includes("?")
      ? req.url.slice(req.url.indexOf("?"))
      : "";
    const target = `${node.host.replace(/\/$/, "")}/servers/${id}/proxy/${DYNMAP_PORT}/${subpath}${qs}`;

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
      return reply
        .code(502)
        .send({ error: "Map server unreachable. Is dynmap installed?" });
    }
  });
}

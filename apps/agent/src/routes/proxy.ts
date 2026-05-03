import type { FastifyInstance } from "fastify";
import { request } from "undici";
import { docker } from "../docker.js";
import { config } from "../config.js";

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

    const container = await findContainerByServerId(id);
    if (!container) {
      return reply.code(404).send({ error: "Container not found" });
    }

    let inspect: import("dockerode").ContainerInspectInfo;
    try {
      inspect = await container.inspect();
    } catch {
      return reply.code(404).send({ error: "Container not found" });
    }
    if (inspect.State?.Running !== true) {
      return reply.code(409).send({ error: "Container not running" });
    }
    const ip = pickContainerIp(inspect);
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
      const upstream = await request(targetUrl, {
        method: "GET",
        headers: {
          // Pass through a few headers the upstream might care about.
          // Drop hop-by-hop / auth headers from the panel — the
          // upstream only sees what it needs.
          accept: req.headers["accept"] ?? "*/*",
          "if-none-match": req.headers["if-none-match"] ?? "",
          "if-modified-since": req.headers["if-modified-since"] ?? "",
        },
        // Reasonable upper bounds: dynmap tile responses are small,
        // config/world JSON tiny, and we don't want a slow upstream
        // to hold the agent worker forever.
        headersTimeout: 8_000,
        bodyTimeout: 30_000,
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

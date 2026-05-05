import type { FastifyReply } from "fastify";
import { Agent as UndiciAgent, request as undiciRequest } from "undici";
import type { Server, Node } from "@prisma/client";
import { readDownloadProxy, makeProxyUrl } from "../integrations/download-proxy.js";

function resolveAgentToken(nodeName: string): string {
  const perNode = process.env[`AGENT_TOKEN_${nodeName.toUpperCase()}`];
  return perNode ?? process.env.AGENT_TOKEN ?? "";
}

/**
 * Stream the agent's .mrpack export through the panel to the caller.
 * Used by both the authenticated /servers/:id/export-mrpack endpoint
 * and the public /p/:token.mrpack endpoint (resolved by token first
 * → server, then handed here).
 */
export async function streamMrpack(
  server: Server,
  node: Node,
  reply: FastifyReply,
  opts: { includeAutoDetected?: boolean } = {}
): Promise<FastifyReply> {
  const env = ((server.env as Record<string, string> | null) ?? {}) as Record<
    string,
    string
  >;
  let loader: string | null = null;
  let loaderVersion: string | null = null;
  if (env.NEOFORGE_VERSION) {
    loader = "neoforge";
    loaderVersion = env.NEOFORGE_VERSION;
  } else if (env.FORGE_VERSION) {
    loader = "forge";
    loaderVersion = env.FORGE_VERSION;
  } else if (env.FABRIC_LOADER_VERSION) {
    loader = "fabric";
    loaderVersion = env.FABRIC_LOADER_VERSION;
  } else if (env.QUILT_LOADER_VERSION) {
    loader = "quilt";
    loaderVersion = env.QUILT_LOADER_VERSION;
  }
  const params = new URLSearchParams();
  params.set("packName", server.name);
  params.set("mcVersion", server.version);
  if (loader) params.set("loader", loader);
  if (loaderVersion) params.set("loaderVersion", loaderVersion);
  const proxy = await readDownloadProxy().catch(() => null);
  if (proxy) params.set("proxyUrl", makeProxyUrl(proxy));
  if (opts.includeAutoDetected === false) params.set("includeAutoDetected", "0");

  const dispatcher = new UndiciAgent({
    connections: 4,
    bodyTimeout: 10 * 60_000,
  });
  const target = `${node.host.replace(/\/$/, "")}/servers/${server.id}/export-mrpack?${params.toString()}`;
  const upstream = await undiciRequest(target, {
    method: "GET",
    headers: {
      authorization: `Bearer ${resolveAgentToken(node.name)}`,
    },
    dispatcher,
    headersTimeout: 30_000,
    bodyTimeout: 10 * 60_000,
  });
  if (upstream.statusCode >= 400) {
    reply.code(upstream.statusCode);
    return reply.send(upstream.body);
  }
  for (const h of ["content-type", "content-disposition"] as const) {
    const v = upstream.headers[h];
    if (v) reply.header(h, Array.isArray(v) ? v[0]! : v);
  }
  reply.code(upstream.statusCode);
  return reply.send(upstream.body);
}

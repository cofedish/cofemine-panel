import type { FastifyReply } from "fastify";
import { Agent as UndiciAgent, request as undiciRequest } from "undici";
import type { Server, Node } from "@prisma/client";
import { readDownloadProxy, makeProxyUrl } from "../integrations/download-proxy.js";

function resolveAgentToken(nodeName: string): string {
  const perNode = process.env[`AGENT_TOKEN_${nodeName.toUpperCase()}`];
  return perNode ?? process.env.AGENT_TOKEN ?? "";
}

const MC_VERSION_RE = /^\d+\.\d+(\.\d+)?$/;

/**
 * Derive a real Minecraft version (e.g. "1.21.1") from the server record.
 *
 * `server.version` is what's typed into the panel's "version" field, but
 * for CF / Modrinth packs that's frequently "LATEST" — itzg accepts that
 * literal as "use whatever the pack manifest says". The string then leaks
 * into our generated .mrpack as `dependencies.minecraft = "LATEST"`, and
 * any sane launcher (HMCL, Prism, Modrinth App) errors out trying to
 * resolve it against Mojang's piston-meta.
 *
 * Strategy: if `server.version` already looks like a real version
 * (X.Y / X.Y.Z), use it. Otherwise derive from the loader-version env
 * because every loader's version string carries the MC version it
 * targets:
 *   - NeoForge "21.1.228"     → "1.21.1"
 *   - NeoForge "21.0.143"     → "1.21"      (patch 0 collapses)
 *   - Forge    "1.20.1-47.3.0" → "1.20.1"
 *   - Fabric / Quilt: loader version doesn't carry MC version → fall
 *     back to whatever's in server.version (best effort).
 */
export function resolveMcVersion(server: Server): string {
  const stored = server.version;
  if (MC_VERSION_RE.test(stored)) return stored;
  const env = ((server.env as Record<string, string> | null) ?? {}) as Record<
    string,
    string
  >;
  if (env.NEOFORGE_VERSION) {
    const parts = env.NEOFORGE_VERSION.split(".");
    if (parts.length >= 2) {
      const [major, patch] = parts;
      return patch === "0" ? `1.${major}` : `1.${major}.${patch}`;
    }
  }
  if (env.FORGE_VERSION && env.FORGE_VERSION.includes("-")) {
    const mc = env.FORGE_VERSION.split("-")[0];
    if (mc && MC_VERSION_RE.test(mc)) return mc;
  }
  if (env.CF_MOD_LOADER_VERSION) {
    const parts = env.CF_MOD_LOADER_VERSION.split(".");
    if (parts.length >= 2) {
      const [major, patch] = parts;
      return patch === "0" ? `1.${major}` : `1.${major}.${patch}`;
    }
  }
  return stored;
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
  params.set("mcVersion", resolveMcVersion(server));
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

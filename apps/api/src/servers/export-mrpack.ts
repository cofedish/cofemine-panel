import type { FastifyReply } from "fastify";
import { Agent as UndiciAgent, request as undiciRequest } from "undici";
import type { Server, Node } from "@prisma/client";
import { readDownloadProxy, makeProxyUrl } from "../integrations/download-proxy.js";
import { readCurseforgeApiKey } from "./service.js";

function resolveAgentToken(nodeName: string): string {
  const perNode = process.env[`AGENT_TOKEN_${nodeName.toUpperCase()}`];
  return perNode ?? process.env.AGENT_TOKEN ?? "";
}

/**
 * Resolve a CF modpack slug → projectId via the CF API.
 * itzg's CF feature stores the slug (CF_SLUG) and file id (CF_FILE_ID)
 * in the server env, but the export-mrpack rebuild logic in the agent
 * needs the numeric projectId for /v1/mods/<id>/files/<id>. Single
 * /v1/mods/search call resolves it.
 */
async function resolveCfProjectIdFromSlug(
  slug: string,
  apiKey: string
): Promise<number | null> {
  const url = `https://api.curseforge.com/v1/mods/search?gameId=432&slug=${encodeURIComponent(slug)}`;
  const res = await undiciRequest(url, {
    method: "GET",
    headers: { "x-api-key": apiKey, accept: "application/json" },
    headersTimeout: 15_000,
    bodyTimeout: 15_000,
  });
  if (res.statusCode >= 400) {
    await res.body.dump().catch(() => {});
    return null;
  }
  const body = (await res.body.json()) as {
    data?: Array<{ id: number; slug: string }>;
  };
  const match = body.data?.find((m) => m.slug === slug) ?? body.data?.[0];
  return match?.id ?? null;
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

  // CF rebuild mode: when the server has a stored CF pack reference
  // AND we have the API key, pass them through so the agent re-fetches
  // the canonical pack and produces a 1:1 client copy of it (instead
  // of dumping /data/ verbatim). This is what makes the resulting
  // .mrpack actually identical to "downloaded the pack from CurseForge
  // App, plus user's manual mods on top".
  //
  // Priority: persisted server.cfPackProjectId/cfPackFileId (preferred,
  // survives detach-from-source) → fall back to live env.CF_SLUG/
  // CF_FILE_ID (for legacy servers without the persisted columns).
  const cfApiKey = await readCurseforgeApiKey().catch(() => null);
  let cfProjectId: number | null = server.cfPackProjectId ?? null;
  let cfFileId: number | null = server.cfPackFileId ?? null;
  if ((!cfProjectId || !cfFileId) && cfApiKey && env.CF_SLUG && env.CF_FILE_ID) {
    const parsed = parseInt(env.CF_FILE_ID, 10);
    if (Number.isFinite(parsed)) {
      cfFileId = parsed;
      cfProjectId = await resolveCfProjectIdFromSlug(env.CF_SLUG, cfApiKey).catch(
        () => null
      );
    }
  }
  const cfHeaders: Record<string, string> = {};
  if (cfApiKey && cfProjectId && cfFileId) {
    params.set("cfPackProjectId", String(cfProjectId));
    params.set("cfPackFileId", String(cfFileId));
    cfHeaders["x-cf-api-key"] = cfApiKey;
  }
  // Per-server filename exclusions — owner-managed list of mods to drop
  // from the .mrpack (typical use case: a client mod that conflicts
  // with another in the pack). Forwarded to the agent as a JSON array
  // in a header; agent skips matching filenames in BOTH the CF rebuild
  // and the user-additions passes.
  const exclusions = (server.clientPackExclusions ?? []) as string[];
  if (exclusions.length > 0) {
    cfHeaders["x-cofemine-exclude-filenames"] = JSON.stringify(exclusions);
  }

  const dispatcher = new UndiciAgent({
    connections: 4,
    bodyTimeout: 30 * 60_000, // 30 min — CF rebuild streams 320+ files
  });
  const target = `${node.host.replace(/\/$/, "")}/servers/${server.id}/export-mrpack?${params.toString()}`;
  const upstream = await undiciRequest(target, {
    method: "GET",
    headers: {
      authorization: `Bearer ${resolveAgentToken(node.name)}`,
      ...cfHeaders,
    },
    dispatcher,
    headersTimeout: 60_000,
    bodyTimeout: 30 * 60_000,
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

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Server } from "@prisma/client";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { streamMrpack, resolveMcVersion } from "./export-mrpack.js";

/**
 * Unauthenticated client-pack endpoints. Mounted at root under /p/.
 * All paths under /p/ are whitelisted in the global auth gate
 * (see apps/api/src/main.ts).
 *
 * Surface:
 *   GET /p/<token>.mrpack  — binary ZIP download (Modrinth .mrpack format)
 *   GET /p/<token>.json    — metadata-only JSON for that one pack
 *   GET /p/index.json      — listing of every server with a public token
 *
 * The token is a 32-hex-char value generated via the authenticated
 * POST /servers/:id/public-pack-token endpoint. The owner can rotate
 * (re-POST) or revoke (DELETE) at any time.
 */

type PackMetadata = {
  id: string;
  displayName: string;
  versionName: string;
  minecraft: string;
  loader: "neoforge" | "forge" | "fabric" | "quilt" | null;
  loaderVersion: string | null;
  mrpackUrl: string;
  metadataUrl: string;
  updatedAt: string;
};

function deriveLoader(server: Server): {
  loader: PackMetadata["loader"];
  loaderVersion: string | null;
} {
  const env = ((server.env as Record<string, string> | null) ?? {}) as Record<
    string,
    string
  >;
  if (env.NEOFORGE_VERSION) return { loader: "neoforge", loaderVersion: env.NEOFORGE_VERSION };
  if (env.FORGE_VERSION) return { loader: "forge", loaderVersion: env.FORGE_VERSION };
  if (env.FABRIC_LOADER_VERSION) return { loader: "fabric", loaderVersion: env.FABRIC_LOADER_VERSION };
  if (env.QUILT_LOADER_VERSION) return { loader: "quilt", loaderVersion: env.QUILT_LOADER_VERSION };
  // CURSEFORGE auto-pack servers don't have *_VERSION env set — itzg
  // detects the loader from the pack manifest at install time and
  // never writes it back. createServerRecord stamps CF_DETECTED_LOADER
  // up-front from CF API so this metadata endpoint (and anything else
  // that reads server.env) sees the right loader from day one. Loader
  // version is null because CF metadata doesn't ship a pinned loader
  // version — the launcher only needs the *type* to pick the right
  // entry point.
  const detected = env.CF_DETECTED_LOADER?.toLowerCase();
  if (detected === "neoforge" || detected === "forge" || detected === "fabric" || detected === "quilt") {
    return { loader: detected, loaderVersion: null };
  }
  return { loader: null, loaderVersion: null };
}

/**
 * Base URL used to build the client-pack links in these public
 * responses.
 *
 * `PUBLIC_BASE_URL` wins when configured. Without it we fall back to the
 * request's own Host, which is attacker-controlled — a request carrying
 * a forged `Host` gets back a pack listing whose `mrpackUrl` points at
 * the attacker's domain. Impact is limited today (these responses are
 * `no-store`, so there is no shared cache to poison, and the forged
 * answer goes back to whoever forged it), but any operator serving real
 * packs should set the env var and take the header out of the loop.
 */
let warnedAboutHostFallback = false;

function publicBaseUrl(req: FastifyRequest): string {
  const configured = config.PUBLIC_BASE_URL;
  if (configured) return configured.replace(/\/$/, "");
  if (!warnedAboutHostFallback) {
    warnedAboutHostFallback = true;
    req.log.warn(
      "PUBLIC_BASE_URL is not set — client-pack links are being built from the " +
        "client-supplied Host header. Set it on any panel serving real packs."
    );
  }
  const proto = req.protocol || "https";
  const host = req.hostname || (req.headers.host as string | undefined) || "";
  return `${proto}://${host}`;
}

function packMetadata(server: Server, baseUrl: string): PackMetadata {
  const { loader, loaderVersion } = deriveLoader(server);
  const token = server.publicPackToken!;
  return {
    id: server.id,
    displayName: server.name,
    versionName: server.name,
    minecraft: resolveMcVersion(server),
    loader,
    loaderVersion,
    mrpackUrl: `${baseUrl}/api/p/${token}.mrpack`,
    metadataUrl: `${baseUrl}/api/p/${token}.json`,
    updatedAt: server.updatedAt.toISOString(),
  };
}

export async function publicPackRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Listing of every server that currently has a public pack token.
   *
   * Anyone who knows the panel URL can enumerate this — by design.
   * Owners who don't want a server in the listing should not enable
   * the public pack token in the first place (or revoke it via the
   * Client Pack tab → "Disable").
   *
   * Lives at /p/index.json (NOT /p/<token>.json) — the regex below
   * makes sure the token-only metadata route doesn't shadow it.
   */
  app.get("/p/index.json", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const servers = await prisma.server.findMany({
      // Opt-in only. This response embeds each server's raw pack token
      // in a URL, so listing a server here converts its unguessable
      // link into public knowledge — and the pack it points at contains
      // a servers.dat with the server address. Owners now tick a box
      // per server instead of every tokened server being enumerable.
      where: { publicPackToken: { not: null }, publicPackListed: true },
      orderBy: { updatedAt: "desc" },
    });
    const baseUrl = publicBaseUrl(req);
    reply.header("cache-control", "no-store");
    return {
      packs: servers.map((s) => packMetadata(s, baseUrl)),
      generatedAt: new Date().toISOString(),
    };
  });

  /**
   * Per-pack metadata + binary download under one `/p/:tokenWithExt`
   * route, dispatching on the extension. Two extensions supported:
   *   .mrpack → stream the ZIP
   *   .json   → return metadata only (cheap, no agent call)
   */
  // Tighter than the global 600/min. A `.mrpack` request makes the
  // agent assemble a ZIP out of every jar on the server, unauthenticated
  // — one client looping this endpoint is enough to keep a node busy
  // indefinitely.
  app.get("/p/:tokenWithExt", {
    config: { rateLimit: { max: 12, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const { tokenWithExt } = req.params as { tokenWithExt: string };
    const m = /^([a-f0-9]{32})\.(mrpack|json)$/i.exec(tokenWithExt);
    if (!m) {
      reply.code(404);
      return { error: "Not found" };
    }
    const token = m[1]!.toLowerCase();
    const ext = m[2]!.toLowerCase();
    const server = await prisma.server.findUnique({
      where: { publicPackToken: token },
    });
    if (!server) {
      reply.code(404);
      return { error: "Not found" };
    }
    if (ext === "json") {
      reply.header("cache-control", "no-store");
      return packMetadata(server, publicBaseUrl(req));
    }
    const node = await prisma.node.findUniqueOrThrow({
      where: { id: server.nodeId },
    });
    return streamMrpack(server, node, reply, { includeAutoDetected: true });
  });
}

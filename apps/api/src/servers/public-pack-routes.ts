import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Server } from "@prisma/client";
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
  return { loader: null, loaderVersion: null };
}

/** Public base URL the request came in on. Honours X-Forwarded-* headers
 *  because Fastify is configured with trustProxy=true (see main.ts).
 *  Falls back to host header if the proxy didn't tell us a scheme. */
function publicBaseUrl(req: FastifyRequest): string {
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
  app.get("/p/index.json", async (req, reply) => {
    const servers = await prisma.server.findMany({
      where: { publicPackToken: { not: null } },
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
  app.get("/p/:tokenWithExt", async (req, reply) => {
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

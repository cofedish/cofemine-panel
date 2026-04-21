import type { FastifyInstance } from "fastify";
import { request } from "undici";

/**
 * Minecraft version metadata. Proxies Mojang's public manifest with a small
 * in-memory cache so the wizard's version dropdown doesn't hammer it.
 */

const MOJANG_MANIFEST_URL =
  "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json";

interface VersionEntry {
  id: string;
  type: "release" | "snapshot" | "old_alpha" | "old_beta";
  releaseTime: string;
}

interface CachedManifest {
  latest: { release: string; snapshot: string };
  versions: VersionEntry[];
  fetchedAt: number;
}

let cache: CachedManifest | null = null;
const TTL_MS = 60 * 60 * 1000; // 1h

async function fetchManifest(): Promise<CachedManifest> {
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache;
  const res = await request(MOJANG_MANIFEST_URL, { maxRedirections: 3 });
  if (res.statusCode >= 400) {
    throw new Error(`Mojang manifest HTTP ${res.statusCode}`);
  }
  const raw = (await res.body.json()) as {
    latest: { release: string; snapshot: string };
    versions: Array<{
      id: string;
      type: string;
      releaseTime: string;
    }>;
  };
  cache = {
    latest: raw.latest,
    versions: raw.versions.map((v) => ({
      id: v.id,
      type: v.type as VersionEntry["type"],
      releaseTime: v.releaseTime,
    })),
    fetchedAt: Date.now(),
  };
  return cache;
}

export async function metaRoutes(app: FastifyInstance): Promise<void> {
  app.get("/mc-versions", async (req) => {
    const q = req.query as { include?: string };
    const include = (q.include ?? "release").split(",");
    try {
      const m = await fetchManifest();
      const versions = m.versions.filter((v) => include.includes(v.type));
      return {
        latest: m.latest,
        versions,
        total: versions.length,
      };
    } catch (err) {
      // Never explode the UI for metadata — return an honest "unavailable"
      // payload and let the frontend fall back to a small static list.
      req.log.warn({ err }, "mc-versions fetch failed");
      return {
        latest: { release: "1.21.1", snapshot: "" },
        versions: [] as VersionEntry[],
        total: 0,
        error: String((err as Error).message),
      };
    }
  });
}

import { request } from "undici";
import type {
  ContentDetails,
  ContentKind,
  ContentProvider,
  ContentSummary,
  ContentVersion,
  InstallPlan,
  SearchFilters,
} from "./content-provider.js";
import { prisma } from "../db.js";
import { decryptSecret } from "../crypto.js";

const BASE = "https://api.curseforge.com/v1";
const MC_GAME_ID = 432;

async function getApiKey(): Promise<string | null> {
  const row = await prisma.integrationSetting.findUnique({
    where: { key: "curseforge.apiKey" },
  });
  if (!row) return null;
  try {
    return decryptSecret(row.value);
  } catch {
    return null;
  }
}

async function call<T>(path: string, apiKey: string): Promise<T> {
  const res = await request(`${BASE}${path}`, {
    headers: { "x-api-key": apiKey, accept: "application/json" },
  });
  if (res.statusCode >= 400) {
    throw new Error(`CurseForge ${path} failed: ${res.statusCode}`);
  }
  return (await res.body.json()) as T;
}

export class CurseForgeProvider implements ContentProvider {
  readonly name = "curseforge" as const;

  async isEnabled(): Promise<boolean> {
    const k = await getApiKey();
    return Boolean(k);
  }

  private async requireKey(): Promise<string> {
    const k = await getApiKey();
    if (!k) {
      const err = new Error(
        "CurseForge API key not configured. Add one in Integrations, or use manual ZIP upload."
      );
      (err as any).statusCode = 409;
      throw err;
    }
    return k;
  }

  async search(filters: SearchFilters): Promise<ContentSummary[]> {
    const key = await this.requireKey();
    const params = new URLSearchParams();
    params.set("gameId", String(MC_GAME_ID));
    if (filters.query) params.set("searchFilter", filters.query);
    if (filters.gameVersion) params.set("gameVersion", filters.gameVersion);
    if (filters.projectType)
      params.set("classId", String(mapClassId(filters.projectType)));
    // Mod loader filter — narrows results to ones that *can* run on
    // this server's loader. CF accepts numeric codes only; for plugins
    // / datapacks the param is ignored on their side, so it's safe to
    // always pass when we know the loader.
    if (filters.loader) {
      const code = mapLoaderType(filters.loader);
      if (code !== null) params.set("modLoaderType", String(code));
    }
    // Sort strategy:
    //   • No query → "Popularity" so the wizard's empty-state shows
    //     the same top packs curseforge.com shows.
    //   • With query → "TotalDownloads". CF's default with a search
    //     term is fuzzy-name-relevance which is *terrible* (typing
    //     "Valk" surfaced the same trickle of obscure mods every
    //     time); ranking by total downloads with the search filter
    //     applied gives canonical "popular matches first".
    if (!filters.query) {
      params.set("sortField", "2"); // Popularity
      params.set("sortOrder", "desc");
    } else {
      params.set("sortField", "6"); // TotalDownloads
      params.set("sortOrder", "desc");
    }
    params.set("pageSize", String(filters.limit ?? 20));
    params.set("index", String(filters.offset ?? 0));
    const res = await call<{ data: any[] }>(
      `/mods/search?${params.toString()}`,
      key
    );
    return res.data.map(projectToSummary);
  }

  async getProject(id: number): Promise<ContentSummary> {
    const key = await this.requireKey();
    const res = await call<{ data: any }>(`/mods/${id}`, key);
    return projectToSummary(res.data);
  }

  /**
   * Full project + HTML description for the in-panel detail drawer.
   * CurseForge splits the long-form description into a separate
   * `/mods/:id/description` endpoint that returns sanitised HTML, so we
   * fetch both and merge.
   */
  async getDetails(id: number): Promise<ContentDetails> {
    const key = await this.requireKey();
    const [proj, desc] = await Promise.all([
      call<{ data: any }>(`/mods/${id}`, key),
      call<{ data: string }>(`/mods/${id}/description`, key).catch(
        () => ({ data: "" })
      ),
    ]);
    const p = proj.data;
    const links: ContentDetails["links"] = [];
    if (p.links?.sourceUrl) links.push({ label: "Source", url: p.links.sourceUrl });
    if (p.links?.issuesUrl) links.push({ label: "Issues", url: p.links.issuesUrl });
    if (p.links?.wikiUrl) links.push({ label: "Wiki", url: p.links.wikiUrl });
    return {
      ...projectToSummary(p),
      body: desc.data || undefined,
      bodyFormat: "html",
      gallery: (p.screenshots ?? []).map((s: any) => ({
        url: s.url,
        title: s.title,
        description: s.description,
      })),
      links,
      categories: (p.categories ?? []).map((c: any) => c.name).filter(Boolean),
      publishedAt: p.dateCreated,
      updatedAt: p.dateModified,
    };
  }

  async getVersions(
    id: number,
    filters: Pick<SearchFilters, "gameVersion" | "loader"> = {}
  ): Promise<ContentVersion[]> {
    const key = await this.requireKey();
    const params = new URLSearchParams();
    if (filters.gameVersion) params.set("gameVersion", filters.gameVersion);
    const res = await call<{ data: any[] }>(
      `/mods/${id}/files?${params.toString()}`,
      key
    );
    return res.data.map((f) => {
      const rawGameVersions: string[] = Array.isArray(f.gameVersions)
        ? f.gameVersions
        : [];
      // CurseForge mixes loader labels and MC versions in the same
      // `gameVersions` array (e.g. `["Forge", "1.20.1", "Server"]`),
      // and the order isn't stable. Splitting them up here so the
      // wizard / install layer downstream can do `gameVersions[0]`
      // and trust it's a real MC version, not "Forge". Without this
      // filter the dynmap auto-install was passing `gameVersion=Forge`
      // to Modrinth, getting no filter match, and falling back to the
      // newest dynmap build — which then refused to load on the
      // user's older modpack.
      return {
      id: String(f.id),
      versionNumber: f.displayName,
      name: f.fileName,
      gameVersions: rawGameVersions.filter(isMinecraftVersion),
      loaders: extractLoaders(rawGameVersions),
      // CurseForge returns `downloadUrl: null` (and sometimes empty
      // string) when the project author has disabled third-party
      // distribution. itzg's auto-installer can't fetch those, so
      // we flag them up the chain.
      distributionBlocked:
        !f.downloadUrl || String(f.downloadUrl).length === 0,
      files: [
        {
          url: f.downloadUrl ?? "",
          filename: f.fileName,
          primary: true,
          size: f.fileLength,
        },
      ],
      };
    });
  }

  async planInstall(
    version: ContentVersion,
    kind: ContentKind
  ): Promise<InstallPlan> {
    if (kind === "modpack") {
      const file = version.files[0];
      if (!file?.url || version.distributionBlocked) {
        // The pack author has disabled third-party distribution, so
        // CF returns no downloadUrl. itzg's installer can't fetch it
        // and the container would loop forever retrying. Refuse the
        // install up-front with an actionable error — we'd need a
        // manual-ZIP-upload flow to support these packs, and that's
        // a feature we don't have yet.
        const err = new Error(
          "This CurseForge modpack disables third-party downloads. " +
            "Pick another version that allows it, install via manual ZIP " +
            "upload, or use a Modrinth alternative."
        );
        (err as any).statusCode = 409;
        throw err;
      }
      return {
        target: "modpack-env",
        files: [],
        env: {
          // itzg image supports CF_API_KEY + CF_PAGE_URL or CF_SLUG, but the
          // cleanest path is passing a direct file URL.
          CF_SERVER_MOD: file.url,
        },
      };
    }
    const target: InstallPlan["target"] =
      kind === "plugin" ? "plugins" : "mods";
    return {
      target,
      files: version.files
        .filter((f) => f.url)
        .map((f) => ({ url: f.url, filename: f.filename })),
    };
  }
}

function projectToSummary(p: any): ContentSummary {
  return {
    id: String(p.id),
    provider: "curseforge",
    name: p.name,
    slug: p.slug,
    description: p.summary,
    author: p.authors?.[0]?.name,
    downloads: p.downloadCount,
    iconUrl: p.logo?.thumbnailUrl,
    gameVersions: p.latestFilesIndexes?.map((x: any) => x.gameVersion),
    projectType: classIdToKind(p.classId),
    pageUrl: p.links?.websiteUrl,
  };
}

function mapClassId(kind: ContentKind): number {
  switch (kind) {
    case "modpack":
      return 4471;
    case "plugin":
      return 5; // Bukkit plugins
    case "resourcepack":
      return 12;
    default:
      return 6; // mods
  }
}

/**
 * Translate our string loader keys into the numeric codes the CF search
 * API expects in `modLoaderType`. Codes per the CF schema docs:
 *   1 Forge, 2 Cauldron (deprecated), 3 LiteLoader, 4 Fabric, 5 Quilt, 6 NeoForge.
 * Returns null for "paper" / "vanilla" — CF's loader filter doesn't
 * cover those (they're pulled via classId/category instead).
 */
function mapLoaderType(loader: string): number | null {
  switch (loader.toLowerCase()) {
    case "forge":
      return 1;
    case "fabric":
      return 4;
    case "quilt":
      return 5;
    case "neoforge":
      return 6;
    default:
      return null;
  }
}

function classIdToKind(classId?: number): ContentKind | undefined {
  switch (classId) {
    case 4471:
      return "modpack";
    case 5:
      return "plugin";
    case 12:
      return "resourcepack";
    case 6:
      return "mod";
    default:
      return undefined;
  }
}

function extractLoaders(gameVersions: string[]): string[] {
  const loaders = new Set<string>();
  for (const v of gameVersions) {
    const low = v.toLowerCase();
    for (const k of ["forge", "fabric", "quilt", "neoforge", "paper", "spigot"]) {
      if (low.includes(k)) loaders.add(k);
    }
  }
  return [...loaders];
}

/**
 * True only for entries that look like an actual Minecraft release
 * version (e.g. "1.20.1", "1.21", "1.7.10"). Used to strip loader
 * labels ("Forge", "NeoForge"), client/server tags ("Client",
 * "Server"), and Java version markers ("Java 17") out of CF's mixed
 * `gameVersions` arrays before we surface them to the UI.
 */
function isMinecraftVersion(v: string): boolean {
  // Major.Minor[.Patch] starting with 1.
  return /^1\.\d+(?:\.\d+)?$/.test(v);
}

import { request } from "undici";
import type {
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
    // CurseForge returns nothing useful without either searchFilter or a
    // sort. Default to popularity so the wizard shows the same "top packs"
    // view the real curseforge.com shows on an empty search.
    if (!filters.query) {
      params.set("sortField", "2"); // Popularity
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
    return res.data.map((f) => ({
      id: String(f.id),
      versionNumber: f.displayName,
      name: f.fileName,
      gameVersions: f.gameVersions ?? [],
      loaders: extractLoaders(f.gameVersions ?? []),
      files: [
        {
          url: f.downloadUrl ?? "",
          filename: f.fileName,
          primary: true,
          size: f.fileLength,
        },
      ],
    }));
  }

  async planInstall(
    version: ContentVersion,
    kind: ContentKind
  ): Promise<InstallPlan> {
    if (kind === "modpack") {
      const file = version.files[0];
      if (!file?.url) {
        return {
          target: "modpack-env",
          files: [],
          notes: [
            "CurseForge did not return a direct download URL for this modpack. Use the manual ZIP upload flow.",
          ],
        };
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

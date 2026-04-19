import { request } from "undici";
import type {
  ContentKind,
  ContentProvider,
  ContentSummary,
  ContentVersion,
  InstallPlan,
  SearchFilters,
} from "./content-provider.js";
import { config } from "../config.js";

const BASE = "https://api.modrinth.com/v2";

async function call<T>(path: string): Promise<T> {
  const res = await request(`${BASE}${path}`, {
    headers: { "user-agent": config.MODRINTH_USER_AGENT },
  });
  if (res.statusCode >= 400) {
    throw new Error(`Modrinth ${path} failed: ${res.statusCode}`);
  }
  return (await res.body.json()) as T;
}

export class ModrinthProvider implements ContentProvider {
  readonly name = "modrinth" as const;

  async isEnabled(): Promise<boolean> {
    return true; // Modrinth API is public
  }

  async search(filters: SearchFilters): Promise<ContentSummary[]> {
    const facets: string[][] = [];
    if (filters.projectType) facets.push([`project_type:${filters.projectType}`]);
    if (filters.loader) facets.push([`categories:${filters.loader}`]);
    if (filters.gameVersion) facets.push([`versions:${filters.gameVersion}`]);
    const params = new URLSearchParams();
    if (filters.query) params.set("query", filters.query);
    if (facets.length) params.set("facets", JSON.stringify(facets));
    params.set("limit", String(filters.limit ?? 20));
    params.set("offset", String(filters.offset ?? 0));
    const res = await call<{ hits: any[] }>(`/search?${params.toString()}`);
    return res.hits.map((h) => ({
      id: h.project_id ?? h.slug,
      provider: "modrinth" as const,
      name: h.title,
      slug: h.slug,
      description: h.description,
      author: h.author,
      downloads: h.downloads,
      iconUrl: h.icon_url,
      loaders: h.categories,
      gameVersions: h.versions,
      projectType: h.project_type as ContentKind,
      pageUrl: `https://modrinth.com/${h.project_type}/${h.slug}`,
    }));
  }

  async getProject(id: string): Promise<ContentSummary> {
    const p = await call<any>(`/project/${id}`);
    return {
      id: p.id,
      provider: "modrinth",
      name: p.title,
      slug: p.slug,
      description: p.description,
      iconUrl: p.icon_url,
      loaders: p.loaders,
      gameVersions: p.game_versions,
      projectType: p.project_type,
      pageUrl: `https://modrinth.com/${p.project_type}/${p.slug}`,
    };
  }

  async getVersions(
    id: string,
    filters: Pick<SearchFilters, "gameVersion" | "loader"> = {}
  ): Promise<ContentVersion[]> {
    const params = new URLSearchParams();
    if (filters.gameVersion)
      params.set("game_versions", `["${filters.gameVersion}"]`);
    if (filters.loader) params.set("loaders", `["${filters.loader}"]`);
    const qs = params.toString();
    const versions = await call<any[]>(
      `/project/${id}/version${qs ? `?${qs}` : ""}`
    );
    return versions.map((v) => ({
      id: v.id,
      versionNumber: v.version_number,
      name: v.name,
      gameVersions: v.game_versions ?? [],
      loaders: v.loaders ?? [],
      files: (v.files ?? []).map((f: any) => ({
        url: f.url,
        filename: f.filename,
        primary: Boolean(f.primary),
        size: f.size,
      })),
      dependencies: (v.dependencies ?? []).map((d: any) => ({
        projectId: d.project_id,
        versionId: d.version_id,
        required: d.dependency_type === "required",
      })),
    }));
  }

  async planInstall(
    version: ContentVersion,
    kind: ContentKind
  ): Promise<InstallPlan> {
    if (kind === "modpack") {
      const primary = version.files.find((f) => f.primary) ?? version.files[0];
      if (!primary) {
        throw new Error("Modrinth version has no files");
      }
      return {
        target: "modpack-env",
        files: [],
        env: {
          // itzg image accepts MODRINTH_PROJECT + MODRINTH_VERSION
          MODRINTH_PROJECT: primary.url,
        },
        notes: [
          "Modpack will be downloaded and applied by the Minecraft runtime on next start.",
        ],
      };
    }
    const target: InstallPlan["target"] =
      kind === "plugin" ? "plugins" : kind === "datapack" ? "datapacks" : "mods";
    return {
      target,
      files: version.files
        .filter((f) => f.primary || version.files.length === 1)
        .map((f) => ({ url: f.url, filename: f.filename })),
    };
  }
}

import { Agent, request } from "undici";
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

// Modrinth's edge sometimes takes >10s to accept a TLS connection from
// our region; undici's default connect timeout is 10s, which is exactly
// what users were hitting. Bump it + keep connections alive so repeat
// calls don't re-handshake.
const dispatcher = new Agent({
  connect: { timeout: 30_000 },
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
});

/** GET a Modrinth endpoint with retries. Retries on network errors and
 *  5xx responses, with short exponential backoff. 4xx is returned as-is
 *  (bad request won't fix itself by retrying). */
async function call<T>(path: string): Promise<T> {
  const url = `${BASE}${path}`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await request(url, {
        dispatcher,
        headers: { "user-agent": config.MODRINTH_USER_AGENT },
        headersTimeout: 30_000,
        bodyTimeout: 60_000,
      });
      if (res.statusCode >= 500) {
        lastErr = new Error(`Modrinth ${path} failed: ${res.statusCode}`);
        // drain + retry
        await res.body.dump().catch(() => {});
      } else if (res.statusCode >= 400) {
        throw new Error(`Modrinth ${path} failed: ${res.statusCode}`);
      } else {
        return (await res.body.json()) as T;
      }
    } catch (err) {
      lastErr = err;
    }
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
    }
  }
  throw lastErr instanceof Error
    ? new Error(`Modrinth ${path}: ${lastErr.message}`)
    : new Error(`Modrinth ${path} failed`);
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

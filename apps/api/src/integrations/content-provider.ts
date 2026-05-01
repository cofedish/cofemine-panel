/**
 * Abstract content provider — Modrinth, CurseForge, or anything else we add
 * later. Providers expose search, version discovery, and a "plan" describing
 * how to install a piece of content. Actual installation is delegated to the
 * node-agent (it has the filesystem and runs inside/near the target
 * container), so providers return URLs and metadata the agent can fetch.
 */

export type ContentKind =
  | "modpack"
  | "mod"
  | "plugin"
  | "datapack"
  | "resourcepack"
  | "shader";

export interface SearchFilters {
  query?: string;
  gameVersion?: string;
  loader?: string;
  projectType?: ContentKind;
  limit?: number;
  offset?: number;
}

export interface ContentSummary {
  id: string;
  provider: "modrinth" | "curseforge";
  name: string;
  slug?: string;
  description?: string;
  author?: string;
  downloads?: number;
  iconUrl?: string;
  loaders?: string[];
  gameVersions?: string[];
  projectType?: ContentKind;
  pageUrl?: string;
}

export interface ContentGalleryItem {
  url: string;
  title?: string;
  description?: string;
  featured?: boolean;
}

export interface ContentDetails extends ContentSummary {
  /** Long-form description. Modrinth returns markdown; CurseForge returns
   *  HTML. The UI distinguishes by `bodyFormat`. */
  body?: string;
  bodyFormat?: "markdown" | "html";
  gallery?: ContentGalleryItem[];
  /** Useful external links — source, issues, wiki, discord, etc. */
  links?: Array<{ label: string; url: string }>;
  categories?: string[];
  followers?: number;
  /** ISO timestamps. */
  publishedAt?: string;
  updatedAt?: string;
  license?: string;
  clientSide?: string;
  serverSide?: string;
}

export interface ContentVersion {
  id: string;
  versionNumber?: string;
  name?: string;
  gameVersions: string[];
  loaders: string[];
  files: Array<{ url: string; filename: string; primary: boolean; size?: number }>;
  dependencies?: Array<{ projectId?: string; versionId?: string; required: boolean }>;
  projectType?: ContentKind;
}

export interface InstallPlan {
  /** What the agent should do with the files. */
  target: "mods" | "plugins" | "datapacks" | "modpack-env";
  files: Array<{ url: string; filename: string }>;
  /** For modpacks, optional env vars to set on the container (e.g. MODRINTH_PROJECT). */
  env?: Record<string, string>;
  notes?: string[];
}

export interface ContentProvider {
  readonly name: "modrinth" | "curseforge";
  /** Whether the provider is usable (e.g. CurseForge needs an API key). */
  isEnabled(): Promise<boolean>;
  search(filters: SearchFilters): Promise<ContentSummary[]>;
  getProject(id: string | number): Promise<ContentSummary>;
  getVersions(id: string | number, filters?: Pick<SearchFilters, "gameVersion" | "loader">): Promise<ContentVersion[]>;
  planInstall(
    version: ContentVersion,
    kind: ContentKind
  ): Promise<InstallPlan>;
}

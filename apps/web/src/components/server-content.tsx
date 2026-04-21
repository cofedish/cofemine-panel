"use client";
import { useEffect, useMemo, useState } from "react";
import useSWR, { mutate } from "swr";
import { api, ApiError, fetcher } from "@/lib/api";
import { cn } from "@/lib/cn";
import {
  Search,
  Download,
  Package,
  Check,
  Trash2,
  AlertTriangle,
  ExternalLink,
  RefreshCw,
} from "lucide-react";
import { ModrinthMark, CurseForgeMark } from "./brand-icons";

type Summary = {
  id: string;
  provider: "modrinth" | "curseforge";
  name: string;
  slug?: string;
  description?: string;
  author?: string;
  iconUrl?: string;
  pageUrl?: string;
  downloads?: number;
};

type Integrations = {
  providers: {
    modrinth: { enabled: boolean };
    curseforge: { enabled: boolean };
  };
};

type Kind = "mod" | "modpack" | "plugin" | "datapack";

type ServerContext = {
  type: string;
  version: string;
};

/** Map our abstract server type to a Modrinth/CurseForge loader token. */
function typeToLoader(t: string): string {
  switch (t) {
    case "PAPER":
    case "PURPUR":
    case "MOHIST":
      return "paper";
    case "FABRIC":
      return "fabric";
    case "FORGE":
      return "forge";
    case "NEOFORGE":
      return "neoforge";
    case "QUILT":
      return "quilt";
    default:
      return "";
  }
}

/**
 * Pull a sensible Modrinth search query out of a noisy mod label like
 *   "DnT Ocean Monument Overhaul"
 *   "Create: Sophisticated Backpacks Compat"
 *   "Subtle Effects (NeoForge)"
 * Drops loader hints, vendor prefixes before a colon (keeps the informative
 * side), parentheses, and common noise words.
 */
function cleanModNameForSearch(raw: string): string {
  let s = raw;
  // strip [Neo/Forge] / (Fabric) / NEOFORGE markers
  s = s.replace(/\[[^\]]*?(forge|fabric|quilt|neoforge|neo)[^\]]*?\]/gi, "");
  s = s.replace(/\([^)]*?(forge|fabric|quilt|neoforge|neo)[^)]*?\)/gi, "");
  s = s.replace(/\b(neoforge|neoforged|neo|forge|fabric|quilt)\b/gi, "");
  // "Vendor: Actual name" → keep the RHS (usually the mod)
  if (s.includes(":")) {
    const parts = s.split(":");
    if (parts.length >= 2 && parts[1]!.trim().length > 2) {
      s = parts.slice(1).join(":");
    }
  }
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

type InstalledFile = { name: string; size: number; mtime: string };
type InstalledContent = {
  mods: InstalledFile[];
  plugins: InstalledFile[];
  datapacks: InstalledFile[];
};

type Failure = {
  fileName: string;
  modName: string;
  lastRetry: number;
  modId?: number;
  fileId?: number;
  url?: string;
};

export function ServerContent({ serverId }: { serverId: string }): JSX.Element {
  const { data: server } = useSWR<ServerContext>(
    `/servers/${serverId}`,
    fetcher
  );
  const { data: installed } = useSWR<InstalledContent>(
    `/servers/${serverId}/installed-content`,
    fetcher,
    { refreshInterval: 10000 }
  );
  const { data: failures } = useSWR<{ failures: Failure[] }>(
    `/servers/${serverId}/install-failures`,
    fetcher,
    { refreshInterval: 20000, shouldRetryOnError: false }
  );
  const [initialQuery, setInitialQuery] = useState<string | null>(null);
  const [jumpToSearch, setJumpToSearch] = useState(0);

  function findOnModrinth(query: string): void {
    setInitialQuery(cleanModNameForSearch(query));
    setJumpToSearch((n) => n + 1);
    setTimeout(() => {
      document
        .getElementById("content-search")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 40);
  }

  return (
    <div className="space-y-6">
      <InstalledPanel installed={installed} serverId={serverId} />

      {failures?.failures && failures.failures.length > 0 && (
        <FailuresPanel
          failures={failures.failures}
          onFindOnModrinth={findOnModrinth}
        />
      )}

      <BrowsePanel
        serverId={serverId}
        installed={installed}
        server={server}
        initialQuery={initialQuery}
        jumpVersion={jumpToSearch}
      />
    </div>
  );
}

/* =============================== INSTALLED =============================== */

function InstalledPanel({
  installed,
  serverId,
}: {
  installed: InstalledContent | undefined;
  serverId: string;
}): JSX.Element {
  const [tab, setTab] = useState<"mods" | "plugins" | "datapacks">("mods");
  const groups: Record<"mods" | "plugins" | "datapacks", InstalledFile[]> = {
    mods: installed?.mods ?? [],
    plugins: installed?.plugins ?? [],
    datapacks: installed?.datapacks ?? [],
  };
  const visible = groups[tab];

  async function remove(file: InstalledFile): Promise<void> {
    if (!confirm(`Delete ${file.name}?`)) return;
    try {
      await api.del(
        `/servers/${serverId}/installed-content?type=${tab}&name=${encodeURIComponent(file.name)}`
      );
      mutate(`/servers/${serverId}/installed-content`);
    } catch (e) {
      alert(e instanceof ApiError ? e.message : String(e));
    }
  }

  return (
    <section className="tile p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="heading-md">Installed on this server</h3>
        <button
          className="btn btn-ghost !py-1 !px-2"
          onClick={() => mutate(`/servers/${serverId}/installed-content`)}
          aria-label="Refresh"
          title="Refresh"
        >
          <RefreshCw size={14} />
        </button>
      </div>

      <div className="flex gap-1 border-b border-line">
        {(["mods", "plugins", "datapacks"] as const).map((t) => {
          const count = groups[t].length;
          const active = t === tab;
          return (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                "relative px-3 py-2 text-sm capitalize transition-colors",
                active ? "text-ink font-medium" : "text-ink-secondary hover:text-ink"
              )}
            >
              {t}
              <span className="ml-1.5 text-[10px] text-ink-muted">
                {count}
              </span>
              {active && (
                <span className="absolute -bottom-px left-2 right-2 h-0.5 bg-[rgb(var(--accent))] rounded-full" />
              )}
            </button>
          );
        })}
      </div>

      {visible.length === 0 ? (
        <div className="text-sm text-ink-muted py-6 text-center">
          {installed === undefined
            ? "Loading…"
            : `No ${tab} installed yet.`}
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {visible.map((f) => (
            <li
              key={f.name}
              className="py-2.5 flex items-center gap-3 text-sm"
            >
              <Package size={14} className="text-ink-muted shrink-0" />
              <span className="flex-1 truncate font-mono text-xs">
                {f.name}
              </span>
              <span className="text-xs text-ink-muted tabular-nums w-16 text-right">
                {formatSize(f.size)}
              </span>
              <button
                className="btn-icon btn-ghost !h-7 !w-7"
                onClick={() => remove(f)}
                aria-label="Delete"
              >
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* =============================== FAILURES =============================== */

function FailuresPanel({
  failures,
  onFindOnModrinth,
}: {
  failures: Failure[];
  onFindOnModrinth: (query: string) => void;
}): JSX.Element {
  return (
    <section className="tile p-5 space-y-4 border-[rgb(var(--warning))]/30">
      <div className="flex items-start gap-3">
        <span className="w-8 h-8 rounded-md bg-[rgb(var(--warning-soft))] text-[rgb(var(--warning))] grid place-items-center shrink-0">
          <AlertTriangle size={16} />
        </span>
        <div>
          <h3 className="heading-md">Failed CurseForge downloads</h3>
          <p className="text-sm text-ink-muted mt-1">
            {failures.length} mod{failures.length === 1 ? "" : "s"} the pack
            couldn't fetch automatically — the mod authors disabled third-
            party downloads. Try <b>Find on Modrinth</b> for a drop-in
            replacement, or open the CurseForge page to download manually
            and upload the JAR to <code>mods/</code> via the Files tab.
          </p>
        </div>
      </div>
      <ul className="divide-y divide-line">
        {failures.map((f) => (
          <li
            key={`${f.modName}|${f.fileName}`}
            className="py-3 flex items-center gap-3 text-sm flex-wrap"
          >
            <Package size={14} className="text-ink-muted shrink-0" />
            <div className="flex-1 min-w-[240px]">
              <div className="font-medium">{f.modName}</div>
              <div className="text-xs text-ink-muted font-mono truncate">
                {f.fileName}
              </div>
            </div>
            <button
              className="btn btn-subtle !py-1.5 !px-3 text-xs"
              onClick={() => onFindOnModrinth(f.modName)}
            >
              <ModrinthMark size={12} /> Find on Modrinth
            </button>
            {f.modId && (
              <a
                className="btn btn-ghost !py-1.5 !px-3 text-xs"
                href={`https://www.curseforge.com/minecraft/mc-mods/?search=${encodeURIComponent(
                  f.modName
                )}`}
                target="_blank"
                rel="noreferrer"
              >
                <CurseForgeMark size={12} /> CurseForge{" "}
                <ExternalLink size={10} />
              </a>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ================================ BROWSE ================================ */

function BrowsePanel({
  serverId,
  installed,
  server,
  initialQuery,
  jumpVersion,
}: {
  serverId: string;
  installed: InstalledContent | undefined;
  server: ServerContext | undefined;
  initialQuery: string | null;
  jumpVersion: number;
}): JSX.Element {
  const { data: integ } = useSWR<Integrations>("/integrations", fetcher);
  const [provider, setProvider] = useState<"modrinth" | "curseforge">(
    "modrinth"
  );
  const [query, setQuery] = useState("");
  // Default MC version + loader to the server's context so users don't
  // have to retype "1.21.1 / neoforge" on every search. Empty string
  // still means "any" — the inputs stay user-editable.
  const [gameVersion, setGameVersion] = useState("");
  const [loader, setLoader] = useState("");
  const [versionPinned, setVersionPinned] = useState(false);
  useEffect(() => {
    if (server && !versionPinned) {
      if (server.version && server.version !== "LATEST") {
        setGameVersion(server.version);
      }
      const l = typeToLoader(server.type);
      if (l) setLoader(l);
      setVersionPinned(true);
    }
  }, [server, versionPinned]);
  const [kind, setKind] = useState<Kind>("mod");
  const [results, setResults] = useState<Summary[]>([]);
  const [busy, setBusy] = useState(false);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const cfDisabled = integ ? !integ.providers.curseforge.enabled : true;

  // Accept pushes from FailuresPanel: seed query + force Modrinth provider.
  useEffect(() => {
    if (initialQuery == null) return;
    setProvider("modrinth");
    setQuery(initialQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpVersion]);

  // Installed-slugs we compare against to stamp "Installed" on search cards.
  const installedSlugs = useMemo(() => {
    const list = [
      ...(installed?.mods ?? []),
      ...(installed?.plugins ?? []),
      ...(installed?.datapacks ?? []),
    ];
    return list.map((f) => slugFromFilename(f.name));
  }, [installed]);

  useEffect(() => {
    if (provider === "curseforge" && cfDisabled) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(
      async () => {
        setBusy(true);
        setErr(null);
        try {
          const qp = new URLSearchParams();
          if (query) qp.set("query", query);
          if (gameVersion) qp.set("gameVersion", gameVersion);
          if (loader) qp.set("loader", loader);
          qp.set("projectType", kind);
          qp.set("limit", "24");
          const res = await api.get<any>(
            `/integrations/${provider}/search?${qp.toString()}`
          );
          if (cancelled) return;
          const raw: any[] = Array.isArray(res) ? res : (res.results ?? []);
          setResults(raw);
        } catch (e) {
          if (!cancelled) {
            setErr(e instanceof ApiError ? e.message : String(e));
          }
        } finally {
          if (!cancelled) setBusy(false);
        }
      },
      query || gameVersion || loader ? 300 : 0
    );
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [provider, query, gameVersion, loader, kind, cfDisabled]);

  async function install(r: Summary): Promise<void> {
    setInstallingId(r.id);
    setMsg(null);
    setErr(null);
    try {
      const endpoint = `/integrations/servers/${serverId}/install/${provider}`;
      const body =
        provider === "modrinth"
          ? { projectId: r.id, kind }
          : { projectId: Number(r.id), kind };
      await api.post(endpoint, body);
      setMsg(
        kind === "modpack"
          ? `${r.name} installed. Restart the server to apply.`
          : `${r.name} installed. Restart the server to load it.`
      );
      mutate(`/servers/${serverId}/installed-content`);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setInstallingId(null);
    }
  }

  return (
    <section id="content-search" className="space-y-4 scroll-mt-24">
      <h3 className="heading-md">Browse & install</h3>
      <div className="flex gap-2">
        <ProviderPill
          name="Modrinth"
          icon={<ModrinthMark size={14} />}
          active={provider === "modrinth"}
          onClick={() => setProvider("modrinth")}
          disabled={!integ?.providers.modrinth.enabled}
        />
        <ProviderPill
          name="CurseForge"
          icon={<CurseForgeMark size={14} />}
          active={provider === "curseforge"}
          onClick={() => setProvider("curseforge")}
          disabled={cfDisabled}
          hint={cfDisabled ? "API key required — Integrations page" : undefined}
        />
      </div>

      <div className="tile p-4 grid grid-cols-1 md:grid-cols-[1fr_160px_160px_140px] gap-3">
        <div className="relative">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted"
          />
          <input
            className="input pl-8"
            placeholder={`Search ${provider} ${kind}s…`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <input
          className="input"
          placeholder="MC version (e.g. 1.21.1)"
          value={gameVersion}
          onChange={(e) => setGameVersion(e.target.value)}
        />
        <select
          className="select"
          value={loader}
          onChange={(e) => setLoader(e.target.value)}
        >
          <option value="">any loader</option>
          <option value="fabric">fabric</option>
          <option value="forge">forge</option>
          <option value="neoforge">neoforge</option>
          <option value="paper">paper</option>
          <option value="quilt">quilt</option>
        </select>
        <select
          className="select"
          value={kind}
          onChange={(e) => setKind(e.target.value as Kind)}
        >
          <option value="mod">mod</option>
          <option value="modpack">modpack</option>
          <option value="plugin">plugin</option>
          <option value="datapack">datapack</option>
        </select>
      </div>

      <div className="flex items-center justify-between min-h-[20px] text-sm">
        <span className="text-ink-muted">
          {busy
            ? "Searching…"
            : `${results.length} result${results.length === 1 ? "" : "s"}`}
        </span>
        {msg && <span className="text-[rgb(var(--success))]">{msg}</span>}
        {err && <span className="text-[rgb(var(--danger))]">{err}</span>}
      </div>

      {cfDisabled && provider === "curseforge" ? (
        <div className="tile p-8 text-center">
          <p className="text-sm text-ink-secondary max-w-md mx-auto">
            CurseForge requires an API key. Go to <b>Integrations</b> and paste
            one in. Without a key, CurseForge mods can still be installed
            manually by uploading the JAR to the <code>mods/</code> folder in
            the File manager.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {results.map((r) => {
            const isInstalled = resultIsInstalled(r, installedSlugs);
            return (
              <ResultCard
                key={`${r.provider}:${r.id}`}
                r={r}
                installed={isInstalled}
                installing={installingId === r.id}
                onInstall={() => install(r)}
              />
            );
          })}
          {!busy && results.length === 0 && (
            <div className="md:col-span-2 tile p-8 text-center text-ink-muted text-sm">
              {query
                ? "Nothing matches. Try a different query."
                : "No results available."}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function ResultCard({
  r,
  installed,
  installing,
  onInstall,
}: {
  r: Summary;
  installed: boolean;
  installing: boolean;
  onInstall: () => void;
}): JSX.Element {
  return (
    <div className="tile p-4 flex gap-3">
      {r.iconUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={r.iconUrl}
          alt=""
          className="w-12 h-12 rounded-md object-cover flex-shrink-0"
        />
      ) : (
        <span className="w-12 h-12 rounded-md bg-surface-2 text-ink-secondary grid place-items-center flex-shrink-0">
          <Package size={20} />
        </span>
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <div className="font-medium truncate">{r.name}</div>
          {installed && (
            <span className="chip chip-success">
              <Check size={10} /> Installed
            </span>
          )}
        </div>
        <p className="text-xs text-ink-secondary mt-0.5 line-clamp-2">
          {r.description}
        </p>
        <div className="text-xs text-ink-muted mt-1.5 flex items-center gap-3">
          {r.author && <span>by {r.author}</span>}
          {r.downloads != null && (
            <span className="inline-flex items-center gap-1">
              <Download size={10} />
              {r.downloads.toLocaleString()}
            </span>
          )}
        </div>
      </div>
      <button
        className={cn(
          "btn self-start",
          installed ? "btn-ghost" : "btn-subtle"
        )}
        onClick={onInstall}
        disabled={installing || installed}
        title={installed ? "Already installed" : undefined}
      >
        {installed ? (
          <>
            <Check size={14} /> Installed
          </>
        ) : installing ? (
          "Installing…"
        ) : (
          "Install"
        )}
      </button>
    </div>
  );
}

function ProviderPill({
  name,
  icon,
  active,
  onClick,
  disabled,
  hint,
}: {
  name: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  hint?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={hint}
      className={cn(
        "inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm border transition-colors",
        active
          ? "bg-[rgb(var(--accent-soft))] border-[rgb(var(--accent))]/40 text-[rgb(var(--accent))]"
          : "bg-surface-1 border-line text-ink-secondary hover:bg-surface-2",
        disabled && "opacity-40 cursor-not-allowed"
      )}
    >
      {icon}
      <span>{name}</span>
      {active && <Check size={12} />}
    </button>
  );
}

/* =============================== HELPERS =============================== */

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Strip version suffix + extension + loader markers from a jar filename to
 * get a rough slug we can match against project slugs returned by search.
 *   "jei-1.21.1-neoforge-19.27.0.340.jar" -> "jei"
 *   "sodium-fabric-0.5.11+mc1.21.1.jar"   -> "sodium"
 */
function slugFromFilename(name: string): string {
  let s = name.toLowerCase();
  s = s.replace(/\.(jar|zip)$/, "");
  s = s.replace(/[_\s]+/g, "-");
  // cut at the first run-of-digits — that's usually the version marker
  const m = s.match(/^([a-z][a-z-]*?)(?=-\d|-v\d|-mc\d|-neo|-forge|-fabric|-quilt|$)/);
  return m?.[1] ?? s;
}

function resultIsInstalled(r: Summary, installedSlugs: string[]): boolean {
  const cand = [r.slug?.toLowerCase(), r.name.toLowerCase().replace(/\s+/g, "-")]
    .filter(Boolean) as string[];
  if (cand.length === 0) return false;
  for (const c of cand) {
    for (const s of installedSlugs) {
      if (!c || !s) continue;
      if (c === s || c.includes(s) || s.includes(c)) return true;
    }
  }
  return false;
}

"use client";
import { useEffect, useMemo, useState } from "react";
import useSWR, { mutate } from "swr";
import { motion } from "framer-motion";
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

/* ================================ TYPES ================================ */

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
  env: Record<string, string>;
};

type ModrinthMeta = {
  slug: string;
  title: string;
  description?: string;
  icon?: string | null;
  versionNumber?: string;
  pageUrl: string;
};

/** One jar in /data/mods (or plugins/datapacks), optionally enriched via
 *  Modrinth's SHA1 hash lookup. `modrinth` is undefined when hash isn't
 *  known to Modrinth (CF-only mod, in-pack jar, etc.). */
type InstalledFile = {
  name: string;
  size: number;
  mtime: string;
  modrinth?: ModrinthMeta;
};

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

type InnerTab = "installed" | "browse";

/* ============================= ROOT COMPONENT ============================ */

export function ServerContent({ serverId }: { serverId: string }): JSX.Element {
  const { data: server } = useSWR<ServerContext>(
    `/servers/${serverId}`,
    fetcher
  );
  const { data: installed } = useSWR<InstalledContent>(
    `/servers/${serverId}/installed-content`,
    fetcher,
    { refreshInterval: 15000 }
  );
  const { data: failures } = useSWR<{ failures: Failure[] }>(
    `/servers/${serverId}/install-failures`,
    fetcher,
    { refreshInterval: 20000, shouldRetryOnError: false }
  );

  const [tab, setTab] = useState<InnerTab>("installed");
  const [initialQuery, setInitialQuery] = useState<string | null>(null);
  const [jumpVersion, setJumpVersion] = useState(0);

  const totalInstalled =
    (installed?.mods?.length ?? 0) +
    (installed?.plugins?.length ?? 0) +
    (installed?.datapacks?.length ?? 0);

  function findOnModrinth(query: string): void {
    setInitialQuery(cleanModNameForSearch(query));
    setJumpVersion((n) => n + 1);
    setTab("browse");
    setTimeout(() => {
      document
        .getElementById("content-search")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 60);
  }

  return (
    <div className="space-y-6">
      {failures?.failures && failures.failures.length > 0 && (
        <FailuresPanel
          serverId={serverId}
          server={server}
          failures={failures.failures}
          onFindOnModrinth={findOnModrinth}
        />
      )}

      {/* Sliding-underline tab switcher */}
      <div className="flex gap-1 border-b border-line">
        <TabButton
          active={tab === "installed"}
          onClick={() => setTab("installed")}
          label="Installed"
          count={totalInstalled}
        />
        <TabButton
          active={tab === "browse"}
          onClick={() => setTab("browse")}
          label="Browse & install"
        />
      </div>

      {tab === "installed" ? (
        <InstalledPanel installed={installed} serverId={serverId} />
      ) : (
        <BrowsePanel
          serverId={serverId}
          installed={installed}
          server={server}
          initialQuery={initialQuery}
          jumpVersion={jumpVersion}
        />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative px-4 py-2.5 text-sm transition-colors inline-flex items-center gap-2",
        active ? "text-ink font-medium" : "text-ink-secondary hover:text-ink"
      )}
    >
      {label}
      {typeof count === "number" && (
        <span className="text-[10px] text-ink-muted tabular-nums">
          {count}
        </span>
      )}
      {active && (
        <motion.span
          layoutId="content-tab"
          className="absolute -bottom-px left-2 right-2 h-0.5 bg-[rgb(var(--accent))] rounded-full"
          transition={{ type: "spring", duration: 0.3 }}
        />
      )}
    </button>
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
  const [sub, setSub] = useState<"mods" | "plugins" | "datapacks">("mods");
  const groups: Record<"mods" | "plugins" | "datapacks", InstalledFile[]> = {
    mods: installed?.mods ?? [],
    plugins: installed?.plugins ?? [],
    datapacks: installed?.datapacks ?? [],
  };
  const visible = groups[sub];
  const [query, setQuery] = useState("");

  async function remove(file: InstalledFile): Promise<void> {
    if (!confirm(`Delete ${file.name}?`)) return;
    try {
      await api.del(
        `/servers/${serverId}/installed-content?type=${sub}&name=${encodeURIComponent(file.name)}`
      );
      mutate(`/servers/${serverId}/installed-content`);
    } catch (e) {
      alert(e instanceof ApiError ? e.message : String(e));
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return visible;
    return visible.filter(
      (f) =>
        f.name.toLowerCase().includes(q) ||
        f.modrinth?.title?.toLowerCase().includes(q) ||
        f.modrinth?.slug?.toLowerCase().includes(q)
    );
  }, [visible, query]);

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex gap-1">
          {(["mods", "plugins", "datapacks"] as const).map((t) => {
            const count = groups[t].length;
            const active = t === sub;
            return (
              <button
                key={t}
                onClick={() => setSub(t)}
                className={cn(
                  "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm border transition-colors capitalize",
                  active
                    ? "bg-[rgb(var(--accent-soft))] border-[rgb(var(--accent))]/40 text-[rgb(var(--accent))]"
                    : "border-line text-ink-secondary hover:bg-surface-2"
                )}
              >
                {t}
                <span className="text-[10px] opacity-70 tabular-nums">
                  {count}
                </span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search
              size={13}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-muted"
            />
            <input
              className="input !py-1.5 pl-7 text-xs w-44"
              placeholder="Filter…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <button
            className="btn btn-ghost !py-1.5 !px-2"
            onClick={() => mutate(`/servers/${serverId}/installed-content`)}
            aria-label="Refresh"
            title="Refresh"
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="tile p-10 text-center text-ink-muted">
          {installed === undefined
            ? "Loading…"
            : query
              ? `No ${sub} match "${query}".`
              : `No ${sub} installed yet.`}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {filtered.map((f) => (
            <InstalledCard
              key={f.name}
              file={f}
              onDelete={() => remove(f)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function InstalledCard({
  file,
  onDelete,
}: {
  file: InstalledFile;
  onDelete: () => void;
}): JSX.Element {
  const title = file.modrinth?.title ?? prettifyFilename(file.name);
  const subtitle = file.modrinth?.description;
  return (
    <div className="tile p-3.5 flex gap-3 items-start">
      {file.modrinth?.icon ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={file.modrinth.icon}
          alt=""
          className="w-12 h-12 rounded-md object-cover flex-shrink-0 bg-surface-2"
          draggable={false}
        />
      ) : (
        <span className="w-12 h-12 rounded-md bg-surface-2 text-ink-secondary grid place-items-center flex-shrink-0">
          <Package size={20} />
        </span>
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <div className="font-medium truncate">{title}</div>
          {file.modrinth && (
            <span className="chip chip-accent">
              <ModrinthMark size={10} /> Modrinth
            </span>
          )}
        </div>
        {subtitle ? (
          <p className="text-xs text-ink-secondary mt-0.5 line-clamp-2">
            {subtitle}
          </p>
        ) : (
          <p className="text-xs text-ink-muted mt-0.5 font-mono truncate">
            {file.name}
          </p>
        )}
        <div className="text-[11px] text-ink-muted mt-1.5 flex items-center gap-3">
          {file.modrinth?.versionNumber && (
            <span className="font-mono">{file.modrinth.versionNumber}</span>
          )}
          <span className="tabular-nums">{formatSize(file.size)}</span>
          {file.modrinth?.pageUrl && (
            <a
              className="link inline-flex items-center gap-1"
              href={file.modrinth.pageUrl}
              target="_blank"
              rel="noreferrer"
            >
              page <ExternalLink size={10} />
            </a>
          )}
        </div>
      </div>
      <button
        className="btn-icon btn-ghost !h-8 !w-8 shrink-0"
        onClick={onDelete}
        aria-label="Delete"
        title="Delete"
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}

/* =============================== FAILURES =============================== */

function FailuresPanel({
  serverId,
  server,
  failures,
  onFindOnModrinth,
}: {
  serverId: string;
  server: ServerContext | undefined;
  failures: Failure[];
  onFindOnModrinth: (query: string) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [autoBusy, setAutoBusy] = useState(false);
  const [autoStatus, setAutoStatus] = useState<string | null>(null);
  const idsToSkip = failures
    .map((f) => f.modId)
    .filter((x): x is number => typeof x === "number");

  /**
   * For each failure, search Modrinth using a cleaned-up mod name plus
   * the server's loader + version as filters, then install the top hit.
   * Mods that resolve get their CF id appended to CF_EXCLUDE_MODS so the
   * pack stops retrying them. Ends with a summary + repair so the next
   * Start picks up the new env.
   */
  async function tryModrinthForAll(): Promise<void> {
    if (!server) return;
    if (
      !confirm(
        `Search Modrinth for ${failures.length} failing mod${
          failures.length === 1 ? "" : "s"
        } and auto-install the best match for each?\n\nFailed mods that resolve will be added to CF_EXCLUDE_MODS so the pack stops retrying them. The world and /data are preserved.`
      )
    ) {
      return;
    }
    setAutoBusy(true);
    setAutoStatus(null);
    const loader = typeToLoader(server.type);
    const gameVersion =
      server.version && server.version !== "LATEST" ? server.version : "";

    const results = await Promise.all(
      failures.map(async (f) => {
        try {
          const qp = new URLSearchParams();
          qp.set("query", cleanModNameForSearch(f.modName));
          if (gameVersion) qp.set("gameVersion", gameVersion);
          if (loader) qp.set("loader", loader);
          qp.set("projectType", "mod");
          qp.set("limit", "1");
          const res = await api.get<any>(
            `/integrations/modrinth/search?${qp.toString()}`
          );
          const raw: any[] = Array.isArray(res) ? res : (res.results ?? []);
          const top = raw[0];
          if (!top) return { failure: f, status: "no-match" as const };
          await api.post(`/integrations/servers/${serverId}/install/modrinth`, {
            projectId: top.id,
            kind: "mod",
          });
          return {
            failure: f,
            status: "installed" as const,
            projectName: top.name as string,
          };
        } catch (e) {
          return {
            failure: f,
            status: "error" as const,
            message: e instanceof ApiError ? e.message : String(e),
          };
        }
      })
    );

    const installed = results.filter((r) => r.status === "installed");
    const noMatch = results.filter((r) => r.status === "no-match");
    const errored = results.filter((r) => r.status === "error");

    // Skip every failure that we successfully replaced — no point letting
    // itzg keep retrying the broken CF download.
    const idsToExclude = installed
      .map((r) => r.failure.modId)
      .filter((x): x is number => typeof x === "number");
    try {
      if (idsToExclude.length > 0) {
        const existing = (server.env.CF_EXCLUDE_MODS ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const merged = Array.from(
          new Set([...existing, ...idsToExclude.map(String)])
        ).join(",");
        await api.patch(`/servers/${serverId}`, {
          env: { ...server.env, CF_EXCLUDE_MODS: merged },
        });
        await api.post(`/servers/${serverId}/repair`);
      }
      mutate(`/servers/${serverId}`);
      mutate(`/servers/${serverId}/installed-content`);
      mutate(`/servers/${serverId}/install-failures`);
    } catch (e) {
      setAutoBusy(false);
      setAutoStatus(
        `Install succeeded but repair failed: ${
          e instanceof ApiError ? e.message : String(e)
        }`
      );
      return;
    }

    setAutoBusy(false);
    const lines = [
      `Installed: ${installed.length}`,
      `No match on Modrinth: ${noMatch.length}`,
      `Errors: ${errored.length}`,
    ];
    if (noMatch.length > 0) {
      lines.push(
        "",
        "No Modrinth match for:",
        ...noMatch.slice(0, 10).map((r) => `  • ${r.failure.modName}`)
      );
      if (noMatch.length > 10) lines.push(`  … +${noMatch.length - 10} more`);
    }
    if (errored.length > 0) {
      lines.push(
        "",
        "Errors:",
        ...errored
          .slice(0, 5)
          .map((r) => `  • ${r.failure.modName}: ${r.message}`)
      );
    }
    setAutoStatus(
      installed.length > 0
        ? `${installed.length} mod${
            installed.length === 1 ? "" : "s"
          } installed from Modrinth. Start the server to retry.`
        : "No Modrinth replacements installed."
    );
    alert(lines.join("\n"));
  }

  async function skipAndRetry(): Promise<void> {
    if (!server) return;
    if (idsToSkip.length === 0) {
      alert(
        "No CurseForge mod IDs could be parsed from the logs. Use 'Find on Modrinth' per mod instead."
      );
      return;
    }
    if (
      !confirm(
        `Add ${idsToSkip.length} mod ID${idsToSkip.length === 1 ? "" : "s"} to CF_EXCLUDE_MODS and rebuild the container?\n\nThe pack will install without the failing mods. The world and /data are preserved.`
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const existing = (server.env.CF_EXCLUDE_MODS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const merged = Array.from(
        new Set([...existing, ...idsToSkip.map(String)])
      ).join(",");
      await api.patch(`/servers/${serverId}`, {
        env: { ...server.env, CF_EXCLUDE_MODS: merged },
      });
      await api.post(`/servers/${serverId}/repair`);
      alert(
        `Done. ${idsToSkip.length} mod${idsToSkip.length === 1 ? "" : "s"} will be skipped on next start. Press Start to retry the install.`
      );
      mutate(`/servers/${serverId}`);
      mutate(`/servers/${serverId}/install-failures`);
    } catch (e) {
      alert(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="tile p-5 space-y-4 border-[rgb(var(--warning))]/30">
      <div className="flex items-start gap-3 flex-wrap">
        <span className="w-8 h-8 rounded-md bg-[rgb(var(--warning-soft))] text-[rgb(var(--warning))] grid place-items-center shrink-0">
          <AlertTriangle size={16} />
        </span>
        <div className="flex-1 min-w-[280px]">
          <h3 className="heading-md">Failed CurseForge downloads</h3>
          <p className="text-sm text-ink-muted mt-1">
            {failures.length} mod{failures.length === 1 ? "" : "s"} the pack
            couldn't fetch automatically — the mod authors disabled third-party
            downloads. <b>Skip failures & retry</b> adds them to{" "}
            <code className="kbd">CF_EXCLUDE_MODS</code> so itzg installs the
            rest. After that, use <b>Find on Modrinth</b> per mod to drop in
            open-source replacements.
          </p>
        </div>
        <div className="flex gap-2 shrink-0 flex-wrap">
          <button
            className="btn-subtle shrink-0"
            onClick={tryModrinthForAll}
            disabled={autoBusy || busy || !server}
            title="Search Modrinth for each failed mod and install the best match"
          >
            <ModrinthMark size={12} />{" "}
            {autoBusy ? "Searching Modrinth…" : "Try Modrinth for all"}
          </button>
          {idsToSkip.length > 0 && (
            <button
              className="btn-primary shrink-0"
              onClick={skipAndRetry}
              disabled={busy || autoBusy || !server}
              title="Add these mod IDs to CF_EXCLUDE_MODS and rebuild the container"
            >
              {busy ? "Applying…" : "Skip failures & retry"}
            </button>
          )}
        </div>
      </div>
      {autoStatus && (
        <p className="text-sm text-ink-secondary">{autoStatus}</p>
      )}
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
              className="btn-subtle !py-1.5 !px-3 text-xs"
              onClick={() => onFindOnModrinth(f.modName)}
            >
              <ModrinthMark size={12} /> Find on Modrinth
            </button>
            {f.modId && (
              <a
                className="btn-ghost !py-1.5 !px-3 text-xs"
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
  // Project keys installed during this session. Filename→slug matching
  // misses for CurseForge jars whose filename doesn't start with the CF
  // slug (e.g. "JustEnoughItems-…" for slug "jei"), so we augment the
  // installed-on-disk view with a local record keyed by the search
  // result's own slug/name/id. Survives until the next page load.
  const [recentSlugs, setRecentSlugs] = useState<Set<string>>(
    () => new Set()
  );

  const cfDisabled = integ ? !integ.providers.curseforge.enabled : true;

  // Accept pushes from FailuresPanel: seed query + force Modrinth provider.
  useEffect(() => {
    if (initialQuery == null) return;
    setProvider("modrinth");
    setQuery(initialQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpVersion]);

  // Build a strict, normalised set of installed keys. We match search
  // results against this with exact equality only — the previous
  // substring fallback produced false positives like "create" marking
  // every Create-family mod as installed.
  const installedKeys = useMemo(() => {
    const set = new Set<string>();
    const files = [
      ...(installed?.mods ?? []),
      ...(installed?.plugins ?? []),
      ...(installed?.datapacks ?? []),
    ];
    for (const f of files) {
      if (f.modrinth?.slug) set.add(normKey(f.modrinth.slug));
      set.add(normKey(slugFromFilename(f.name)));
    }
    return set;
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
      setRecentSlugs((prev) => {
        const next = new Set(prev);
        if (r.slug) next.add(normKey(r.slug));
        if (r.name) next.add(normKey(r.name));
        next.add(normKey(String(r.id)));
        return next;
      });
      mutate(`/servers/${serverId}/installed-content`);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setInstallingId(null);
    }
  }

  return (
    <section id="content-search" className="space-y-4 scroll-mt-24">
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
            const isInstalled =
              resultIsInstalled(r, installedKeys) ||
              (!!r.slug && recentSlugs.has(normKey(r.slug))) ||
              (!!r.name && recentSlugs.has(normKey(r.name))) ||
              recentSlugs.has(normKey(String(r.id)));
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
        className={cn("btn self-start", installed ? "btn-ghost" : "btn-subtle")}
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

function cleanModNameForSearch(raw: string): string {
  let s = raw;
  s = s.replace(/\[[^\]]*?(forge|fabric|quilt|neoforge|neo)[^\]]*?\]/gi, "");
  s = s.replace(/\([^)]*?(forge|fabric|quilt|neoforge|neo)[^)]*?\)/gi, "");
  s = s.replace(/\b(neoforge|neoforged|neo|forge|fabric|quilt)\b/gi, "");
  if (s.includes(":")) {
    const parts = s.split(":");
    if (parts.length >= 2 && parts[1]!.trim().length > 2) {
      s = parts.slice(1).join(":");
    }
  }
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function slugFromFilename(name: string): string {
  let s = name.toLowerCase();
  s = s.replace(/\.(jar|zip)$/, "");
  s = s.replace(/[_\s]+/g, "-");
  const m = s.match(
    /^([a-z][a-z-]*?)(?=-\d|-v\d|-mc\d|-neo|-forge|-fabric|-quilt|$)/
  );
  return m?.[1] ?? s;
}

function normKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * True when a search result matches a file already in installedKeys.
 * Strict: exact equality on the normalised key (alphanumerics only).
 * No substring match — "create" should NOT mark "Create: Backpack Pixel"
 * as installed.
 */
function resultIsInstalled(r: Summary, installedKeys: Set<string>): boolean {
  const cands = new Set<string>();
  if (r.slug) cands.add(normKey(r.slug));
  if (r.name) cands.add(normKey(r.name));
  const parts = r.name?.split(":") ?? [];
  if (parts.length > 1) cands.add(normKey(parts.slice(1).join(":")));
  for (const c of cands) {
    if (c && installedKeys.has(c)) return true;
  }
  return false;
}

/** Turn "SubtleEffects-neoforge-1.21.1-1.13.2-hotfix.1.jar" into
 *  "SubtleEffects" when we don't have a Modrinth match to lean on. */
function prettifyFilename(name: string): string {
  let s = name.replace(/\.(jar|zip)$/i, "");
  s = s.replace(/[_]/g, " ");
  const cut = s.search(/-\d|-v\d|-mc\d|-neo|-forge|-fabric|-quilt/i);
  if (cut > 0) s = s.slice(0, cut);
  return s.replace(/-/g, " ").trim() || name;
}

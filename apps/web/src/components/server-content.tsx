"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
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
  Ban,
} from "lucide-react";
import { ModrinthMark, CurseForgeMark } from "./brand-icons";
import { useDialog } from "./dialog-provider";
import { ContentDetailDrawer } from "./content-detail-drawer";
import { useT } from "@/lib/i18n";

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

type CurseForgeMeta = {
  modId: number;
  slug?: string;
  title: string;
  summary?: string;
  icon?: string | null;
  pageUrl?: string;
};

/** One jar in /data/mods (or plugins/datapacks), optionally enriched via
 *  Modrinth's SHA1/slug lookup or CurseForge's Murmur2 fingerprint. */
type InstalledFile = {
  name: string;
  size: number;
  mtime: string;
  modrinth?: ModrinthMeta;
  curseforge?: CurseForgeMeta;
};

type InstalledContent = {
  mods: InstalledFile[];
  plugins: InstalledFile[];
  datapacks: InstalledFile[];
  /** Best-effort loader/MC version derived from installed jar filenames.
   *  Both fields can be null if the agent couldn't tell. Used for modpack
   *  source servers where `server.type` is just "CURSEFORGE" and the
   *  actual loader was decided by the pack itself at install time. */
  runtime?: { loader: string | null; mcVersion: string | null };
};

type Failure = {
  fileName: string;
  modName: string;
  lastRetry: number;
  modId?: number;
  fileId?: number;
  url?: string;
};

type InstallInterrupt = {
  kind: "timeout" | "exhausted" | "generic";
  message: string;
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
  const { data: failures } = useSWR<{
    failures: Failure[];
    interrupt: InstallInterrupt | null;
  }>(
    `/servers/${serverId}/install-failures`,
    fetcher,
    { refreshInterval: 20000, shouldRetryOnError: false }
  );

  const { t } = useT();
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
      {failures?.interrupt && (
        <InterruptBanner
          serverId={serverId}
          server={server}
          interrupt={failures.interrupt}
        />
      )}
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
          label={t("content.tabs.installed")}
          count={totalInstalled}
        />
        <TabButton
          active={tab === "browse"}
          onClick={() => setTab("browse")}
          label={t("content.tabs.browse")}
        />
      </div>

      {tab === "installed" ? (
        <InstalledPanel
          installed={installed}
          serverId={serverId}
          server={server}
        />
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
  server,
}: {
  installed: InstalledContent | undefined;
  serverId: string;
  server: ServerContext | undefined;
}): JSX.Element {
  const dialog = useDialog();
  const { t } = useT();
  const [sub, setSub] = useState<"mods" | "plugins" | "datapacks">("mods");
  const [detail, setDetail] = useState<{
    provider: "modrinth" | "curseforge";
    projectId: string;
    initial: { name?: string; iconUrl?: string; description?: string; pageUrl?: string };
  } | null>(null);
  const groups: Record<"mods" | "plugins" | "datapacks", InstalledFile[]> = {
    mods: installed?.mods ?? [],
    plugins: installed?.plugins ?? [],
    datapacks: installed?.datapacks ?? [],
  };
  const visible = groups[sub];
  const [query, setQuery] = useState("");

  // CurseForge exclusion list — staged in local state so the user
  // can add/remove multiple mods in one go and apply once. Reading
  // from server.env.CF_EXCLUDE_MODS (CSV of numeric mod IDs).
  const isCFModpack = server?.type === "CURSEFORGE";
  const initialExcluded = useMemo(
    () => parseExcludedIds(server?.env?.CF_EXCLUDE_MODS),
    [server?.env?.CF_EXCLUDE_MODS]
  );
  const [excludedDraft, setExcludedDraft] =
    useState<Set<string>>(initialExcluded);
  useEffect(() => {
    setExcludedDraft(initialExcluded);
  }, [initialExcluded]);
  const exclusionsDirty = !setsEqual(excludedDraft, initialExcluded);

  function toggleExclude(modId: string, exclude: boolean): void {
    const next = new Set(excludedDraft);
    if (exclude) next.add(modId);
    else next.delete(modId);
    setExcludedDraft(next);
  }

  async function applyExclusions(): Promise<void> {
    if (!server) return;
    try {
      const csv = serializeExcludedIds(excludedDraft);
      const nextEnv: Record<string, string> = { ...server.env };
      if (csv) nextEnv.CF_EXCLUDE_MODS = csv;
      else delete nextEnv.CF_EXCLUDE_MODS;
      await api.patch(`/servers/${serverId}`, { env: nextEnv });
      await api.post(`/servers/${serverId}/repair`);
      mutate(`/servers/${serverId}`);
      mutate(`/servers/${serverId}/installed-content`);
      dialog.toast({
        tone: "success",
        message: t("content.exclusions.applied", {
          n: excludedDraft.size,
        }),
      });
    } catch (e) {
      dialog.alert({
        tone: "danger",
        title: t("common.error"),
        message: e instanceof ApiError ? e.message : String(e),
      });
    }
  }

  async function remove(file: InstalledFile): Promise<void> {
    const ok = await dialog.confirm({
      tone: "danger",
      danger: true,
      title: t("content.installConfirm.delete.title"),
      message: t("content.installConfirm.delete.body", { name: file.name }),
      okLabel: t("common.delete"),
    });
    if (!ok) return;
    try {
      await api.del(
        `/servers/${serverId}/installed-content?type=${sub}&name=${encodeURIComponent(file.name)}`
      );
      mutate(`/servers/${serverId}/installed-content`);
    } catch (e) {
      dialog.alert({
        tone: "danger",
        title: t("common.error"),
        message: e instanceof ApiError ? e.message : String(e),
      });
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
              placeholder={t("content.installed.filter")}
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

      {/* CF exclusions panel — only relevant for AUTO_CURSEFORGE
          servers, where mods that itzg's pack-installer can't fetch
          go on a permanent skip-list. Without a UI the user had to
          edit env CSV by hand, which is what this widget replaces. */}
      {isCFModpack && (
        <ExclusionsPanel
          excluded={excludedDraft}
          installedMods={installed?.mods ?? []}
          dirty={exclusionsDirty}
          onToggle={toggleExclude}
          onApply={applyExclusions}
        />
      )}

      {filtered.length === 0 ? (
        <div className="tile p-10 text-center text-ink-muted">
          {installed === undefined
            ? t("common.loading")
            : query
              ? t("content.installed.noMatch", { type: sub, q: query })
              : t("content.installed.empty", { type: sub })}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {filtered.map((f) => {
            const cfId = f.curseforge?.modId
              ? String(f.curseforge.modId)
              : null;
            const isExcluded = cfId != null && excludedDraft.has(cfId);
            return (
              <InstalledCard
                key={f.name}
                file={f}
                onDelete={() => remove(f)}
                onOpen={() => {
                  const det = installedDetailKey(f);
                  if (det) setDetail(det);
                }}
                onToggleExclude={
                  isCFModpack && cfId
                    ? () => toggleExclude(cfId, !isExcluded)
                    : undefined
                }
                isExcluded={isExcluded}
              />
            );
          })}
        </div>
      )}

      <ContentDetailDrawer
        open={detail !== null}
        onClose={() => setDetail(null)}
        provider={detail?.provider ?? "modrinth"}
        projectId={detail?.projectId ?? ""}
        initial={detail?.initial}
      />
    </section>
  );
}

/**
 * Resolve a clickable provider+id pair from an installed jar's metadata.
 * Modrinth files include the slug; CurseForge files include the numeric
 * modId. Returns null when the jar has no provider match (manual upload,
 * unknown source) — caller hides the click affordance in that case.
 */
function installedDetailKey(
  f: InstalledFile
): {
  provider: "modrinth" | "curseforge";
  projectId: string;
  initial: { name?: string; iconUrl?: string; description?: string; pageUrl?: string };
} | null {
  if (f.modrinth?.slug) {
    return {
      provider: "modrinth",
      projectId: f.modrinth.slug,
      initial: {
        name: f.modrinth.title,
        iconUrl: f.modrinth.icon ?? undefined,
        description: f.modrinth.description,
        pageUrl: f.modrinth.pageUrl,
      },
    };
  }
  if (f.curseforge?.modId) {
    return {
      provider: "curseforge",
      projectId: String(f.curseforge.modId),
      initial: {
        name: f.curseforge.title,
        iconUrl: f.curseforge.icon ?? undefined,
        description: f.curseforge.summary,
        pageUrl: f.curseforge.pageUrl,
      },
    };
  }
  return null;
}

function InstalledCard({
  file,
  onDelete,
  onOpen,
  onToggleExclude,
  isExcluded,
}: {
  file: InstalledFile;
  onDelete: () => void;
  onOpen: () => void;
  /** Defined only on AUTO_CURSEFORGE servers when the file has a
   *  resolvable CF mod id. Toggles the mod into / out of the
   *  CF_EXCLUDE_MODS skip-list. The actual env patch + reprovision
   *  is staged by the parent panel's "Apply" button so the user can
   *  toggle several mods in one go. */
  onToggleExclude?: () => void;
  isExcluded: boolean;
}): JSX.Element {
  const title =
    file.modrinth?.title ?? file.curseforge?.title ?? prettifyFilename(file.name);
  const subtitle = file.modrinth?.description ?? file.curseforge?.summary;
  const icon = file.modrinth?.icon ?? file.curseforge?.icon ?? null;
  const pageUrl = file.modrinth?.pageUrl ?? file.curseforge?.pageUrl;
  const clickable = Boolean(file.modrinth?.slug || file.curseforge?.modId);
  return (
    <div
      className={cn(
        "tile p-3.5 flex gap-3 items-start transition-colors",
        clickable &&
          "cursor-pointer hover:bg-surface-2 hover:border-[rgb(var(--accent))]/30"
      )}
      onClick={clickable ? onOpen : undefined}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={(e) => {
        if (clickable && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      {icon ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={icon}
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
          {file.modrinth ? (
            <span className="chip chip-accent">
              <ModrinthMark size={10} /> Modrinth
            </span>
          ) : file.curseforge ? (
            <span className="chip chip-accent">
              <CurseForgeMark size={10} /> CurseForge
            </span>
          ) : null}
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
          {pageUrl && (
            <a
              className="link inline-flex items-center gap-1"
              href={pageUrl}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
            >
              page <ExternalLink size={10} />
            </a>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {onToggleExclude && (
          <button
            type="button"
            className={cn(
              "btn-icon !h-8 !w-8",
              isExcluded
                ? "bg-[rgb(var(--warning-soft))] text-[rgb(var(--warning))]"
                : "btn-ghost"
            )}
            onClick={(e) => {
              e.stopPropagation();
              onToggleExclude();
            }}
            aria-label={isExcluded ? "Unexclude" : "Exclude from pack"}
            title={
              isExcluded
                ? "Restore — remove this mod from CF_EXCLUDE_MODS"
                : "Exclude — skip this mod on the next pack install"
            }
          >
            <Ban size={14} />
          </button>
        )}
        <button
          className="btn-icon btn-ghost !h-8 !w-8"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          aria-label="Delete"
          title="Delete"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}

/**
 * Sticky panel above the installed grid that summarises the active
 * CF_EXCLUDE_MODS skip-list and gives the user a single "Apply"
 * affordance after toggling exclusions. The toggle itself happens
 * on individual InstalledCards (Ban button), or on entries already
 * in this panel via the unbutton.
 *
 * Apply triggers a server PATCH (env update) followed by a repair
 * (reprovision) — both wrapped in the toast/error path of the
 * parent. Skipped mods stay skipped across rebuilds because the
 * value lives in env, not in /data.
 */
function ExclusionsPanel({
  excluded,
  installedMods,
  dirty,
  onToggle,
  onApply,
}: {
  excluded: Set<string>;
  installedMods: InstalledFile[];
  dirty: boolean;
  onToggle: (modId: string, exclude: boolean) => void;
  onApply: () => void | Promise<void>;
}): JSX.Element | null {
  // Resolve mod-id → human title via the installed-mods list. Files
  // that match an excluded id by `curseforge.modId` give us the name;
  // entries whose mods aren't in the current installed list (they
  // were never actually installed because they were excluded already)
  // just show the numeric id.
  const titleByModId = useMemo(() => {
    const map = new Map<string, string>();
    for (const f of installedMods) {
      const mid = f.curseforge?.modId;
      if (!mid) continue;
      const title =
        f.curseforge?.title ?? f.modrinth?.title ?? prettifyFilename(f.name);
      map.set(String(mid), title);
    }
    return map;
  }, [installedMods]);

  if (excluded.size === 0 && !dirty) {
    // Hide entirely until the user starts staging exclusions —
    // saves vertical space on a clean install.
    return null;
  }

  return (
    <section className="tile p-4 space-y-3 border-[rgb(var(--warning))]/30">
      <header className="flex items-center gap-2 flex-wrap">
        <Ban size={14} className="text-[rgb(var(--warning))] shrink-0" />
        <h3 className="text-sm font-medium">CF excluded mods</h3>
        <span className="text-[10px] text-ink-muted tabular-nums">
          {excluded.size}
        </span>
        <p className="text-xs text-ink-muted flex-1 min-w-[200px]">
          These mod ids are skipped when the modpack reinstalls.
          Useful when an author disables third-party download for one
          mod and you've replaced it with a Modrinth alternative.
        </p>
        {dirty && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void onApply()}
            title="Patch env + rebuild the container"
          >
            Apply &amp; rebuild
          </button>
        )}
      </header>
      {excluded.size > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {[...excluded].map((modId) => {
            const title = titleByModId.get(modId);
            return (
              <li
                key={modId}
                className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-[rgb(var(--warning-soft))] text-[rgb(var(--warning))] text-xs"
              >
                <span className="font-medium">
                  {title ?? `#${modId}`}
                </span>
                {title && (
                  <span className="opacity-60 tabular-nums">#{modId}</span>
                )}
                <button
                  type="button"
                  onClick={() => onToggle(modId, false)}
                  className="hover:opacity-70"
                  aria-label="Remove from exclusions"
                  title="Remove from exclusions"
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/* =============================== FAILURES =============================== */

function InterruptBanner({
  server,
  interrupt,
}: {
  serverId: string;
  server: ServerContext | undefined;
  interrupt: InstallInterrupt;
}): JSX.Element {
  const { t } = useT();
  // Kind-specific heading so the user sees the nature of the problem
  // at a glance; the body is the agent-formatted human message.
  const titleMap: Record<InstallInterrupt["kind"], string> = {
    timeout: "CurseForge: таймаут скачивания",
    exhausted: "CurseForge: попытки исчерпаны",
    generic: "CurseForge: установка прервана",
  };
  const proxyActive = server?.env?.__COFEMINE_INSTALL_PROXY === "1";

  return (
    <section className="tile p-5 flex items-start gap-3 border-[rgb(var(--warning))]/30">
      <span className="w-8 h-8 rounded-md bg-[rgb(var(--warning-soft))] text-[rgb(var(--warning))] grid place-items-center shrink-0">
        <AlertTriangle size={16} />
      </span>
      <div className="flex-1 min-w-0">
        <h3 className="heading-md">{titleMap[interrupt.kind]}</h3>
        <p className="text-sm text-ink-secondary mt-1">
          {interrupt.message}
        </p>
        {proxyActive && (
          <p className="text-sm text-[rgb(var(--accent))] mt-2">
            {t("proxy.autoActive")}
          </p>
        )}
      </div>
    </section>
  );
}

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
  const dialog = useDialog();
  const { t } = useT();
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
    const ok = await dialog.confirm({
      title: t("content.autoConfirm.title"),
      message: t("content.autoConfirm.body", { n: failures.length }),
    });
    if (!ok) return;
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
          // Same filters used to find this top hit; forward them so
          // the install resolver picks a compatible Modrinth version
          // instead of the newest (potentially incompatible) one.
          await api.post(`/integrations/servers/${serverId}/install/modrinth`, {
            projectId: top.id,
            kind: "mod",
            ...(gameVersion ? { gameVersion } : {}),
            ...(loader ? { loader } : {}),
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
      t("content.autoSummary.installed", { n: installed.length }),
      t("content.autoSummary.noMatch", { n: noMatch.length }),
      t("content.autoSummary.errors", { n: errored.length }),
    ];
    if (noMatch.length > 0) {
      lines.push(
        "",
        ...noMatch.slice(0, 10).map((r) => `  • ${r.failure.modName}`)
      );
      if (noMatch.length > 10) lines.push(`  … +${noMatch.length - 10} more`);
    }
    if (errored.length > 0) {
      lines.push(
        "",
        ...errored
          .slice(0, 5)
          .map((r) => `  • ${r.failure.modName}: ${r.message}`)
      );
    }
    setAutoStatus(
      installed.length > 0
        ? t("content.autoSummary.installedStatus", { n: installed.length })
        : t("content.autoSummary.nothingInstalled")
    );
    dialog.alert({
      tone: installed.length > 0 ? "success" : "info",
      title: t("content.autoSummary.title"),
      message: lines.join("\n"),
    });
  }

  async function skipAndRetry(): Promise<void> {
    if (!server) return;
    if (idsToSkip.length === 0) {
      dialog.alert({
        tone: "warning",
        title: t("content.failures.noIds.title"),
        message: t("content.failures.noIds.body"),
      });
      return;
    }
    const ok = await dialog.confirm({
      title: t("content.skipConfirm.title"),
      message: t("content.skipConfirm.body", { n: idsToSkip.length }),
    });
    if (!ok) return;
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
      dialog.alert({
        tone: "success",
        title: t("common.done"),
        message: t("content.skipDone", { n: idsToSkip.length }),
      });
      mutate(`/servers/${serverId}`);
      mutate(`/servers/${serverId}/install-failures`);
    } catch (e) {
      dialog.alert({
        tone: "danger",
        title: t("common.error"),
        message: e instanceof ApiError ? e.message : String(e),
      });
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
          <h3 className="heading-md">{t("content.failures.title")}</h3>
          <p className="text-sm text-ink-muted mt-1">
            {t("content.failures.desc", { n: failures.length })}
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
            {autoBusy ? t("content.tryModrinthAll.busy") : t("content.tryModrinthAll")}
          </button>
          {idsToSkip.length > 0 && (
            <button
              className="btn-primary shrink-0"
              onClick={skipAndRetry}
              disabled={busy || autoBusy || !server}
              title="Add these mod IDs to CF_EXCLUDE_MODS and rebuild the container"
            >
              {busy ? t("content.skipRetry.applying") : t("content.skipRetry")}
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
              <ModrinthMark size={12} /> {t("content.findOnModrinth")}
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
  const { t } = useT();
  const [provider, setProvider] = useState<"modrinth" | "curseforge">(
    "modrinth"
  );
  const [query, setQuery] = useState("");
  const [gameVersion, setGameVersion] = useState("");
  const [loader, setLoader] = useState("");
  // Re-derive the locked filters every time the server data, modpack
  // type, or installed-mods detection updates. For pure mod-loader
  // servers (NEOFORGE / FABRIC / FORGE / QUILT) `server.type` is enough
  // to pick the loader. For modpack-source servers (CURSEFORGE /
  // MODRINTH) the static type only says "this server boots a pack" —
  // the *actual* loader is whatever the pack picked, so we lean on the
  // agent's runtime detection (jar-filename heuristic) instead.
  useEffect(() => {
    if (!server) return;
    const isModpackSource =
      server.type === "CURSEFORGE" || server.type === "MODRINTH";
    const detected = installed?.runtime;

    let nextVersion = "";
    if (server.version && server.version !== "LATEST") {
      nextVersion = server.version;
    }
    if (!nextVersion && isModpackSource && detected?.mcVersion) {
      nextVersion = detected.mcVersion;
    }

    let nextLoader = typeToLoader(server.type);
    if (!nextLoader && isModpackSource && detected?.loader) {
      nextLoader = detected.loader;
    }

    setGameVersion(nextVersion);
    setLoader(nextLoader);
  }, [server, installed?.runtime]);
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
  const [detail, setDetail] = useState<Summary | null>(null);

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
      if (f.curseforge?.slug) set.add(normKey(f.curseforge.slug));
      if (f.curseforge?.title) set.add(normKey(f.curseforge.title));
      if (f.curseforge?.modId)
        set.add(normKey(String(f.curseforge.modId)));
      set.add(normKey(slugFromFilename(f.name)));
    }
    return set;
  }, [installed]);

  const PAGE_SIZE = 30;
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  // Fetch page 0 whenever filters change. Appending extra pages is
  // handled separately by `loadMore`. Using a ref to track the current
  // filter-version so an in-flight request from the previous query
  // can't clobber results for a newer one.
  useEffect(() => {
    if (provider === "curseforge" && cfDisabled) {
      setResults([]);
      setHasMore(false);
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
          qp.set("limit", String(PAGE_SIZE));
          qp.set("offset", "0");
          const res = await api.get<any>(
            `/integrations/${provider}/search?${qp.toString()}`
          );
          if (cancelled) return;
          const raw: any[] = Array.isArray(res) ? res : (res.results ?? []);
          setResults(raw);
          setHasMore(raw.length >= PAGE_SIZE);
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

  async function loadMore(): Promise<void> {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    setErr(null);
    try {
      const qp = new URLSearchParams();
      if (query) qp.set("query", query);
      if (gameVersion) qp.set("gameVersion", gameVersion);
      if (loader) qp.set("loader", loader);
      qp.set("projectType", kind);
      qp.set("limit", String(PAGE_SIZE));
      qp.set("offset", String(results.length));
      const res = await api.get<any>(
        `/integrations/${provider}/search?${qp.toString()}`
      );
      const raw: any[] = Array.isArray(res) ? res : (res.results ?? []);
      // Dedup in case the API returns overlapping entries on offset.
      const seen = new Set(results.map((r) => `${r.provider}:${r.id}`));
      const fresh = raw.filter((r) => !seen.has(`${r.provider}:${r.id}`));
      setResults((prev) => [...prev, ...fresh]);
      setHasMore(raw.length >= PAGE_SIZE);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setLoadingMore(false);
    }
  }

  async function install(r: Summary): Promise<void> {
    setInstallingId(r.id);
    setMsg(null);
    setErr(null);
    try {
      const endpoint = `/integrations/servers/${serverId}/install/${provider}`;
      // Forward the server's runtime (MC version + loader) so the
      // install endpoint resolves "latest" against compatible
      // versions instead of the project's newest build at large.
      // Without this, installing dynmap onto a 1.20.1 Forge server
      // would happily download the 1.21.11 build that crashes
      // immediately. typeToLoader/runtime detection happens upstream
      // (the BrowsePanel useEffect that locks `gameVersion`/`loader`
      // from server.type + installed runtime), we just need to wire
      // it through here.
      const filters: Record<string, string> = {};
      if (gameVersion) filters.gameVersion = gameVersion;
      if (loader) filters.loader = loader;
      const body =
        provider === "modrinth"
          ? { projectId: r.id, kind, ...filters }
          : { projectId: Number(r.id), kind, ...filters };
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

      <div className="tile p-4 grid grid-cols-1 md:grid-cols-[1fr_140px] gap-3">
        <div className="relative">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted"
          />
          <input
            className="input pl-8"
            placeholder={t("content.browse.searchPlaceholder", {
              provider,
              kind: t(`content.browse.kind.${kind}`),
            })}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <select
          className="select"
          value={kind}
          onChange={(e) => setKind(e.target.value as Kind)}
        >
          <option value="mod">{t("content.browse.kind.mod")}</option>
          <option value="modpack">{t("content.browse.kind.modpack")}</option>
          <option value="plugin">{t("content.browse.kind.plugin")}</option>
          <option value="datapack">{t("content.browse.kind.datapack")}</option>
        </select>
      </div>
      {/* Locked filters from the server context. We never show the version
          / loader pickers here — they belong in the wizard, not on a
          server that's already running 1.21.1 / NeoForge. The API call
          already has these baked in via the useEffect below. */}
      <div className="text-xs text-ink-muted flex items-center gap-2 flex-wrap">
        <span>{t("content.browse.lockedPrefix")}</span>
        {gameVersion && (
          <code className="kbd">MC {gameVersion}</code>
        )}
        {loader && <code className="kbd">{loader}</code>}
        <span>·</span>
        <span>{t("content.browse.serverInstallableOnly")}</span>
      </div>

      <div className="flex items-center justify-between min-h-[20px] text-sm">
        <span className="text-ink-muted">
          {busy
            ? t("content.browse.searching")
            : t("content.browse.results", {
                n: results.length,
                more: hasMore ? "+" : "",
              })}
        </span>
        {msg && <span className="text-[rgb(var(--success))]">{msg}</span>}
        {err && <span className="text-[rgb(var(--danger))]">{err}</span>}
      </div>

      {cfDisabled && provider === "curseforge" ? (
        <div className="tile p-8 text-center">
          <p className="text-sm text-ink-secondary max-w-md mx-auto">
            {t("content.browse.cfKeyMissing")}
          </p>
        </div>
      ) : (
        <>
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
                  onOpen={() => setDetail(r)}
                />
              );
            })}
            {!busy && results.length === 0 && (
              <div className="md:col-span-2 tile p-8 text-center text-ink-muted text-sm">
                {query
                  ? t("content.browse.noMatch")
                  : t("content.browse.noResults")}
              </div>
            )}
          </div>
          {results.length > 0 && hasMore && (
            <InfiniteScrollSentinel
              onVisible={loadMore}
              disabled={loadingMore || busy}
              loadingLabel={t("content.browse.loadingMore")}
              loading={loadingMore}
            />
          )}
        </>
      )}

      <ContentDetailDrawer
        open={detail !== null}
        onClose={() => setDetail(null)}
        provider={detail?.provider ?? provider}
        projectId={detail?.id ?? ""}
        initial={
          detail
            ? {
                name: detail.name,
                iconUrl: detail.iconUrl,
                description: detail.description,
                pageUrl: detail.pageUrl,
                author: detail.author,
                downloads: detail.downloads,
              }
            : undefined
        }
        installed={
          detail
            ? resultIsInstalled(detail, installedKeys) ||
              (!!detail.slug && recentSlugs.has(normKey(detail.slug))) ||
              recentSlugs.has(normKey(String(detail.id)))
            : false
        }
        installing={installingId === detail?.id}
        onInstall={detail ? () => install(detail) : undefined}
      />
    </section>
  );
}

function ResultCard({
  r,
  installed,
  installing,
  onInstall,
  onOpen,
}: {
  r: Summary;
  installed: boolean;
  installing: boolean;
  onInstall: () => void;
  onOpen: () => void;
}): JSX.Element {
  const { t } = useT();
  return (
    <div
      className="tile p-4 flex gap-3 cursor-pointer transition-colors hover:bg-surface-2 hover:border-[rgb(var(--accent))]/30"
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
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
              <Check size={10} /> {t("content.installedBadge")}
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
        onClick={(e) => {
          e.stopPropagation();
          onInstall();
        }}
        disabled={installing || installed}
      >
        {installed ? (
          <>
            <Check size={14} /> {t("content.installedBadge")}
          </>
        ) : installing ? (
          t("content.installing")
        ) : (
          t("content.install")
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

/** Parse the comma-separated mod-id CSV that itzg's AUTO_CURSEFORGE
 *  reads from `CF_EXCLUDE_MODS`. Whitespace and empties are trimmed
 *  so a freshly-edited env value with stray commas still works. */
function parseExcludedIds(csv: string | undefined): Set<string> {
  if (!csv) return new Set();
  return new Set(
    csv
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

function serializeExcludedIds(set: Set<string>): string {
  return [...set].sort().join(",");
}

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/**
 * Bottom-of-list sentinel that fires `onVisible` once it scrolls into
 * view. Used to drive infinite-scroll on the modpack browser without
 * a "Load more" button. Re-arms each time the parent re-renders with
 * a new `onVisible` (i.e. after a new page lands and `results.length`
 * changed), so the user can keep scrolling forever as long as
 * upstream still has matches.
 *
 * Disabled state turns the sentinel into a passive label (in-flight
 * fetch indicator) so it can't fire while we're already loading.
 */
function InfiniteScrollSentinel({
  onVisible,
  disabled,
  loading,
  loadingLabel,
}: {
  onVisible: () => void;
  disabled: boolean;
  loading: boolean;
  loadingLabel: string;
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (disabled) return;
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            onVisible();
            // Once we've fired, the parent re-renders with the new
            // results — observer is recreated by the useEffect deps,
            // so we don't need to manually re-arm here.
            return;
          }
        }
      },
      // 200px rootMargin so we fetch the next page while the user is
      // still scrolling — the new rows appear before they hit the
      // visual bottom.
      { rootMargin: "200px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [onVisible, disabled]);

  return (
    <div
      ref={ref}
      className="flex justify-center items-center gap-2 py-4 text-xs text-ink-muted"
    >
      {loading && <Loader2 size={12} className="animate-spin" />}
      {loading ? loadingLabel : null}
    </div>
  );
}

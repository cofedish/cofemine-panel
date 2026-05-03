"use client";
import { useState, useMemo, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { motion, AnimatePresence } from "framer-motion";
import { api, ApiError, fetcher } from "@/lib/api";
import { SERVER_TYPES } from "@cofemine/shared";
import { PageHeader } from "@/components/page-header";
import {
  getServerMeta,
  ServerTypeHero,
  ServerTypeIcon,
  SERVER_TYPE_META,
  type ServerTypeKey,
} from "@/components/server-icons";
import { EnvForm } from "@/components/env-form";
import { ImageUpload } from "@/components/image-upload";
import { MemorySlider } from "@/components/memory-slider";
import { ContentDetailDrawer } from "@/components/content-detail-drawer";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Search,
  Package,
  Download,
} from "lucide-react";

type Node = { id: string; name: string; status: string };
type McVersions = {
  latest: { release: string; snapshot: string };
  versions: Array<{ id: string; type: string; releaseTime: string }>;
};

type Integrations = {
  providers: {
    modrinth: { enabled: boolean };
    curseforge: { enabled: boolean };
  };
};

type ModpackHit = {
  id: string;
  provider: "modrinth" | "curseforge";
  name: string;
  slug?: string;
  description?: string;
  iconUrl?: string;
  author?: string;
  downloads?: number;
  pageUrl?: string;
};

type Source = "plain" | "modrinth" | "curseforge";

const PLAIN_TYPES = SERVER_TYPES.filter(
  (t) => t !== "MODRINTH" && t !== "CURSEFORGE"
);
const STEPS = ["Source", "Pick", "Resources", "Review"] as const;
type Step = (typeof STEPS)[number];

function stepKey(s: Step): string {
  switch (s) {
    case "Source":
      return "wizard.step.source";
    case "Pick":
      return "wizard.step.basics";
    case "Resources":
      return "wizard.step.resources";
    case "Review":
      return "wizard.step.review";
  }
}

/** Small curated fallback if the manifest can't be fetched. */
const VERSION_FALLBACK = [
  "1.21.4",
  "1.21.3",
  "1.21.1",
  "1.21",
  "1.20.6",
  "1.20.4",
  "1.20.1",
  "1.19.4",
  "1.18.2",
  "1.17.1",
  "1.16.5",
  "1.12.2",
  "1.8.9",
];

export default function CreateServerPage(): JSX.Element {
  const router = useRouter();
  const { t } = useT();
  const { data: nodes } = useSWR<Node[]>("/nodes", fetcher);
  const { data: integ } = useSWR<Integrations>("/integrations", fetcher);
  const { data: mcVersions } = useSWR<McVersions>(
    "/meta/mc-versions",
    fetcher,
    { revalidateOnFocus: false }
  );

  const [step, setStep] = useState<Step>("Source");

  // Source selection
  const [source, setSource] = useState<Source>("plain");

  // Plain-mode fields
  const [type, setType] = useState<ServerTypeKey>("PAPER");
  const [version, setVersion] = useState("1.21.1");

  // Modpack selection
  const [pack, setPack] = useState<ModpackHit | null>(null);
  /** Pinned pack version — id is what itzg needs (Modrinth version id
   *  or CurseForge file id as string). Empty id ("") means "latest"
   *  for itzg but we still carry along the pack's actual MC version
   *  and loader so downstream installers (e.g. dynmap auto-install)
   *  can pick a compatible build instead of Modrinth's newest-of-all
   *  which usually targets a newer MC release. */
  const [packVersion, setPackVersion] = useState<
    { id: string; label: string; gameVersion?: string; loader?: string } | null
  >(null);

  // Basics / resources
  const [name, setName] = useState("survival");
  const [description, setDescription] = useState("");
  const [nodeId, setNodeId] = useState("");
  const [memoryMb, setMemoryMb] = useState(2048);
  const [hostPort, setHostPort] = useState(25565);
  const [env, setEnv] = useState<Record<string, string>>({
    DIFFICULTY: "normal",
    MAX_PLAYERS: "20",
  });
  /** Optional server-icon PNG uploaded through ImageUpload. Uploaded to
   *  /servers/:id/icon *after* server creation (no id to target before). */
  const [iconDataUrl, setIconDataUrl] = useState<string | null>(null);
  /** Auto-install dynmap right after the server is created. Hits the
   *  same /integrations/servers/:id/install/* endpoints the Content
   *  tab uses, with the right Modrinth slug for the chosen loader.
   *  Off by default — Vanilla can't load it, and not everyone wants
   *  the live map. */
  const [installDynmap, setInstallDynmap] = useState(false);
  const [eula, setEula] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const effectiveType: ServerTypeKey =
    source === "modrinth"
      ? "MODRINTH"
      : source === "curseforge"
        ? "CURSEFORGE"
        : type;

  const versionOptions = useMemo(() => {
    if (!mcVersions || mcVersions.versions.length === 0)
      return VERSION_FALLBACK;
    return mcVersions.versions.map((v) => v.id);
  }, [mcVersions]);

  async function submit(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      // Resolve the live-map jar URL BEFORE creating the server, so
      // we can inject it into the container's env at create-time.
      // itzg's MODS / PLUGINS env vars are its native mechanism for
      // "extra files alongside the modpack" — itzg downloads them on
      // every start and they survive across pack reinstalls. This
      // replaces our previous post-boot-install-hook approach which
      // relied on a status reconciler firing after first boot and was
      // brittle in practice (didn't fire reliably, didn't survive
      // modpack first-install wipes, etc.).
      const mergedEnv: Record<string, string> = { ...env };
      const dynmapTarget = dynmapTargetFor(
        effectiveType,
        packVersion?.loader
      );
      if (installDynmap && dynmapTarget) {
        const { gameVersion, loader } = resolveRuntimeFilters(
          source,
          effectiveType,
          version,
          packVersion
        );
        try {
          const url = await resolveModrinthDownloadUrl(
            dynmapTarget.slug,
            gameVersion,
            loader
          );
          if (url) {
            // itzg env keys: PLUGINS for Bukkit-family, MODS for
            // Forge/Fabric/NeoForge. Comma-append if the user already
            // has something there.
            const envKey =
              dynmapTarget.kind === "plugin" ? "PLUGINS" : "MODS";
            mergedEnv[envKey] = mergedEnv[envKey]
              ? `${mergedEnv[envKey]},${url}`
              : url;
          } else {
            setErr(
              `Server will be created, but no compatible ${dynmapTarget.slug} build was found for MC ${gameVersion ?? "?"} / ${loader ?? "?"}. The map plugin won't auto-install — pick a compatible release manually from the Content tab.`
            );
          }
        } catch (e) {
          const msg =
            e instanceof ApiError
              ? e.message
              : e instanceof Error
                ? e.message
                : String(e);
          setErr(
            `Server will be created, but resolving the map plugin failed: ${msg}`
          );
        }
      }

      const body: any = {
        name,
        description: description || undefined,
        nodeId,
        type: effectiveType,
        memoryMb: Number(memoryMb),
        ports: [{ host: Number(hostPort), container: 25565, protocol: "tcp" }],
        env: mergedEnv,
        eulaAccepted: eula,
      };
      if (source === "plain") {
        body.version = version;
      } else {
        body.modpack = {
          provider: source,
          projectId: pack!.id,
          slug: pack!.slug,
          url: pack!.pageUrl,
          // packVersion is now always set after the picker auto-fills
          // with "Latest"-with-metadata. Only forward versionId when
          // it's actually pinned (non-empty) — the shared schema
          // rejects empty strings, and itzg interprets a missing
          // versionId as "use the newest pack release" anyway.
          ...(packVersion?.id
            ? {
                versionId: packVersion.id,
                versionLabel: packVersion.label,
              }
            : {}),
        };
        body.version = "LATEST";
      }
      const res = await api.post<{ id: string }>("/servers", body);
      // Icon upload happens separately — the server needs to exist first
      // so we have a /servers/:id to POST to. Non-fatal if it fails.
      if (iconDataUrl) {
        try {
          await api.post(`/servers/${res.id}/icon`, { data: iconDataUrl });
        } catch (e) {
          console.warn("Failed to upload icon after create:", e);
        }
      }
      // Pre-place the map jar on disk RIGHT NOW so it shows up in
      // /data/mods before the user clicks Start. The MODS env we
      // baked into create body above is the safety net — itzg
      // downloads the URL on every start, which means the jar
      // survives an AUTO_CURSEFORGE first-boot mods/ wipe (the pack
      // installer cleans /data/mods to its own manifest). With both
      // mechanisms wired up the user sees the file in the Files tab
      // immediately after create, and it stays there across pack
      // reinstalls.
      if (installDynmap && dynmapTarget) {
        const { gameVersion, loader } = resolveRuntimeFilters(
          source,
          effectiveType,
          version,
          packVersion
        );
        try {
          await api.post(
            `/integrations/servers/${res.id}/install/modrinth`,
            {
              projectId: dynmapTarget.slug,
              kind: dynmapTarget.kind,
              ...(gameVersion ? { gameVersion } : {}),
              ...(loader ? { loader } : {}),
            }
          );
        } catch (e) {
          // Non-fatal — the MODS / PLUGINS env entry that we baked
          // into create body still kicks in at first start and pulls
          // the jar then. Just surface the error so the user knows
          // why the file isn't there yet.
          const msg =
            e instanceof ApiError
              ? e.message
              : e instanceof Error
                ? e.message
                : String(e);
          console.warn("Pre-install of live-map jar failed:", msg);
        }
      }
      router.push(`/servers/${res.id}`);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const idx = STEPS.indexOf(step);
  const canNext =
    step === "Source"
      ? true
      : step === "Pick"
        ? source === "plain"
          ? !!type && !!version
          : !!pack
        : step === "Resources"
          ? !!name && !!nodeId && memoryMb >= 512 && hostPort > 0
          : eula;

  function next(): void {
    setStep(STEPS[Math.min(idx + 1, STEPS.length - 1)] ?? STEPS[0]!);
  }
  function prev(): void {
    setStep(STEPS[Math.max(idx - 1, 0)] ?? STEPS[0]!);
  }

  return (
    <div className="space-y-8 max-w-5xl mx-auto">
      <PageHeader
        breadcrumbs={[
          { label: t("nav.dashboard"), href: "/" },
          { label: t("wizard.title") },
        ]}
        title={t("wizard.create")}
        description=""
      />

      {/* Stepper */}
      <ol className="flex items-center gap-3 flex-wrap">
        {STEPS.map((s, i) => {
          const done = i < idx;
          const current = i === idx;
          return (
            <li key={s} className="flex items-center gap-2 text-sm">
              <span
                className={cn(
                  "w-6 h-6 grid place-items-center rounded-full text-xs font-semibold transition-colors",
                  done && "bg-[rgb(var(--accent))] text-[rgb(var(--accent-ink))]",
                  current &&
                    !done &&
                    "bg-[rgb(var(--accent-soft))] text-[rgb(var(--accent))] ring-2 ring-[rgb(var(--accent))]/40",
                  !done && !current && "bg-surface-2 text-ink-muted"
                )}
              >
                {done ? <Check size={13} /> : i + 1}
              </span>
              <span
                className={cn(
                  current ? "text-ink font-medium" : "text-ink-muted"
                )}
              >
                {t(stepKey(s))}
              </span>
              {i < STEPS.length - 1 && (
                <span
                  className={cn(
                    "w-8 h-px transition-colors",
                    done ? "bg-[rgb(var(--accent))]" : "bg-line"
                  )}
                />
              )}
            </li>
          );
        })}
      </ol>

      <AnimatePresence mode="wait">
        <motion.div
          key={step}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.18 }}
        >
          {step === "Source" && (
            <SourceStep
              source={source}
              onPick={setSource}
              cfEnabled={!!integ?.providers.curseforge.enabled}
            />
          )}
          {step === "Pick" &&
            (source === "plain" ? (
              <PlainPickStep
                type={type}
                onType={setType}
                version={version}
                onVersion={setVersion}
                versions={versionOptions}
                versionsLoading={!mcVersions}
              />
            ) : (
              <PackPickStep
                provider={source}
                pack={pack}
                onPick={(p) => {
                  setPack(p);
                  setPackVersion(null);
                }}
                packVersion={packVersion}
                onPickVersion={setPackVersion}
              />
            ))}
          {step === "Resources" && (
            <ResourcesStep
              nodes={nodes ?? []}
              name={name}
              setName={setName}
              description={description}
              setDescription={setDescription}
              nodeId={nodeId}
              setNodeId={setNodeId}
              memoryMb={memoryMb}
              setMemoryMb={setMemoryMb}
              hostPort={hostPort}
              setHostPort={setHostPort}
              env={env}
              setEnv={setEnv}
              currentType={effectiveType}
              iconDataUrl={iconDataUrl}
              setIconDataUrl={setIconDataUrl}
            />
          )}
          {step === "Review" && (
            <ReviewStep
              type={effectiveType}
              name={name}
              version={source === "plain" ? version : "from pack"}
              memoryMb={memoryMb}
              hostPort={hostPort}
              nodeName={nodes?.find((n) => n.id === nodeId)?.name}
              envCount={Object.keys(env).length}
              pack={pack}
              packLoader={packVersion?.loader ?? null}
              eula={eula}
              onEula={setEula}
              installDynmap={installDynmap}
              onInstallDynmap={setInstallDynmap}
              err={err}
            />
          )}
        </motion.div>
      </AnimatePresence>

      {/* Spacer so the floating nav bar at the bottom of the viewport
          doesn't overlap the last bit of step content. */}
      <div className="h-20" aria-hidden />

      {/* Floating action bar. Was `sticky bottom-0` with negative side
          margins and sharp corners — that made it look like it was
          flying around the page when content was short, and the
          square edges clashed with the rest of the panel's tile/card
          look. Now it's a rounded raised pill fixed to the viewport,
          centred horizontally inside the wizard's max-width. */}
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-30 w-[calc(min(64rem,100%-2rem))] max-w-5xl">
        <div className="surface-raised rounded-2xl shadow-[var(--shadow-popover)] px-4 py-2.5 flex items-center justify-between gap-3 backdrop-blur-md bg-[rgb(var(--bg-surface-1))]/95">
          <button
            type="button"
            onClick={() => (idx === 0 ? router.back() : prev())}
            className="btn btn-ghost"
          >
            <ChevronLeft size={15} /> {idx === 0 ? t("common.cancel") : t("wizard.back")}
          </button>
          <span className="text-xs text-ink-muted hidden sm:inline">
            {t(stepKey(step))}
            <span className="text-ink-muted/60 ml-2">
              {idx + 1} / {STEPS.length}
            </span>
          </span>
          {step !== "Review" ? (
            <button
              type="button"
              onClick={next}
              className="btn btn-primary"
              disabled={!canNext}
            >
              {t("wizard.next")} <ChevronRight size={15} />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              className="btn btn-primary"
              disabled={busy || !canNext}
            >
              {busy ? t("wizard.creating") : t("wizard.create")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ============================== STEPS ============================== */

function SourceStep({
  source,
  onPick,
  cfEnabled,
}: {
  source: Source;
  onPick: (s: Source) => void;
  cfEnabled: boolean;
}): JSX.Element {
  const { t } = useT();
  const cards: Array<{
    id: Source;
    title: string;
    desc: string;
    meta: string;
    type: ServerTypeKey;
    disabled?: string;
  }> = [
    {
      id: "plain",
      title: t("wizard.source.plain"),
      desc: t("wizard.source.plainDesc"),
      meta: t("wizard.source.meta.plain"),
      type: "PAPER",
    },
    {
      id: "modrinth",
      title: t("wizard.source.modrinth"),
      desc: t("wizard.source.modrinthDesc"),
      meta: t("wizard.source.meta.modrinth"),
      type: "MODRINTH",
    },
    {
      id: "curseforge",
      title: t("wizard.source.curseforge"),
      desc: t("wizard.source.curseforgeDesc"),
      meta: cfEnabled
        ? t("wizard.source.meta.curseforgeOk")
        : t("wizard.source.meta.curseforgeMissing"),
      type: "CURSEFORGE",
      disabled: cfEnabled ? undefined : t("wizard.source.cfDisabledHint"),
    },
  ];
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {cards.map((c) => {
        const active = source === c.id;
        const isDisabled = !!c.disabled;
        return (
          <button
            key={c.id}
            type="button"
            onClick={() => !isDisabled && onPick(c.id)}
            disabled={isDisabled}
            title={c.disabled}
            className={cn(
              "tile text-left overflow-hidden transition-all relative",
              active
                ? "ring-2 ring-[rgb(var(--accent))]/50 border-[rgb(var(--accent))]/50"
                : "hover:border-line-strong",
              isDisabled && "opacity-50 cursor-not-allowed"
            )}
          >
            <ServerTypeHero type={c.type} height={110} glyphSize={60} />
            <div className="p-5 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="heading-md">{c.title}</div>
                {active && (
                  <span className="chip chip-accent">
                    <Check size={10} /> {t("wizard.source.selected")}
                  </span>
                )}
              </div>
              <p className="text-sm text-ink-secondary">{c.desc}</p>
              <div className="text-xs text-ink-muted">{c.meta}</div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function PlainPickStep({
  type,
  onType,
  version,
  onVersion,
  versions,
  versionsLoading,
}: {
  type: ServerTypeKey;
  onType: (t: ServerTypeKey) => void;
  version: string;
  onVersion: (v: string) => void;
  versions: string[];
  versionsLoading: boolean;
}): JSX.Element {
  const { t } = useT();
  const meta = getServerMeta(type);
  return (
    <div className="tile p-7 space-y-6">
      <div className="space-y-3">
        <h2 className="heading-md">{t("wizard.type")}</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {PLAIN_TYPES.map((t) => {
            const m = SERVER_TYPE_META[t as ServerTypeKey]!;
            const active = type === t;
            return (
              <button
                key={t}
                type="button"
                onClick={() => onType(t as ServerTypeKey)}
                className={cn(
                  "rounded-lg border text-left overflow-hidden transition-all",
                  active
                    ? "border-[rgb(var(--accent))]/60 ring-2 ring-[rgb(var(--accent))]/25"
                    : "border-line hover:border-line-strong"
                )}
              >
                <ServerTypeHero type={t} height={72} glyphSize={30} />
                <div className="px-3 py-2 bg-surface-1">
                  <div className="text-sm font-medium">{m.label}</div>
                </div>
              </button>
            );
          })}
        </div>
        <p className="text-sm text-ink-muted">{meta.description}</p>
      </div>

      <div className="divider" />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label={t("wizard.version")}>
          <select
            className="select"
            value={version}
            onChange={(e) => onVersion(e.target.value)}
          >
            {versionsLoading && versions.length === 0 && (
              <option>{t("common.loading")}</option>
            )}
            {versions.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </div>
  );
}

function PackPickStep({
  provider,
  pack,
  onPick,
  packVersion,
  onPickVersion,
}: {
  provider: "modrinth" | "curseforge";
  pack: ModpackHit | null;
  onPick: (p: ModpackHit) => void;
  packVersion: { id: string; label: string } | null;
  onPickVersion: (v: { id: string; label: string } | null) => void;
}): JSX.Element {
  const { t } = useT();
  const [query, setQuery] = useState("");
  const [gameVersion, setGameVersion] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [results, setResults] = useState<ModpackHit[]>([]);
  const [err, setErr] = useState<string | null>(null);
  // Pack the user is *previewing* in the detail drawer. Distinct from
  // `pack` (the wizard's confirmed selection) because we don't want to
  // mutate wizard state until they hit "Use this pack" inside the drawer.
  const [preview, setPreview] = useState<ModpackHit | null>(null);
  // Pending version selected inside the drawer for the previewed pack.
  // Reset every time the previewed pack changes so old selections from a
  // different pack don't leak into the new one.
  const [pendingVersion, setPendingVersion] =
    useState<{ id: string; label: string } | null>(null);
  useEffect(() => {
    setPendingVersion(null);
  }, [preview?.id]);

  const PAGE_SIZE = 24;

  function mapHit(r: any): ModpackHit {
    return {
      id: String(r.id),
      provider,
      name: r.name,
      slug: r.slug,
      description: r.description,
      iconUrl: r.iconUrl,
      author: r.author,
      downloads: r.downloads,
      pageUrl: r.pageUrl,
    };
  }

  // First-page (or new-filter) fetch. Resets pagination + result list.
  // Debounces by 300ms when there's a typed filter so the API isn't
  // hit on every keystroke; runs immediately for the initial empty
  // search so the popular grid is visible without a delay.
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(
      async () => {
        setBusy(true);
        setErr(null);
        try {
          const qp = new URLSearchParams();
          if (query) qp.set("query", query);
          if (gameVersion) qp.set("gameVersion", gameVersion);
          qp.set("projectType", "modpack");
          qp.set("limit", String(PAGE_SIZE));
          qp.set("offset", "0");
          const res = await api.get<any>(
            `/integrations/${provider}/search?${qp.toString()}`
          );
          if (cancelled) return;
          const raw: any[] = Array.isArray(res)
            ? res
            : (res.results ?? []);
          setResults(raw.map(mapHit));
          setHasMore(raw.length >= PAGE_SIZE);
        } catch (e) {
          if (!cancelled)
            setErr(e instanceof ApiError ? e.message : String(e));
        } finally {
          if (!cancelled) setBusy(false);
        }
      },
      query || gameVersion ? 300 : 0
    );
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [provider, query, gameVersion]);

  // Append the next page when the bottom sentinel hits the viewport.
  // De-dupes against existing results in case the upstream returns
  // overlapping entries on offset (CurseForge does this occasionally).
  async function loadMore(): Promise<void> {
    if (loadingMore || busy || !hasMore) return;
    setLoadingMore(true);
    setErr(null);
    try {
      const qp = new URLSearchParams();
      if (query) qp.set("query", query);
      if (gameVersion) qp.set("gameVersion", gameVersion);
      qp.set("projectType", "modpack");
      qp.set("limit", String(PAGE_SIZE));
      qp.set("offset", String(results.length));
      const res = await api.get<any>(
        `/integrations/${provider}/search?${qp.toString()}`
      );
      const raw: any[] = Array.isArray(res) ? res : (res.results ?? []);
      const seen = new Set(results.map((r) => `${r.provider}:${r.id}`));
      const fresh = raw.map(mapHit).filter(
        (r) => !seen.has(`${r.provider}:${r.id}`)
      );
      setResults((prev) => [...prev, ...fresh]);
      setHasMore(raw.length >= PAGE_SIZE);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="tile p-7 space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="heading-md">
          {provider === "modrinth" ? "Modrinth" : "CurseForge"} ·{" "}
          {t("wizard.source")}
        </h2>
        {busy && (
          <span className="text-xs text-ink-muted">
            {t("content.browse.searching")}
          </span>
        )}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-[1fr_220px] gap-3">
        <div className="relative">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted"
          />
          <input
            className="input pl-8"
            placeholder={t("wizard.modpack.search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        </div>
        <input
          className="input"
          placeholder={t("content.browse.mcVersion")}
          value={gameVersion}
          onChange={(e) => setGameVersion(e.target.value)}
        />
      </div>
      {err && <div className="chip chip-danger !h-auto !py-2 !px-3">{err}</div>}

      {/* Selected-pack summary lives ABOVE the grid (and is sticky)
          so it stays in view as the user scrolls through results.
          Earlier it sat after the grid, but with infinite scroll
          loading more rows underneath it kept slipping further away
          from the user's eyeline. Sticky-top sits just below the
          panel's TopNav (h-14 sticky-0) so the card never tucks
          underneath the navigation chrome. */}
      {pack && (
        <div className="sticky top-16 z-10">
          <div className="tile p-4 flex items-center gap-3 border-[rgb(var(--accent))]/40 backdrop-blur bg-[rgb(var(--bg-surface-1))]/95">
            {pack.iconUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={pack.iconUrl}
                alt=""
                className="w-10 h-10 rounded-md object-cover shrink-0"
              />
            ) : (
              <span className="w-10 h-10 rounded-md bg-surface-2 text-ink-secondary grid place-items-center shrink-0">
                <Package size={18} />
              </span>
            )}
            <div className="flex-1 min-w-0">
              <div className="text-xs text-ink-muted">
                {t("wizard.modpack.selected")}
              </div>
              <div className="font-medium truncate">{pack.name}</div>
              <div className="text-xs text-ink-muted truncate">
                {packVersion?.label ?? t("wizard.packVersion.latest")}
              </div>
            </div>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setPreview(pack)}
            >
              {t("wizard.modpack.changeVersion")}
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {results.map((r) => {
          const active = pack?.id === r.id;
          return (
            <button
              key={r.id}
              type="button"
              onClick={() => setPreview(r)}
              className={cn(
                "tile text-left p-4 flex gap-3 transition-all",
                active
                  ? "ring-2 ring-[rgb(var(--accent))]/50 border-[rgb(var(--accent))]/60"
                  : "hover:border-line-strong hover:bg-surface-2"
              )}
            >
              {r.iconUrl ? (
                <img
                  src={r.iconUrl}
                  alt=""
                  className="w-12 h-12 rounded-md object-cover shrink-0"
                />
              ) : (
                <span className="w-12 h-12 rounded-md bg-surface-2 text-ink-secondary grid place-items-center shrink-0">
                  <Package size={20} />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <div className="font-medium truncate">{r.name}</div>
                  {active && <Check size={14} className="text-accent" />}
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
            </button>
          );
        })}
      </div>
      {results.length === 0 && !busy && (
        <div className="text-center text-sm text-ink-muted py-8">
          {query
            ? "No results. Try a different search."
            : "No packs available."}
        </div>
      )}

      {/* Bottom-of-grid sentinel — same infinite-scroll pattern the
          server-content browse panel uses, so the wizard's pack
          picker also keeps loading pages as the user scrolls
          instead of capping at the first 24 results. */}
      {results.length > 0 && hasMore && (
        <ModpackInfiniteSentinel
          onVisible={loadMore}
          disabled={loadingMore || busy}
          loading={loadingMore}
        />
      )}

      <ContentDetailDrawer
        open={preview !== null}
        onClose={() => setPreview(null)}
        provider={provider}
        projectId={preview?.id ?? ""}
        initial={
          preview
            ? {
                name: preview.name,
                iconUrl: preview.iconUrl,
                description: preview.description,
                pageUrl: preview.pageUrl,
                author: preview.author,
                downloads: preview.downloads,
              }
            : undefined
        }
        actionLabel={t("wizard.modpack.use")}
        onInstall={
          preview
            ? () => {
                onPick(preview);
                onPickVersion(pendingVersion);
                setPreview(null);
              }
            : undefined
        }
        extra={
          preview ? (
            <PackVersionPicker
              provider={provider}
              pack={preview}
              value={
                preview.id === pack?.id
                  ? (pendingVersion ?? packVersion)
                  : pendingVersion
              }
              onPick={setPendingVersion}
            />
          ) : null
        }
      />
    </div>
  );
}

type VersionOption = {
  id: string;
  label: string;
  gameVersions: string[];
  loaders: string[];
  /** CF disables auto-download for some modpacks; we surface the
   *  flag here so the picker can warn the user before they hit
   *  "Use this pack" and the install fails inside the container. */
  distributionBlocked?: boolean;
};

/**
 * Load published versions for the currently-picked pack and let the user
 * pin one. Default "Latest" maps to versionId=null, which drops
 * CF_FILE_ID / MODRINTH_VERSION and lets itzg pick the newest upload.
 * Pinning protects against the "new pack version broke compat" case
 * where e.g. one mod jumped a major version faster than the rest of the
 * pack and breaks boot on older MC releases.
 */
function PackVersionPicker({
  provider,
  pack,
  value,
  onPick,
}: {
  provider: "modrinth" | "curseforge";
  pack: ModpackHit;
  value:
    | { id: string; label: string; gameVersion?: string; loader?: string }
    | null;
  onPick: (
    v:
      | { id: string; label: string; gameVersion?: string; loader?: string }
      | null
  ) => void;
}): JSX.Element {
  const { t } = useT();
  const [versions, setVersions] = useState<VersionOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    api
      .get<any[]>(
        `/integrations/${provider}/projects/${encodeURIComponent(pack.id)}/versions`
      )
      .then((raw) => {
        if (cancelled) return;
        const list: VersionOption[] = (raw ?? []).map((v) => ({
          id: String(v.id),
          label: String(v.versionNumber ?? v.name ?? v.id),
          gameVersions: Array.isArray(v.gameVersions) ? v.gameVersions : [],
          loaders: Array.isArray(v.loaders) ? v.loaders : [],
          distributionBlocked: Boolean(v.distributionBlocked),
        }));
        setVersions(list);
        // Auto-fill the "Latest" selection with metadata from the
        // newest version. Without this, downstream consumers see no
        // gameVersion/loader and can't make compatibility decisions
        // (the dynmap auto-install would happily pick latest dynmap
        // for the wrong MC version).
        const latest = list[0];
        if (latest && (!value || (value.id === "" && !value.gameVersion))) {
          onPick({
            id: "",
            label: "Latest",
            gameVersion: latest.gameVersions[0],
            loader: latest.loaders[0],
          });
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setErr(e instanceof ApiError ? e.message : String(e));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [provider, pack.id]);

  const selected = value?.id ?? "";

  return (
    <div className="tile !shadow-none p-4 space-y-3 border-[rgb(var(--accent))]/40">
      <div className="flex items-center gap-2 text-sm">
        <span className="font-medium">{t("wizard.packVersion")}</span>
        {loading && (
          <span className="text-xs text-ink-muted">
            {t("common.loading")}
          </span>
        )}
      </div>
      <select
        className="select"
        value={selected}
        onChange={(e) => {
          const id = e.target.value;
          if (!id) {
            // "Latest" — keep metadata from the newest version so
            // dynmap install can pick a compatible build.
            const latest = versions[0];
            onPick(
              latest
                ? {
                    id: "",
                    label: "Latest",
                    gameVersion: latest.gameVersions[0],
                    loader: latest.loaders[0],
                  }
                : null
            );
            return;
          }
          const v = versions.find((x) => x.id === id);
          if (v)
            onPick({
              id: v.id,
              label: v.label,
              gameVersion: v.gameVersions[0],
              loader: v.loaders[0],
            });
        }}
      >
        <option value="">{t("wizard.packVersion.latest")}</option>
        {versions.map((v) => (
          <option key={v.id} value={v.id}>
            {v.distributionBlocked ? "⚠ " : ""}
            {v.label}
            {v.gameVersions[0] ? ` · MC ${v.gameVersions[0]}` : ""}
            {v.loaders[0] ? ` · ${v.loaders[0]}` : ""}
            {v.distributionBlocked ? " · " + t("wizard.packVersion.blocked") : ""}
          </option>
        ))}
      </select>
      {(() => {
        const sel = versions.find((v) => v.id === selected);
        if (sel?.distributionBlocked) {
          return (
            <div className="text-xs text-[rgb(var(--warning))] leading-relaxed">
              {t("wizard.packVersion.blockedHint")}
            </div>
          );
        }
        return null;
      })()}
      {err && (
        <div className="text-xs text-[rgb(var(--danger))]">{err}</div>
      )}
      <p className="text-xs text-ink-muted leading-relaxed">
        {t("wizard.packVersion.hint")}
      </p>
    </div>
  );
}

function ResourcesStep({
  nodes,
  name,
  setName,
  description,
  setDescription,
  nodeId,
  setNodeId,
  memoryMb,
  setMemoryMb,
  hostPort,
  setHostPort,
  env,
  setEnv,
  currentType,
  iconDataUrl,
  setIconDataUrl,
}: {
  nodes: Node[];
  name: string;
  setName: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
  nodeId: string;
  setNodeId: (v: string) => void;
  memoryMb: number;
  setMemoryMb: (v: number) => void;
  hostPort: number;
  setHostPort: (v: number) => void;
  env: Record<string, string>;
  setEnv: (v: Record<string, string>) => void;
  currentType: string;
  iconDataUrl: string | null;
  setIconDataUrl: (v: string | null) => void;
}): JSX.Element {
  const { t } = useT();
  return (
    <div className="space-y-5">
      <div className="tile p-7 space-y-5">
        <h2 className="heading-md">{t("wizard.step.basics")}</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label={t("wizard.name")}>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label={t("wizard.description")}>
            <input
              className="input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label={t("tile.node")}>
            <select
              className="select"
              value={nodeId}
              onChange={(e) => setNodeId(e.target.value)}
            >
              <option value="">— {t("common.loading").replace("…", "")}—</option>
              {nodes.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name} ({n.status})
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("wizard.resources.port")}>
            <input
              className="input"
              type="number"
              min={1}
              max={65535}
              value={hostPort}
              onChange={(e) => setHostPort(Number(e.target.value))}
            />
          </Field>
        </div>
        <Field label={t("wizard.resources.memory")}>
          <div className="pt-1">
            <MemorySlider
              value={memoryMb}
              onChange={setMemoryMb}
              min={512}
              max={32768}
              step={512}
            />
          </div>
        </Field>
        <Field
          label={t("wizard.resources.java")}
          hint={t("wizard.resources.javaHint")}
        >
          <select
            className="select"
            value={env.__COFEMINE_JAVA_VERSION ?? "auto"}
            onChange={(e) => {
              const v = e.target.value;
              const next = { ...env };
              if (v === "auto") {
                delete next.__COFEMINE_JAVA_VERSION;
              } else {
                next.__COFEMINE_JAVA_VERSION = v;
              }
              setEnv(next);
            }}
          >
            <option value="auto">{t("wizard.resources.javaAuto")}</option>
            <option value="8">Java 8 (1.7 – 1.16)</option>
            <option value="17">Java 17 (1.18 – 1.20.4)</option>
            <option value="21">Java 21 (1.20.5+, recommended)</option>
          </select>
        </Field>
      </div>

      <div className="tile p-7 space-y-5">
        <div>
          <h2 className="heading-md">{t("wizard.icon")}</h2>
          <p className="text-sm text-ink-muted mt-1">
            {t("wizard.iconHint")}
          </p>
        </div>
        <ImageUpload
          value={iconDataUrl}
          onChange={setIconDataUrl}
          targetSize={64}
          previewSize={80}
          shape="square"
        />
      </div>

      <div className="tile p-7 space-y-5">
        <div>
          <h2 className="heading-md">{t("wizard.env")}</h2>
        </div>
        <EnvForm env={env} onChange={setEnv} currentType={currentType} />
      </div>
    </div>
  );
}

function ReviewStep({
  type,
  name,
  version,
  memoryMb,
  hostPort,
  nodeName,
  envCount,
  pack,
  packLoader,
  eula,
  onEula,
  installDynmap,
  onInstallDynmap,
  err,
}: {
  type: ServerTypeKey;
  name: string;
  version: string;
  memoryMb: number;
  hostPort: number;
  nodeName?: string;
  envCount: number;
  pack: ModpackHit | null;
  /** Resolved loader from the picked modpack version. For modpack
   *  servers `type` is just MODRINTH/CURSEFORGE — the actual loader
   *  is whatever the pack uses, and that's what determines which
   *  Dynmap variant we'd install. */
  packLoader: string | null;
  eula: boolean;
  onEula: (v: boolean) => void;
  installDynmap: boolean;
  onInstallDynmap: (v: boolean) => void;
  err: string | null;
}): JSX.Element {
  const { t } = useT();
  return (
    <div className="tile p-7 space-y-6">
      <div className="rounded-xl overflow-hidden">
        <ServerTypeHero type={type} height={128} glyphSize={60}>
          <div className="absolute left-5 bottom-4 text-left">
            <div className="text-xs uppercase tracking-widest opacity-80">
              {getServerMeta(type).label}
            </div>
            <div className="font-semibold text-2xl">{name}</div>
          </div>
        </ServerTypeHero>
      </div>

      {pack && (
        <div className="tile !shadow-none p-4 flex items-center gap-3">
          {pack.iconUrl && (
            <img
              src={pack.iconUrl}
              alt=""
              className="w-10 h-10 rounded-md object-cover shrink-0"
            />
          )}
          <div className="min-w-0 flex-1">
            <div className="text-xs uppercase tracking-wider text-ink-muted">
              {t("content.browse.kind.modpack")}
            </div>
            <div className="font-medium truncate">{pack.name}</div>
          </div>
        </div>
      )}

      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3 text-sm">
        <ReviewRow label={t("wizard.version")}>{version}</ReviewRow>
        <ReviewRow label={t("wizard.resources.memory")}>{memoryMb} MB</ReviewRow>
        <ReviewRow label={t("wizard.resources.port")}>{hostPort}</ReviewRow>
        <ReviewRow label={t("tile.node")}>{nodeName ?? "—"}</ReviewRow>
        <ReviewRow label={t("server.overview.env")}>{envCount}</ReviewRow>
      </dl>

      <div className="divider" />

      <label className="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          checked={eula}
          onChange={(e) => onEula(e.target.checked)}
          className="mt-1"
        />
        <span>
          {t("wizard.eula")} —{" "}
          <a
            className="link"
            href="https://www.minecraft.net/en-us/eula"
            target="_blank"
            rel="noreferrer"
          >
            Minecraft EULA
          </a>
        </span>
      </label>

      {/* Auto-install Dynmap. Hidden for Vanilla — vanilla can't load
          plugins/mods, so the option would silently no-op. */}
      {dynmapTargetFor(type, packLoader) && (
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={installDynmap}
            onChange={(e) => onInstallDynmap(e.target.checked)}
            className="mt-1"
          />
          <span>
            <span className="font-medium">{t("wizard.dynmap.label")}</span>
            <br />
            <span className="text-xs text-ink-muted leading-relaxed">
              {t("wizard.dynmap.hint")}
            </span>
          </span>
        </label>
      )}

      {err && <div className="chip chip-danger !h-auto !py-2 !px-3">{err}</div>}
    </div>
  );
}

type DynmapTarget = {
  slug: string;
  /** Modrinth project_type — controls where the install endpoint
   *  drops the jar. "plugin" goes into plugins/, "mod" into mods/. */
  kind: "plugin" | "mod";
};

/**
 * Pick the right Modrinth project + content kind for the live web
 * map. Tries dynmap first (proven, well-supported on Bukkit-family),
 * but for the mod loaders (Forge / NeoForge / Fabric / Quilt) where
 * dynmap's release cadence often lags newer MC versions, we hand
 * over to BlueMap — its single jar covers Forge/NeoForge/Fabric and
 * tends to land 1.21.x support before dynmap does.
 *
 * Modrinth projects:
 *   dynmap          (kind: plugin) — Bukkit / Paper / Spigot / Purpur / Mohist
 *   bluemap         (kind: mod)    — Forge / NeoForge / Fabric / Quilt
 *
 * Returns null for loaders we don't know how to map (Vanilla, or
 * a modpack without a resolved loader yet) so the wizard hides the
 * toggle.
 */
function dynmapTargetFor(
  type: ServerTypeKey,
  packLoader?: string | null
): DynmapTarget | null {
  switch (type) {
    case "PAPER":
    case "PURPUR":
    case "MOHIST":
      return { slug: "dynmap", kind: "plugin" };
    case "FORGE":
    case "NEOFORGE":
    case "FABRIC":
    case "QUILT":
      return { slug: "bluemap", kind: "mod" };
  }
  const loader = packLoader?.toLowerCase();
  if (!loader) return null;
  if (
    loader === "forge" ||
    loader === "neoforge" ||
    loader === "fabric" ||
    loader === "quilt"
  ) {
    return { slug: "bluemap", kind: "mod" };
  }
  if (loader === "paper" || loader === "spigot" || loader === "bukkit") {
    return { slug: "dynmap", kind: "plugin" };
  }
  return null;
}

/**
 * Compute the (gameVersion, loader) pair that downstream installs
 * (e.g. dynmap auto-install) should be filtered against, depending
 * on whether we're creating a plain server or a modpack.
 *
 *   - Plain: the user explicitly picks both the MC version and the
 *     server type (Paper / Forge / etc.), so it's just a typeToLoader
 *     lookup on top of the chosen MC.
 *   - Modpack: the pack version itself dictates both. Whatever was
 *     stored on `packVersion` (auto-filled to the newest version's
 *     metadata when nothing's pinned) is the source of truth.
 */
function resolveRuntimeFilters(
  source: Source,
  effectiveType: ServerTypeKey,
  plainVersion: string,
  packVersion: { gameVersion?: string; loader?: string } | null
): { gameVersion?: string; loader?: string } {
  if (source === "plain") {
    return {
      gameVersion: plainVersion || undefined,
      loader: typeToLoader(effectiveType),
    };
  }
  return {
    gameVersion: packVersion?.gameVersion,
    loader: packVersion?.loader,
  };
}

/**
 * Look up the newest Modrinth version of `slug` that's compatible
 * with the given gameVersion + loader, and return the direct .jar
 * download URL. Returns null when nothing compatible exists — caller
 * surfaces a notice but still creates the server.
 *
 * The endpoint we hit (`/integrations/modrinth/projects/:id/versions`)
 * already does the gameVersion/loader filtering server-side via
 * Modrinth's facets, so versions[0] here is the newest *compatible*
 * build, not the project's newest in absolute terms.
 */
async function resolveModrinthDownloadUrl(
  slug: string,
  gameVersion?: string,
  loader?: string
): Promise<string | null> {
  const qs = new URLSearchParams();
  if (gameVersion) qs.set("gameVersion", gameVersion);
  if (loader) qs.set("loader", loader);
  const versions = await api.get<
    Array<{
      id: string;
      files: Array<{ url: string; filename: string; primary: boolean }>;
    }>
  >(
    `/integrations/modrinth/projects/${encodeURIComponent(
      slug
    )}/versions${qs.toString() ? `?${qs}` : ""}`
  );
  const v = versions[0];
  if (!v) return null;
  // Prefer the file flagged primary; fall back to the first.
  const file = v.files.find((f) => f.primary) ?? v.files[0];
  return file?.url ?? null;
}

function typeToLoader(t: ServerTypeKey): string | undefined {
  switch (t) {
    case "PAPER":
    case "PURPUR":
    case "MOHIST":
      return "paper";
    case "FORGE":
      return "forge";
    case "NEOFORGE":
      return "neoforge";
    case "FABRIC":
      return "fabric";
    case "QUILT":
      return "quilt";
    default:
      return undefined;
  }
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-ink-secondary">{label}</label>
      {children}
      {hint && <div className="text-xs text-ink-muted">{hint}</div>}
    </div>
  );
}

function ReviewRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wider text-ink-muted">
        {label}
      </dt>
      <dd className="text-ink mt-1 font-medium">{children}</dd>
    </div>
  );
}

/** Expose for potential future re-use. */
void ServerTypeIcon;

/**
 * Infinite-scroll sentinel for the wizard's modpack picker. Fires
 * `onVisible` as soon as the bottom row scrolls into view (with a
 * 200px rootMargin so the next page lands before the user reaches
 * the visible bottom). Disabled while a fetch is in flight so the
 * IntersectionObserver doesn't trigger overlapping requests.
 */
function ModpackInfiniteSentinel({
  onVisible,
  disabled,
  loading,
}: {
  onVisible: () => void;
  disabled: boolean;
  loading: boolean;
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
            return;
          }
        }
      },
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
      {loading && (
        <svg
          className="animate-spin"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
        >
          <path d="M21 12a9 9 0 1 1-6.2-8.55" />
        </svg>
      )}
    </div>
  );
}

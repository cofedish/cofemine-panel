"use client";
import { useState, useMemo, useEffect } from "react";
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
import { cn } from "@/lib/cn";
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
      const body: any = {
        name,
        description: description || undefined,
        nodeId,
        type: effectiveType,
        memoryMb: Number(memoryMb),
        ports: [{ host: Number(hostPort), container: 25565, protocol: "tcp" }],
        env,
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
        };
        body.version = "LATEST";
      }
      const res = await api.post<{ id: string }>("/servers", body);
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
    <div className="space-y-8 max-w-5xl">
      <PageHeader
        breadcrumbs={[
          { label: "Dashboard", href: "/" },
          { label: "New server" },
        ]}
        title="Create server"
        description="Servers run as sibling Docker containers using itzg/minecraft-server."
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
                {s}
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
                onPick={setPack}
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
              eula={eula}
              onEula={setEula}
              err={err}
            />
          )}
        </motion.div>
      </AnimatePresence>

      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => (idx === 0 ? router.back() : prev())}
          className="btn btn-ghost"
        >
          <ChevronLeft size={15} /> {idx === 0 ? "Cancel" : "Back"}
        </button>
        {step !== "Review" ? (
          <button
            type="button"
            onClick={next}
            className="btn btn-primary"
            disabled={!canNext}
          >
            Next <ChevronRight size={15} />
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            className="btn btn-primary"
            disabled={busy || !canNext}
          >
            {busy ? "Creating…" : "Create server"}
          </button>
        )}
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
      title: "Plain server",
      desc: "Pick a server type (Vanilla, Paper, Fabric, Forge…) and a MC version. Fast and minimal.",
      meta: "8 types",
      type: "PAPER",
    },
    {
      id: "modrinth",
      title: "Modrinth modpack",
      desc: "Search modpacks on modrinth.com. The runtime auto-detects loader + version from the pack.",
      meta: "auto-detected",
      type: "MODRINTH",
    },
    {
      id: "curseforge",
      title: "CurseForge modpack",
      desc: "Search modpacks on curseforge.com. Requires a CurseForge API key in Integrations.",
      meta: cfEnabled ? "auto-detected" : "needs API key",
      type: "CURSEFORGE",
      disabled: cfEnabled ? undefined : "Configure a CurseForge API key first.",
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
                    <Check size={10} /> Selected
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
  const meta = getServerMeta(type);
  return (
    <div className="tile p-7 space-y-6">
      <div className="space-y-3">
        <h2 className="heading-md">Server type</h2>
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
        <Field label="Minecraft version" hint="Pulled from Mojang launcher manifest">
          <select
            className="select"
            value={version}
            onChange={(e) => onVersion(e.target.value)}
          >
            {versionsLoading && versions.length === 0 && (
              <option>Loading…</option>
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
}: {
  provider: "modrinth" | "curseforge";
  pack: ModpackHit | null;
  onPick: (p: ModpackHit) => void;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const [gameVersion, setGameVersion] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<ModpackHit[]>([]);
  const [err, setErr] = useState<string | null>(null);

  // Fire an initial popular-packs search when the step mounts and any time
  // the user edits the filter. Debounce typing by 300ms so we don't hammer
  // the API on every keystroke.
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
          qp.set("limit", "24");
          const res = await api.get<any>(
            `/integrations/${provider}/search?${qp.toString()}`
          );
          if (cancelled) return;
          const raw: any[] = Array.isArray(res)
            ? res
            : (res.results ?? []);
          setResults(
            raw.map((r) => ({
              id: String(r.id),
              provider,
              name: r.name,
              slug: r.slug,
              description: r.description,
              iconUrl: r.iconUrl,
              author: r.author,
              downloads: r.downloads,
              pageUrl: r.pageUrl,
            }))
          );
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

  return (
    <div className="tile p-7 space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="heading-md">
          Browse {provider === "modrinth" ? "Modrinth" : "CurseForge"} modpacks
        </h2>
        {busy && (
          <span className="text-xs text-ink-muted">Searching…</span>
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
            placeholder="Search by name (type to filter)…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        </div>
        <input
          className="input"
          placeholder="Minecraft version (optional)"
          value={gameVersion}
          onChange={(e) => setGameVersion(e.target.value)}
        />
      </div>
      {err && <div className="chip chip-danger !h-auto !py-2 !px-3">{err}</div>}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {results.map((r) => {
          const active = pack?.id === r.id;
          return (
            <button
              key={r.id}
              type="button"
              onClick={() => onPick(r)}
              className={cn(
                "tile text-left p-4 flex gap-3 transition-all",
                active
                  ? "ring-2 ring-[rgb(var(--accent))]/50 border-[rgb(var(--accent))]/60"
                  : "hover:border-line-strong"
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
}): JSX.Element {
  return (
    <div className="space-y-5">
      <div className="tile p-7 space-y-5">
        <h2 className="heading-md">Basics</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Name">
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="Description (optional)">
            <input
              className="input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Field label="Node">
            <select
              className="select"
              value={nodeId}
              onChange={(e) => setNodeId(e.target.value)}
            >
              <option value="">— select —</option>
              {nodes.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name} ({n.status})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Memory (MB)" hint="container limit">
            <input
              className="input"
              type="number"
              min={512}
              max={65536}
              step={512}
              value={memoryMb}
              onChange={(e) => setMemoryMb(Number(e.target.value))}
            />
          </Field>
          <Field label="Host port" hint="container 25565">
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
      </div>

      <div className="tile p-7 space-y-5">
        <div>
          <h2 className="heading-md">Server configuration</h2>
          <p className="text-sm text-ink-muted mt-1">
            Proper controls for the itzg runtime env vars — difficulty,
            gamemode, MOTD, world generation, mobs, JVM tuning. Expand a
            section to edit its settings.
          </p>
        </div>
        <EnvForm env={env} onChange={setEnv} />
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
  eula,
  onEula,
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
  eula: boolean;
  onEula: (v: boolean) => void;
  err: string | null;
}): JSX.Element {
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
              Modpack
            </div>
            <div className="font-medium truncate">{pack.name}</div>
          </div>
        </div>
      )}

      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3 text-sm">
        <ReviewRow label="Version">{version}</ReviewRow>
        <ReviewRow label="Memory">{memoryMb} MB</ReviewRow>
        <ReviewRow label="Host port">{hostPort}</ReviewRow>
        <ReviewRow label="Node">{nodeName ?? "—"}</ReviewRow>
        <ReviewRow label="Env vars">{envCount} defined</ReviewRow>
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
          I accept the{" "}
          <a
            className="link"
            href="https://www.minecraft.net/en-us/eula"
            target="_blank"
            rel="noreferrer"
          >
            Minecraft EULA
          </a>
          . Required to run any Minecraft server.
        </span>
      </label>

      {err && <div className="chip chip-danger !h-auto !py-2 !px-3">{err}</div>}
    </div>
  );
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

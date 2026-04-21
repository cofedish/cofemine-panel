"use client";
import { useEffect, useState } from "react";
import useSWR from "swr";
import { api, ApiError, fetcher } from "@/lib/api";
import { cn } from "@/lib/cn";
import { Search, Download, Package, Check } from "lucide-react";
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
    curseforge: { enabled: boolean; fallback: string };
  };
};

type Kind = "mod" | "modpack" | "plugin" | "datapack";

export function ServerContent({ serverId }: { serverId: string }): JSX.Element {
  const { data: integ } = useSWR<Integrations>("/integrations", fetcher);
  const [provider, setProvider] = useState<"modrinth" | "curseforge">("modrinth");
  const [query, setQuery] = useState("");
  const [gameVersion, setGameVersion] = useState("");
  const [loader, setLoader] = useState("");
  const [kind, setKind] = useState<Kind>("mod");
  const [results, setResults] = useState<Summary[]>([]);
  const [busy, setBusy] = useState(false);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const cfDisabled = integ ? !integ.providers.curseforge.enabled : true;

  // Auto-search: run on provider/query/filter change with debounce.
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
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setInstallingId(null);
    }
  }

  return (
    <div className="space-y-5">
      {/* Provider switch */}
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

      {/* Filters — live, no explicit button */}
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

      {/* Status line */}
      <div className="flex items-center justify-between min-h-[20px] text-sm">
        <span className="text-ink-muted">
          {busy
            ? "Searching…"
            : `${results.length} result${results.length === 1 ? "" : "s"}`}
        </span>
        {msg && <span className="text-[rgb(var(--success))]">{msg}</span>}
        {err && <span className="text-[rgb(var(--danger))]">{err}</span>}
      </div>

      {/* Results */}
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
          {results.map((r) => (
            <ResultCard
              key={`${r.provider}:${r.id}`}
              r={r}
              installing={installingId === r.id}
              onInstall={() => install(r)}
            />
          ))}
          {!busy && results.length === 0 && (
            <div className="md:col-span-2 tile p-8 text-center text-ink-muted text-sm">
              {query
                ? "Nothing matches. Try a different query."
                : "No results available."}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ResultCard({
  r,
  installing,
  onInstall,
}: {
  r: Summary;
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
        className="btn btn-subtle self-start"
        onClick={onInstall}
        disabled={installing}
      >
        {installing ? "Installing…" : <>Install</>}
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

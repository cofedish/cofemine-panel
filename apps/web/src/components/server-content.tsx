"use client";
import { useState } from "react";
import useSWR from "swr";
import { api, ApiError, fetcher } from "@/lib/api";
import { cn } from "@/lib/cn";

type Summary = {
  id: string;
  provider: "modrinth" | "curseforge";
  name: string;
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

export function ServerContent({ serverId }: { serverId: string }): JSX.Element {
  const { data: integ } = useSWR<Integrations>("/integrations", fetcher);
  const [provider, setProvider] = useState<"modrinth" | "curseforge">("modrinth");
  const [query, setQuery] = useState("");
  const [gameVersion, setGameVersion] = useState("");
  const [loader, setLoader] = useState("");
  const [kind, setKind] = useState<"mod" | "modpack" | "plugin" | "datapack">(
    "mod"
  );
  const [results, setResults] = useState<Summary[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const cfDisabled = integ ? !integ.providers.curseforge.enabled : true;

  async function search(): Promise<void> {
    setBusy(true);
    setMsg(null);
    try {
      const url = `/integrations/${provider}/search?` + new URLSearchParams({
        query,
        ...(gameVersion ? { gameVersion } : {}),
        ...(loader ? { loader } : {}),
        projectType: kind,
        limit: "20",
      }).toString();
      const res = await api.get<any>(url);
      const items: Summary[] = Array.isArray(res) ? res : res.results ?? [];
      setResults(items);
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function install(projectId: string | number): Promise<void> {
    setBusy(true);
    setMsg(null);
    try {
      const endpoint = `/integrations/servers/${serverId}/install/${provider}`;
      const body =
        provider === "modrinth"
          ? { projectId, kind }
          : { projectId: Number(projectId), kind };
      await api.post(endpoint, body);
      setMsg(
        kind === "modpack"
          ? "Modpack applied. Restart the server to let it fetch and apply."
          : "Installed. Restart the server to load it."
      );
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <ProviderPill
          name="Modrinth"
          active={provider === "modrinth"}
          onClick={() => setProvider("modrinth")}
          disabled={!integ?.providers.modrinth.enabled}
        />
        <ProviderPill
          name="CurseForge"
          active={provider === "curseforge"}
          onClick={() => setProvider("curseforge")}
          disabled={cfDisabled}
          hint={cfDisabled ? "API key required (Integrations)" : undefined}
        />
      </div>
      <div className="card p-5 grid grid-cols-5 gap-3">
        <input
          className="input col-span-2"
          placeholder="Search…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") search();
          }}
        />
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
          onChange={(e) => setKind(e.target.value as any)}
        >
          <option value="mod">mod</option>
          <option value="modpack">modpack</option>
          <option value="plugin">plugin</option>
          <option value="datapack">datapack</option>
        </select>
        <button
          className="btn-primary col-span-5"
          onClick={search}
          disabled={busy}
        >
          Search
        </button>
      </div>
      {msg && <div className="text-sm text-ink-secondary">{msg}</div>}
      <div className="grid grid-cols-2 gap-3">
        {results.map((r) => (
          <div key={r.id} className="card p-4 flex gap-3">
            {r.iconUrl && (
              <img
                src={r.iconUrl}
                alt=""
                className="w-12 h-12 rounded object-cover flex-shrink-0"
              />
            )}
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate">{r.name}</div>
              <div className="text-xs text-ink-secondary mt-0.5 line-clamp-2">
                {r.description}
              </div>
              <div className="text-xs text-ink-muted mt-2">
                by {r.author ?? "—"} · {r.downloads?.toLocaleString() ?? 0} dls
              </div>
            </div>
            <button
              className="btn-primary self-start"
              onClick={() => install(r.id)}
            >
              Install
            </button>
          </div>
        ))}
      </div>
      {cfDisabled && provider === "curseforge" && (
        <div className="card p-5 text-sm text-ink-secondary">
          CurseForge requires an API key. Go to <b>Integrations</b> and paste
          one in. Without a key, CurseForge mods can be installed manually by
          uploading the JAR to the <code>mods/</code> folder in the File
          manager.
        </div>
      )}
    </div>
  );
}

function ProviderPill({
  name,
  active,
  onClick,
  disabled,
  hint,
}: {
  name: string;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  hint?: string;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={hint}
      className={cn(
        "px-3 py-1.5 rounded-full text-sm border",
        active
          ? "bg-accent-soft border-accent/40 text-accent"
          : "bg-surface-2 border-line text-ink-secondary",
        disabled && "opacity-40 cursor-not-allowed"
      )}
    >
      {name}
    </button>
  );
}

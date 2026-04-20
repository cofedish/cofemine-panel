"use client";
import useSWR, { mutate } from "swr";
import { useState } from "react";
import { api, ApiError, fetcher } from "@/lib/api";

type Integrations = {
  providers: {
    modrinth: { enabled: boolean };
    curseforge: { enabled: boolean; fallback: string };
  };
  settings: Array<{ key: string; updatedAt: string }>;
};

export default function IntegrationsPage(): JSX.Element {
  const { data } = useSWR<Integrations>("/integrations", fetcher);
  const [cfKey, setCfKey] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  async function save(): Promise<void> {
    setMsg(null);
    try {
      await api.patch(`/integrations/curseforge.apiKey`, { value: cfKey });
      setCfKey("");
      setMsg("CurseForge API key saved.");
      mutate("/integrations");
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function clear(): Promise<void> {
    await api.del(`/integrations/curseforge.apiKey`);
    mutate("/integrations");
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Integrations</h1>

      <div className="card p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-medium">Modrinth</h2>
            <p className="text-sm text-ink-secondary">
              Public API. No configuration required.
            </p>
          </div>
          <span className="badge bg-accent-soft text-accent">
            {data?.providers.modrinth.enabled ? "enabled" : "disabled"}
          </span>
        </div>
      </div>

      <div className="card p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-medium">CurseForge</h2>
            <p className="text-sm text-ink-secondary">
              Requires an API key from{" "}
              <a
                className="text-accent underline"
                href="https://console.curseforge.com/"
                target="_blank"
                rel="noreferrer"
              >
                console.curseforge.com
              </a>
              . Without a key, the panel falls back to manual ZIP upload via
              the File manager.
            </p>
          </div>
          <span
            className={`badge ${data?.providers.curseforge.enabled ? "bg-accent-soft text-accent" : "bg-surface-2 text-ink-secondary"}`}
          >
            {data?.providers.curseforge.enabled ? "enabled" : "disabled"}
          </span>
        </div>
        <div className="flex gap-2">
          <input
            className="input"
            placeholder="Paste CurseForge API key"
            value={cfKey}
            onChange={(e) => setCfKey(e.target.value)}
          />
          <button className="btn-primary" disabled={!cfKey} onClick={save}>
            Save
          </button>
          {data?.providers.curseforge.enabled && (
            <button className="btn-ghost" onClick={clear}>
              Clear
            </button>
          )}
        </div>
        {msg && <div className="text-sm text-ink-secondary">{msg}</div>}
      </div>
    </div>
  );
}

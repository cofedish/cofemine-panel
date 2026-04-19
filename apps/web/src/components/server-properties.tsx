"use client";
import useSWR, { mutate } from "swr";
import { useState } from "react";
import { api, fetcher } from "@/lib/api";

type Props = {
  raw: string;
  parsed: Record<string, string>;
};

const COMMON_KEYS = [
  "motd",
  "max-players",
  "difficulty",
  "gamemode",
  "pvp",
  "online-mode",
  "view-distance",
  "simulation-distance",
  "level-seed",
  "level-type",
  "white-list",
  "spawn-protection",
];

export function ServerProperties({ serverId }: { serverId: string }): JSX.Element {
  const { data } = useSWR<Props>(`/servers/${serverId}/properties`, fetcher);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  if (!data) return <div className="text-zinc-500">Loading…</div>;

  const merged = { ...data.parsed, ...edits };
  const keys = Array.from(
    new Set([...COMMON_KEYS, ...Object.keys(merged)])
  );

  async function save(): Promise<void> {
    setBusy(true);
    try {
      await api.put(`/servers/${serverId}/properties`, {
        properties: edits,
      });
      setEdits({});
      mutate(`/servers/${serverId}/properties`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">server.properties</h3>
        <button
          className="btn-primary"
          disabled={busy || Object.keys(edits).length === 0}
          onClick={save}
        >
          Save changes
        </button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {keys.map((k) => (
          <div key={k} className="space-y-1">
            <label className="text-xs text-zinc-400 font-mono">{k}</label>
            <input
              className="input"
              value={merged[k] ?? ""}
              onChange={(e) =>
                setEdits((prev) => ({ ...prev, [k]: e.target.value }))
              }
            />
          </div>
        ))}
      </div>
      <div className="text-xs text-zinc-500">
        Editing here updates the file directly. Most changes take effect on
        next restart.
      </div>
    </div>
  );
}

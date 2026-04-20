"use client";
import useSWR, { mutate } from "swr";
import { useState } from "react";
import { api, ApiError, fetcher } from "@/lib/api";

type Backup = {
  id: string;
  name: string;
  sizeBytes: string | null;
  status: string;
  path: string | null;
  createdAt: string;
  finishedAt: string | null;
};

export function ServerBackups({ serverId }: { serverId: string }): JSX.Element {
  const { data } = useSWR<Backup[]>(
    `/servers/${serverId}/backups`,
    fetcher,
    { refreshInterval: 5000 }
  );
  const [busy, setBusy] = useState(false);

  async function create(): Promise<void> {
    setBusy(true);
    try {
      await api.post(`/servers/${serverId}/backups`, {});
      mutate(`/servers/${serverId}/backups`);
    } catch (err) {
      alert(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function restore(id: string): Promise<void> {
    if (!confirm("Restore this backup? The current world will be replaced.")) return;
    await api.post(`/backups/${id}/restore`);
    alert("Restore complete. Start the server to use it.");
  }

  async function remove(id: string): Promise<void> {
    if (!confirm("Delete this backup?")) return;
    await api.del(`/backups/${id}`);
    mutate(`/servers/${serverId}/backups`);
  }

  return (
    <div className="card">
      <div className="flex items-center justify-between px-4 py-3 border-b border-line">
        <h3 className="font-medium">Backups</h3>
        <button className="btn-primary" onClick={create} disabled={busy}>
          {busy ? "Creating…" : "Create backup"}
        </button>
      </div>
      {data && data.length > 0 ? (
        <ul className="divide-y divide-line">
          {data.map((b) => (
            <li
              key={b.id}
              className="px-4 py-3 flex items-center gap-4 text-sm"
            >
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">{b.name}</div>
                <div className="text-xs text-ink-muted">
                  {new Date(b.createdAt).toLocaleString()} ·{" "}
                  {b.sizeBytes
                    ? `${(Number(b.sizeBytes) / 1024 / 1024).toFixed(1)} MB`
                    : "—"}
                </div>
              </div>
              <span className="badge badge-muted">{b.status}</span>
              <button
                className="text-xs hover:underline"
                onClick={() => restore(b.id)}
                disabled={b.status !== "success"}
              >
                restore
              </button>
              <button
                className="text-xs text-danger hover:underline"
                onClick={() => remove(b.id)}
              >
                delete
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="p-10 text-center text-ink-muted">
          No backups yet. Click <b>Create backup</b> to snapshot the world + configs.
        </div>
      )}
    </div>
  );
}

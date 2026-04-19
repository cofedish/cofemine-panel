"use client";
import useSWR, { mutate } from "swr";
import { useState } from "react";
import { api, fetcher } from "@/lib/api";

type Schedule = {
  id: string;
  name: string;
  cron: string;
  action: string;
  payload: Record<string, unknown> | null;
  enabled: boolean;
  lastRunAt: string | null;
};

export function ServerSchedules({
  serverId,
}: {
  serverId: string;
}): JSX.Element {
  const { data } = useSWR<Schedule[]>(
    `/servers/${serverId}/schedules`,
    fetcher
  );
  const [name, setName] = useState("nightly-backup");
  const [cron, setCron] = useState("0 4 * * *");
  const [action, setAction] = useState<"backup" | "restart" | "command" | "announce">(
    "backup"
  );
  const [payload, setPayload] = useState("");

  async function create(): Promise<void> {
    const body: any = { name, cron, action, enabled: true };
    if (action === "command") body.payload = { command: payload };
    if (action === "announce") body.payload = { message: payload };
    await api.post(`/servers/${serverId}/schedules`, body);
    mutate(`/servers/${serverId}/schedules`);
  }

  async function remove(id: string): Promise<void> {
    await api.del(`/schedules/${id}`);
    mutate(`/servers/${serverId}/schedules`);
  }

  return (
    <div className="space-y-4">
      <div className="card p-5 space-y-3">
        <h3 className="font-medium">New schedule</h3>
        <div className="grid grid-cols-4 gap-3">
          <input
            className="input"
            placeholder="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            className="input font-mono"
            placeholder="0 4 * * *"
            value={cron}
            onChange={(e) => setCron(e.target.value)}
          />
          <select
            className="select"
            value={action}
            onChange={(e) => setAction(e.target.value as any)}
          >
            <option value="backup">backup</option>
            <option value="restart">restart</option>
            <option value="command">command</option>
            <option value="announce">announce</option>
          </select>
          <input
            className="input"
            placeholder={
              action === "command"
                ? "say hi"
                : action === "announce"
                ? "Server restart in 5 min"
                : ""
            }
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
            disabled={action !== "command" && action !== "announce"}
          />
        </div>
        <button className="btn-primary" onClick={create}>
          Add schedule
        </button>
      </div>

      <div className="card">
        <div className="px-4 py-3 border-b border-surface-border font-medium">
          Active schedules
        </div>
        {data && data.length > 0 ? (
          <ul className="divide-y divide-surface-border">
            {data.map((s) => (
              <li
                key={s.id}
                className="px-4 py-3 flex items-center gap-4 text-sm"
              >
                <div className="flex-1">
                  <div className="font-medium">{s.name}</div>
                  <div className="text-xs text-zinc-500 font-mono">
                    {s.cron} · {s.action}
                    {s.payload ? ` · ${JSON.stringify(s.payload)}` : ""}
                  </div>
                </div>
                <span className="badge bg-surface-3 text-zinc-300">
                  {s.enabled ? "enabled" : "disabled"}
                </span>
                <button
                  className="text-xs text-danger hover:underline"
                  onClick={() => remove(s.id)}
                >
                  remove
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="p-6 text-center text-zinc-500 text-sm">
            No schedules. Common example: <code>0 4 * * *</code> for nightly backups.
          </div>
        )}
      </div>
    </div>
  );
}

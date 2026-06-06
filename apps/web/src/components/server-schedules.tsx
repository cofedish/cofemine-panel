"use client";
import useSWR, { mutate } from "swr";
import { useState } from "react";
import { api, fetcher } from "@/lib/api";
import { useT } from "@/lib/i18n";

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
  const { t } = useT();
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
  // Backup retention — number of recent scheduled archives to keep on
  // disk. The scheduler reads this from payload.keep on each run and
  // deletes anything older. Empty / 0 → falls back to env var or
  // hard-coded default (24 = one day at hourly cadence).
  const [backupKeep, setBackupKeep] = useState("24");

  async function create(): Promise<void> {
    const body: any = { name, cron, action, enabled: true };
    if (action === "command") body.payload = { command: payload };
    if (action === "announce") body.payload = { message: payload };
    if (action === "backup") {
      const n = parseInt(backupKeep, 10);
      if (Number.isFinite(n) && n > 0) body.payload = { keep: n };
    }
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
        <h3 className="font-medium">{t("schedules.add")}</h3>
        <div className="grid grid-cols-4 gap-3">
          <input
            className="input"
            placeholder={t("schedules.name")}
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
          {action === "backup" ? (
            <input
              className="input"
              type="number"
              min={1}
              max={1000}
              placeholder={t("schedules.backupKeepPlaceholder")}
              value={backupKeep}
              onChange={(e) => setBackupKeep(e.target.value)}
              title={t("schedules.backupKeepHelp")}
            />
          ) : (
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
          )}
        </div>
        {action === "backup" && (
          <p className="text-xs text-ink-muted">
            {t("schedules.backupKeepHelp")}
          </p>
        )}
        <button className="btn-primary" onClick={create}>
          {t("schedules.add")}
        </button>
      </div>

      <div className="card">
        <div className="px-4 py-3 border-b border-line font-medium">
          {t("schedules.title")}
        </div>
        {data && data.length > 0 ? (
          <ul className="divide-y divide-line">
            {data.map((s) => (
              <li
                key={s.id}
                className="px-4 py-3 flex items-center gap-4 text-sm"
              >
                <div className="flex-1">
                  <div className="font-medium">{s.name}</div>
                  <div className="text-xs text-ink-muted font-mono">
                    {s.cron} · {s.action}
                    {s.payload ? ` · ${JSON.stringify(s.payload)}` : ""}
                  </div>
                </div>
                <span className="badge badge-muted">
                  {s.enabled
                    ? t("integrations.enabled").toLowerCase()
                    : t("integrations.disabled").toLowerCase()}
                </span>
                <button
                  className="text-xs text-danger hover:underline"
                  onClick={() => remove(s.id)}
                >
                  {t("common.delete").toLowerCase()}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="p-6 text-center text-ink-muted text-sm">
            {t("schedules.empty")}
          </div>
        )}
      </div>
    </div>
  );
}

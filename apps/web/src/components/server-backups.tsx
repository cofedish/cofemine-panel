"use client";
import useSWR, { mutate } from "swr";
import { useState } from "react";
import { api, ApiError, fetcher } from "@/lib/api";
import { useDialog } from "./dialog-provider";
import { useT } from "@/lib/i18n";

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
  const dialog = useDialog();
  const { t } = useT();
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
      dialog.alert({
        tone: "danger",
        title: t("common.error"),
        message: err instanceof ApiError ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  }

  async function restore(id: string): Promise<void> {
    const ok = await dialog.confirm({
      tone: "warning",
      title: t("backups.restoreConfirm.title"),
      message: t("backups.restoreConfirm.body"),
    });
    if (!ok) return;
    await api.post(`/backups/${id}/restore`);
    dialog.toast({ tone: "success", message: t("common.done") });
  }

  async function remove(id: string, name: string): Promise<void> {
    const ok = await dialog.confirm({
      tone: "danger",
      danger: true,
      title: t("backups.deleteConfirm.title"),
      message: t("backups.deleteConfirm.body", { name }),
      okLabel: t("common.delete"),
    });
    if (!ok) return;
    await api.del(`/backups/${id}`);
    mutate(`/servers/${serverId}/backups`);
  }

  // Count what a manual prune would actually touch — only scheduled-*
  // success backups, since manual backups are pinned by contract.
  const scheduledCount =
    data?.filter(
      (b) => b.status === "success" && b.name.startsWith("scheduled-")
    ).length ?? 0;

  async function prune(): Promise<void> {
    const keepStr = await dialog.prompt({
      title: t("backups.prune.title"),
      message: t("backups.prune.body", { n: scheduledCount }),
      defaultValue: "24",
      placeholder: "24",
    });
    if (keepStr === null) return;
    const keep = parseInt(keepStr.trim(), 10);
    if (!Number.isFinite(keep) || keep < 0) {
      dialog.alert({
        tone: "danger",
        title: t("common.error"),
        message: t("backups.prune.invalid"),
      });
      return;
    }
    setBusy(true);
    try {
      const res = await api.post<{ pruned: number; freedBytes: number }>(
        `/servers/${serverId}/backups/prune`,
        { keep }
      );
      mutate(`/servers/${serverId}/backups`);
      dialog.toast({
        tone: "success",
        message: t("backups.prune.done", {
          n: res.pruned,
          mb: Math.round(res.freedBytes / 1024 / 1024),
        }),
      });
    } catch (err) {
      dialog.alert({
        tone: "danger",
        title: t("common.error"),
        message: err instanceof ApiError ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="flex items-center justify-between px-4 py-3 border-b border-line">
        <h3 className="font-medium">{t("server.tabs.backups")}</h3>
        <div className="flex items-center gap-2">
          {scheduledCount > 0 && (
            <button
              className="btn-ghost"
              onClick={prune}
              disabled={busy}
              title={t("backups.prune.title")}
            >
              {t("backups.prune.button")} ({scheduledCount})
            </button>
          )}
          <button className="btn-primary" onClick={create} disabled={busy}>
            {busy ? t("backups.creating") : t("backups.create")}
          </button>
        </div>
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
                {t("backups.restore").toLowerCase()}
              </button>
              <button
                className="text-xs text-danger hover:underline"
                onClick={() => remove(b.id, b.name)}
              >
                {t("backups.delete").toLowerCase()}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="p-10 text-center text-ink-muted">
          {t("backups.empty")}
        </div>
      )}
    </div>
  );
}

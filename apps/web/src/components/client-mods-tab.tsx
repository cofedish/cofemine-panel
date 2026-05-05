"use client";
import { useRef, useState } from "react";
import useSWR, { mutate } from "swr";
import {
  Upload,
  Loader2,
  Trash2,
  Download,
  PackageOpen,
  Link2,
  Link2Off,
  RotateCw,
  Copy,
  Check,
} from "lucide-react";
import { api, ApiError, fetcher } from "@/lib/api";
import { useDialog } from "./dialog-provider";
import { useT } from "@/lib/i18n";

/**
 * Per-server staging area for client-only mods (shaders, minimaps,
 * Iris/Sodium, Distant Horizons, JEI client extras…). Files uploaded
 * here are NEVER installed on the server — they live in /data/.cofemine
 * -client/mods/ which itzg's mod scanner ignores. They get bundled
 * into the .mrpack export so a friend importing the pack into Prism
 * Launcher gets a complete client install.
 *
 * The "Download .mrpack" button at the bottom triggers GET /servers/
 * :id/export-mrpack on the panel, which streams a freshly-built ZIP
 * with the server's mods (under server-overrides/ or overrides/) plus
 * everything in this list (under client-overrides/).
 */

type ClientMod = {
  name: string;
  size: number;
  mtime: string;
};

type DetectedClientMod = {
  modId: number;
  slug?: string;
  title: string;
  filename: string;
  downloadUrl: string;
  icon?: string | null;
  size?: number;
};

export function ClientModsTab({ serverId }: { serverId: string }): JSX.Element {
  const { t } = useT();
  const dialog = useDialog();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<string>("");
  const { data, isLoading } = useSWR<{ mods: ClientMod[] }>(
    `/servers/${serverId}/client-mods`,
    fetcher
  );
  const { data: detected } = useSWR<{ detected: DetectedClientMod[] }>(
    `/servers/${serverId}/client-mods/auto-detect`,
    fetcher,
    { revalidateOnFocus: false }
  );
  const { data: server } = useSWR<{ publicPackToken: string | null }>(
    `/servers/${serverId}`,
    fetcher
  );
  const [linkBusy, setLinkBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const items = data?.mods ?? [];
  const detectedItems = detected?.detected ?? [];
  const publicToken = server?.publicPackToken ?? null;
  const publicUrl = publicToken
    ? `${typeof window !== "undefined" ? window.location.origin : ""}/api/p/${publicToken}.mrpack`
    : null;

  async function enablePublicLink(): Promise<void> {
    setLinkBusy(true);
    try {
      await api.post(`/servers/${serverId}/public-pack-token`);
      mutate(`/servers/${serverId}`);
    } catch (e) {
      dialog.alert({
        tone: "danger",
        title: t("common.error"),
        message: e instanceof ApiError ? e.message : String(e),
      });
    } finally {
      setLinkBusy(false);
    }
  }

  async function rotatePublicLink(): Promise<void> {
    const ok = await dialog.confirm({
      title: t("clientMods.publicLink.confirmRotate.title"),
      message: t("clientMods.publicLink.confirmRotate.body"),
      tone: "warning",
    });
    if (!ok) return;
    await enablePublicLink();
  }

  async function disablePublicLink(): Promise<void> {
    const ok = await dialog.confirm({
      title: t("clientMods.publicLink.confirmDisable.title"),
      message: t("clientMods.publicLink.confirmDisable.body"),
      tone: "warning",
    });
    if (!ok) return;
    setLinkBusy(true);
    try {
      await api.del(`/servers/${serverId}/public-pack-token`);
      mutate(`/servers/${serverId}`);
    } catch (e) {
      dialog.alert({
        tone: "danger",
        title: t("common.error"),
        message: e instanceof ApiError ? e.message : String(e),
      });
    } finally {
      setLinkBusy(false);
    }
  }

  async function copyPublicLink(): Promise<void> {
    if (!publicUrl) return;
    try {
      await navigator.clipboard.writeText(publicUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore — older browsers */
    }
  }

  async function downloadDetected(): Promise<void> {
    if (detectedItems.length === 0) return;
    setUploading(true);
    setProgress(
      t("clientMods.autoDownloading", { n: detectedItems.length })
    );
    try {
      const result = await api.post<{
        results: Array<{ filename: string; ok: boolean; error?: string }>;
      }>(`/servers/${serverId}/client-mods/download`, {
        files: detectedItems.map((d) => ({
          filename: d.filename,
          downloadUrl: d.downloadUrl,
        })),
      });
      const failed = result.results.filter((r) => !r.ok);
      const ok = result.results.length - failed.length;
      mutate(`/servers/${serverId}/client-mods`);
      mutate(`/servers/${serverId}/client-mods/auto-detect`);
      if (failed.length > 0) {
        dialog.toast({
          tone: "warning",
          message: t("clientMods.autoSomeFail", {
            ok,
            n: result.results.length,
          }),
        });
      } else {
        dialog.toast({
          tone: "success",
          message: t("clientMods.autoAllOk", { n: ok }),
        });
      }
    } catch (e) {
      dialog.alert({
        tone: "danger",
        title: t("common.error"),
        message: e instanceof ApiError ? e.message : String(e),
      });
    } finally {
      setUploading(false);
      setProgress("");
    }
  }

  async function uploadFiles(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      let i = 0;
      for (const f of Array.from(files)) {
        i++;
        setProgress(t("clientMods.uploading", { i, n: files.length, name: f.name }));
        if (!/\.(jar|zip)$/i.test(f.name)) {
          dialog.toast({
            tone: "warning",
            message: t("clientMods.skipNotJar", { name: f.name }),
          });
          continue;
        }
        if (f.size > 100 * 1024 * 1024) {
          dialog.toast({
            tone: "warning",
            message: t("clientMods.skipTooBig", { name: f.name }),
          });
          continue;
        }
        const buf = await f.arrayBuffer();
        const b64 = bufferToBase64(buf);
        await api.post(`/servers/${serverId}/client-mods`, {
          filename: f.name,
          contentBase64: b64,
        });
      }
      setProgress("");
      mutate(`/servers/${serverId}/client-mods`);
    } catch (e) {
      dialog.alert({
        tone: "danger",
        title: t("common.error"),
        message: e instanceof ApiError ? e.message : String(e),
      });
    } finally {
      setUploading(false);
      setProgress("");
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function removeOne(name: string): Promise<void> {
    const ok = await dialog.confirm({
      tone: "danger",
      danger: true,
      title: t("clientMods.confirmRemove.title"),
      message: t("clientMods.confirmRemove.body", { name }),
      okLabel: t("common.delete"),
    });
    if (!ok) return;
    try {
      await api.del(
        `/servers/${serverId}/client-mods?name=${encodeURIComponent(name)}`
      );
      mutate(`/servers/${serverId}/client-mods`);
    } catch (e) {
      dialog.alert({
        tone: "danger",
        title: t("common.error"),
        message: e instanceof ApiError ? e.message : String(e),
      });
    }
  }

  function downloadMrpack(): void {
    // Trigger a browser download by opening the export URL directly.
    // The endpoint sets Content-Disposition: attachment so the browser
    // saves rather than trying to render the ZIP. Auth cookie ships
    // automatically since /api/* is same-origin.
    window.location.href = `/api/servers/${serverId}/export-mrpack`;
  }

  return (
    <div className="space-y-4">
      <div className="tile p-4 space-y-3">
        <header className="flex items-center gap-3">
          <PackageOpen size={16} className="text-ink-muted" />
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-medium">{t("clientMods.title")}</h3>
            <p className="text-[11px] text-ink-muted leading-relaxed mt-0.5">
              {t("clientMods.intro")}
            </p>
          </div>
        </header>

        <div className="flex items-center gap-2 flex-wrap">
          <input
            ref={fileRef}
            type="file"
            multiple
            accept=".jar,.zip"
            className="hidden"
            onChange={(e) => void uploadFiles(e.target.files)}
          />
          <button
            className="btn btn-primary"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
          >
            {uploading ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Upload size={14} />
            )}
            {t("clientMods.upload")}
          </button>
          <button
            className="btn btn-ghost"
            onClick={downloadMrpack}
            disabled={uploading}
            title={t("clientMods.exportTooltip")}
          >
            <Download size={14} />
            {t("clientMods.exportMrpack")}
          </button>
          {progress && (
            <span className="text-[11px] text-ink-muted">{progress}</span>
          )}
        </div>
      </div>

      <div className="tile p-4 space-y-3">
        <header className="flex items-start gap-3">
          {publicToken ? (
            <Link2 size={16} className="text-[rgb(var(--accent))] shrink-0 mt-0.5" />
          ) : (
            <Link2Off size={16} className="text-ink-muted shrink-0 mt-0.5" />
          )}
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-medium">
              {t("clientMods.publicLink.title")}
            </h3>
            <p className="text-[11px] text-ink-muted leading-relaxed mt-0.5">
              {t("clientMods.publicLink.intro")}
            </p>
          </div>
        </header>

        {publicToken && publicUrl ? (
          <>
            <div className="flex items-center gap-2 rounded bg-surface-2 px-2 py-1.5">
              <input
                readOnly
                value={publicUrl}
                onClick={(e) => e.currentTarget.select()}
                className="flex-1 bg-transparent text-xs font-mono outline-none truncate"
              />
              <button
                className="btn btn-ghost !h-7"
                onClick={() => void copyPublicLink()}
                disabled={linkBusy}
              >
                {copied ? <Check size={13} /> : <Copy size={13} />}
                {copied
                  ? t("clientMods.publicLink.copied")
                  : t("clientMods.publicLink.copy")}
              </button>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                className="btn btn-ghost"
                onClick={() => void rotatePublicLink()}
                disabled={linkBusy}
              >
                {linkBusy ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <RotateCw size={14} />
                )}
                {t("clientMods.publicLink.rotate")}
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => void disablePublicLink()}
                disabled={linkBusy}
              >
                <Link2Off size={14} />
                {t("clientMods.publicLink.disable")}
              </button>
            </div>
          </>
        ) : (
          <div>
            <button
              className="btn btn-primary"
              onClick={() => void enablePublicLink()}
              disabled={linkBusy}
            >
              {linkBusy ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Link2 size={14} />
              )}
              {t("clientMods.publicLink.enable")}
            </button>
          </div>
        )}
      </div>

      {detectedItems.length > 0 && (
        <div className="tile p-4 space-y-3 border-[rgb(var(--accent))]/30">
          <header className="flex items-start gap-3 flex-wrap">
            <PackageOpen size={16} className="text-[rgb(var(--accent))] shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <h3 className="text-sm font-medium">
                {t("clientMods.autoDetected.title", {
                  n: detectedItems.length,
                })}
              </h3>
              <p className="text-[11px] text-ink-muted leading-relaxed mt-0.5">
                {t("clientMods.autoDetected.body")}
              </p>
            </div>
            <button
              className="btn btn-primary"
              onClick={() => void downloadDetected()}
              disabled={uploading}
            >
              {uploading ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Download size={14} />
              )}
              {t("clientMods.autoDetected.downloadAll")}
            </button>
          </header>
          <ul className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {detectedItems.slice(0, 12).map((d) => (
              <li
                key={d.modId}
                className="flex items-center gap-2 text-xs text-ink-muted"
              >
                {d.icon ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={d.icon}
                    alt=""
                    className="w-6 h-6 rounded shrink-0 object-cover"
                  />
                ) : (
                  <PackageOpen size={14} className="shrink-0 opacity-50" />
                )}
                <span className="truncate">{d.title}</span>
              </li>
            ))}
          </ul>
          {detectedItems.length > 12 && (
            <p className="text-[11px] text-ink-muted">
              {t("clientMods.autoDetected.more", {
                n: detectedItems.length - 12,
              })}
            </p>
          )}
        </div>
      )}

      {isLoading ? (
        <div className="tile p-10 text-center text-ink-muted">
          {t("common.loading")}
        </div>
      ) : items.length === 0 ? (
        <div className="tile p-10 text-center text-ink-muted">
          <PackageOpen size={28} className="mx-auto opacity-40" />
          <p className="mt-3 text-sm">{t("clientMods.empty.title")}</p>
          <p className="mt-1 text-xs leading-relaxed max-w-md mx-auto">
            {t("clientMods.empty.body")}
          </p>
        </div>
      ) : (
        <ul className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {items.map((m) => (
            <li
              key={m.name}
              className="tile p-3 flex items-center gap-3"
            >
              <div className="w-10 h-10 rounded-md grid place-items-center bg-surface-2 shrink-0">
                <PackageOpen size={16} className="text-ink-muted" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium font-mono truncate">
                  {m.name}
                </div>
                <div className="text-[11px] text-ink-muted tabular-nums">
                  {formatSize(m.size)}
                </div>
              </div>
              <button
                className="btn-icon btn-ghost !h-8 !w-8 shrink-0"
                onClick={() => void removeOne(m.name)}
                aria-label="Delete"
                title={t("common.delete")}
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  // Chunk to avoid call-stack-overflow on large arrays.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + CHUNK))
    );
  }
  return btoa(s);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

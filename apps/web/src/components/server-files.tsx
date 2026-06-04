"use client";
import { useRef, useState } from "react";
import useSWR, { mutate } from "swr";
import { api, ApiError, fetcher } from "@/lib/api";
import {
  Folder,
  File as FileIcon,
  ChevronLeft,
  Save,
  Upload,
  FilePlus,
  Loader2,
} from "lucide-react";
import { useDialog } from "./dialog-provider";
import { useT } from "@/lib/i18n";

type DirEntry = { name: string; isDir: boolean };
type Listing =
  | { kind: "dir"; path: string; entries: DirEntry[] }
  | { kind: "file"; path: string; size: number; content?: string; truncated?: boolean }
  | { kind: "missing"; path: string };

export function ServerFiles({ serverId }: { serverId: string }): JSX.Element {
  const dialog = useDialog();
  const { t } = useT();
  const [path, setPath] = useState("");
  const { data } = useSWR<Listing>(
    `/servers/${serverId}/files?path=${encodeURIComponent(path)}`,
    fetcher
  );
  const [editor, setEditor] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const uploadRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string>("");

  function open(entry: string, isDir: boolean): void {
    const next = path ? `${path}/${entry}` : entry;
    if (isDir) {
      setPath(next);
      setEditor(null);
      setDirty(false);
    } else {
      setPath(next);
      setEditor(null);
      setDirty(false);
    }
  }

  function up(): void {
    if (!path) return;
    const parts = path.split("/").filter(Boolean);
    parts.pop();
    setPath(parts.join("/"));
    setEditor(null);
  }

  async function save(): Promise<void> {
    if (editor == null) return;
    await api.put(`/servers/${serverId}/files`, {
      path,
      content: editor,
    });
    setDirty(false);
    mutate(`/servers/${serverId}/files?path=${encodeURIComponent(path)}`);
  }

  /**
   * Ask for a filename, create an empty file in the current directory,
   * and pop the inline editor open for it. Lets the operator land a
   * fresh `ru_ru.snbt` or any other small config without leaving the
   * browser.
   */
  async function createFile(): Promise<void> {
    if (data?.kind !== "dir") return;
    const name = await dialog.prompt({
      title: t("files.create.title"),
      message: t("files.create.body"),
      placeholder: "ru_ru.snbt",
    });
    if (!name) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed.includes("/") || trimmed.includes("\\")) {
      dialog.alert({
        tone: "danger",
        title: t("common.error"),
        message: t("files.create.invalidName"),
      });
      return;
    }
    const target = path ? `${path}/${trimmed}` : trimmed;
    try {
      await api.put(`/servers/${serverId}/files`, {
        path: target,
        content: "",
      });
      // Drop straight into the new (empty) file so the operator can
      // start typing right away.
      setPath(target);
      setEditor("");
      setDirty(false);
      mutate(`/servers/${serverId}/files?path=${encodeURIComponent(path)}`);
    } catch (e) {
      dialog.alert({
        tone: "danger",
        title: t("common.error"),
        message: e instanceof ApiError ? e.message : String(e),
      });
    }
  }

  /**
   * Chunked binary upload. The server endpoint accepts base64 chunks
   * up to ~8 MB each — split the file, push them sequentially, the
   * agent appends to `<name>.part` until the last chunk lands then
   * promotes to `<name>`. Multiple files allowed; each progresses
   * independently and the input shows a small status string.
   */
  async function uploadFiles(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) return;
    if (data?.kind !== "dir") return;
    setUploading(true);
    setUploadProgress("");
    try {
      const CHUNK = 6 * 1024 * 1024; // 6 MB raw → ~8 MB base64
      let fileIdx = 0;
      for (const file of Array.from(files)) {
        fileIdx += 1;
        const target = path ? `${path}/${file.name}` : file.name;
        const total = Math.max(1, Math.ceil(file.size / CHUNK));
        for (let i = 0; i < total; i++) {
          const start = i * CHUNK;
          const slice = file.slice(start, Math.min(start + CHUNK, file.size));
          const b64 = await blobToBase64(slice);
          await api.put(`/servers/${serverId}/files`, {
            path: target,
            contentBase64: b64,
            chunkIndex: i,
            totalChunks: total,
          });
          setUploadProgress(
            `${file.name} ${fileIdx}/${files.length} · ${i + 1}/${total}`
          );
        }
      }
      mutate(`/servers/${serverId}/files?path=${encodeURIComponent(path)}`);
      setUploadProgress("");
    } catch (e) {
      dialog.alert({
        tone: "danger",
        title: t("common.error"),
        message: e instanceof ApiError ? e.message : String(e),
      });
    } finally {
      setUploading(false);
      if (uploadRef.current) uploadRef.current.value = "";
    }
  }

  async function remove(target: string, isDir: boolean): Promise<void> {
    void isDir;
    const p = path ? `${path}/${target}` : target;
    const ok = await dialog.confirm({
      tone: "danger",
      danger: true,
      title: t("files.deleteConfirm.title"),
      message: t("files.deleteConfirm.body", { path: p }),
      okLabel: t("common.delete"),
    });
    if (!ok) return;
    await api.del(`/servers/${serverId}/files?path=${encodeURIComponent(p)}`);
    mutate(`/servers/${serverId}/files?path=${encodeURIComponent(path)}`);
  }

  return (
    <div className="card">
      <div className="px-4 py-2 border-b border-line flex items-center gap-2 text-sm">
        <button
          className="btn-ghost !py-1 !px-2"
          onClick={up}
          disabled={!path}
        >
          <ChevronLeft size={14} />
        </button>
        <span className="text-ink-secondary">/{path}</span>
        {data?.kind === "dir" && (
          <div className="ml-auto flex items-center gap-2">
            {uploadProgress && (
              <span className="text-[11px] text-ink-muted">{uploadProgress}</span>
            )}
            <input
              ref={uploadRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => void uploadFiles(e.target.files)}
            />
            <button
              className="btn-ghost !py-1 !px-2"
              onClick={() => void createFile()}
              disabled={uploading}
              title={t("files.create.title")}
            >
              <FilePlus size={14} /> {t("files.create.button")}
            </button>
            <button
              className="btn-primary !py-1 !px-3"
              onClick={() => uploadRef.current?.click()}
              disabled={uploading}
              title={t("files.upload")}
            >
              {uploading ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Upload size={14} />
              )}{" "}
              {t("files.upload")}
            </button>
          </div>
        )}
        {data?.kind === "file" && (
          <button
            className="ml-auto btn-primary !py-1 !px-3"
            disabled={!dirty}
            onClick={save}
          >
            <Save size={14} /> {t("files.save")}
          </button>
        )}
      </div>
      {data?.kind === "dir" && (
        <ul className="divide-y divide-line text-sm">
          {data.entries.length === 0 && (
            <li className="px-4 py-6 text-ink-muted">{t("files.empty")}</li>
          )}
          {data.entries.map((e) => (
            <li
              key={e.name}
              className="px-4 py-2 flex items-center gap-3 hover:bg-surface-2"
            >
              <button
                className="flex items-center gap-2 flex-1 text-left"
                onClick={() => open(e.name, e.isDir)}
              >
                {e.isDir ? (
                  <Folder size={14} className="text-accent" />
                ) : (
                  <FileIcon size={14} className="text-ink-secondary" />
                )}
                <span>{e.name}</span>
              </button>
              <button
                className="text-danger text-xs hover:underline"
                onClick={() => remove(e.name, e.isDir)}
              >
                {t("common.delete").toLowerCase()}
              </button>
            </li>
          ))}
        </ul>
      )}
      {data?.kind === "file" && (
        <div>
          {data.truncated ? (
            <div className="p-6 text-sm text-ink-muted">
              {t("files.truncated")}
            </div>
          ) : (
            <textarea
              className="w-full bg-base font-mono text-xs p-4 h-[540px] outline-none"
              value={editor ?? data.content ?? ""}
              onChange={(e) => {
                setEditor(e.target.value);
                setDirty(true);
              }}
            />
          )}
        </div>
      )}
      {data?.kind === "missing" && (
        <div className="p-6 text-sm text-ink-muted">
          {t("files.empty")}
        </div>
      )}
    </div>
  );
}

/**
 * Read a Blob (or File slice) as a base64 string via FileReader.
 * Strips the `data:<mime>;base64,` prefix so the server receives a
 * clean payload it can `Buffer.from(s, "base64")` directly. Same
 * pattern as client-mods-tab — chunks are ≤8 MB so the intermediate
 * string is well within V8's allocation limits.
 */
function blobToBase64(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const result = r.result as string;
      const comma = result.indexOf(",");
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    r.onerror = () => reject(r.error ?? new Error("FileReader failed"));
    r.readAsDataURL(b);
  });
}

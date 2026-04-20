"use client";
import { useState } from "react";
import useSWR, { mutate } from "swr";
import { api, fetcher } from "@/lib/api";
import { Folder, File as FileIcon, ChevronLeft, Save } from "lucide-react";

type DirEntry = { name: string; isDir: boolean };
type Listing =
  | { kind: "dir"; path: string; entries: DirEntry[] }
  | { kind: "file"; path: string; size: number; content?: string; truncated?: boolean }
  | { kind: "missing"; path: string };

export function ServerFiles({ serverId }: { serverId: string }): JSX.Element {
  const [path, setPath] = useState("");
  const { data } = useSWR<Listing>(
    `/servers/${serverId}/files?path=${encodeURIComponent(path)}`,
    fetcher
  );
  const [editor, setEditor] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

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

  async function remove(target: string, isDir: boolean): Promise<void> {
    const p = path ? `${path}/${target}` : target;
    if (!confirm(`Delete ${isDir ? "folder" : "file"} "${p}"?`)) return;
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
        {data?.kind === "file" && (
          <button
            className="ml-auto btn-primary !py-1 !px-3"
            disabled={!dirty}
            onClick={save}
          >
            <Save size={14} /> Save
          </button>
        )}
      </div>
      {data?.kind === "dir" && (
        <ul className="divide-y divide-line text-sm">
          {data.entries.length === 0 && (
            <li className="px-4 py-6 text-ink-muted">Empty directory</li>
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
                delete
              </button>
            </li>
          ))}
        </ul>
      )}
      {data?.kind === "file" && (
        <div>
          {data.truncated ? (
            <div className="p-6 text-sm text-ink-muted">
              File too large to edit in browser ({data.size} bytes).
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
          File does not exist yet. Start the server once to generate default files.
        </div>
      )}
    </div>
  );
}

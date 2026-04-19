"use client";
import useSWR, { mutate } from "swr";
import { useState } from "react";
import { api, fetcher } from "@/lib/api";
import { SERVER_TYPES } from "@cofemine/shared";

type Template = {
  id: string;
  name: string;
  description: string | null;
  type: string;
  version: string;
  memoryMb: number;
  env: Record<string, string>;
};

export default function TemplatesPage(): JSX.Element {
  const { data } = useSWR<Template[]>("/templates", fetcher);
  const [name, setName] = useState("");
  const [type, setType] = useState<(typeof SERVER_TYPES)[number]>("PAPER");
  const [version, setVersion] = useState("1.21.1");
  const [memoryMb, setMemoryMb] = useState(4096);

  async function add(): Promise<void> {
    await api.post("/templates", {
      name,
      type,
      version,
      memoryMb: Number(memoryMb),
      env: {},
    });
    setName("");
    mutate("/templates");
  }

  async function remove(id: string): Promise<void> {
    await api.del(`/templates/${id}`);
    mutate("/templates");
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Templates</h1>

      <div className="card p-5 space-y-3">
        <h2 className="font-medium">New template</h2>
        <div className="grid grid-cols-4 gap-3">
          <input className="input" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <select className="select" value={type} onChange={(e) => setType(e.target.value as any)}>
            {SERVER_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <input className="input" value={version} onChange={(e) => setVersion(e.target.value)} placeholder="Version" />
          <input className="input" type="number" value={memoryMb} onChange={(e) => setMemoryMb(Number(e.target.value))} />
        </div>
        <button className="btn-primary" onClick={add} disabled={!name}>Create</button>
      </div>

      <div className="card">
        {data && data.length > 0 ? (
          <ul className="divide-y divide-surface-border">
            {data.map((t) => (
              <li key={t.id} className="px-4 py-3 flex items-center gap-4 text-sm">
                <div className="flex-1">
                  <div className="font-medium">{t.name}</div>
                  <div className="text-xs text-zinc-500">{t.type} · {t.version} · {t.memoryMb} MB</div>
                </div>
                <button className="text-xs text-danger hover:underline" onClick={() => remove(t.id)}>delete</button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="p-6 text-center text-zinc-500">No templates yet.</div>
        )}
      </div>
    </div>
  );
}

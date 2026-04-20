"use client";
import useSWR, { mutate } from "swr";
import { useState } from "react";
import { api, ApiError, fetcher } from "@/lib/api";

type Node = {
  id: string;
  name: string;
  host: string;
  status: string;
  lastSeenAt: string | null;
};

export default function NodesPage(): JSX.Element {
  const { data } = useSWR<Node[]>("/nodes", fetcher);
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [token, setToken] = useState("");
  const [err, setErr] = useState<string | null>(null);

  async function add(): Promise<void> {
    setErr(null);
    try {
      await api.post("/nodes", { name, host, token });
      setName("");
      setHost("");
      setToken("");
      mutate("/nodes");
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  }

  async function check(id: string): Promise<void> {
    try {
      await api.get(`/nodes/${id}/health`);
      mutate("/nodes");
    } catch (e) {
      alert(e instanceof ApiError ? e.message : String(e));
    }
  }

  async function remove(id: string): Promise<void> {
    if (!confirm("Delete node?")) return;
    try {
      await api.del(`/nodes/${id}`);
      mutate("/nodes");
    } catch (e) {
      alert(e instanceof ApiError ? e.message : String(e));
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Nodes</h1>
      <div className="card p-5 space-y-3">
        <h2 className="font-medium">Add node</h2>
        <div className="grid grid-cols-4 gap-3">
          <input className="input" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <input className="input col-span-2" placeholder="https://agent:4100" value={host} onChange={(e) => setHost(e.target.value)} />
          <input className="input" placeholder="Shared token" value={token} onChange={(e) => setToken(e.target.value)} />
        </div>
        {err && <div className="text-danger text-sm">{err}</div>}
        <button className="btn-primary" onClick={add}>Add node</button>
      </div>

      <div className="card">
        {data && data.length > 0 ? (
          <ul className="divide-y divide-line">
            {data.map((n) => (
              <li key={n.id} className="px-4 py-3 flex items-center gap-4 text-sm">
                <div className="flex-1">
                  <div className="font-medium">{n.name}</div>
                  <div className="text-xs text-ink-muted">{n.host}</div>
                </div>
                <span className="badge badge-muted">{n.status}</span>
                <button className="text-xs hover:underline" onClick={() => check(n.id)}>health</button>
                <button className="text-xs text-danger hover:underline" onClick={() => remove(n.id)}>remove</button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="p-6 text-center text-ink-muted">No nodes configured.</div>
        )}
      </div>
    </div>
  );
}

"use client";
import useSWR from "swr";
import { fetcher } from "@/lib/api";

type Event = {
  id: string;
  action: string;
  resource: string | null;
  metadata: unknown;
  ip: string | null;
  createdAt: string;
  user: { username: string; email: string } | null;
};

export default function AuditPage(): JSX.Element {
  const { data } = useSWR<{ items: Event[]; total: number }>("/audit?limit=200", fetcher);
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Audit log</h1>
      <div className="card">
        {data && data.items.length > 0 ? (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-ink-muted uppercase">
              <tr>
                <th className="px-4 py-3">When</th>
                <th className="px-4 py-3">Who</th>
                <th className="px-4 py-3">Action</th>
                <th className="px-4 py-3">Resource</th>
                <th className="px-4 py-3">IP</th>
                <th className="px-4 py-3">Metadata</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.items.map((e) => (
                <tr key={e.id} className="hover:bg-surface-2">
                  <td className="px-4 py-2 font-mono text-xs">{new Date(e.createdAt).toLocaleString()}</td>
                  <td className="px-4 py-2">{e.user?.username ?? "—"}</td>
                  <td className="px-4 py-2 font-mono text-xs">{e.action}</td>
                  <td className="px-4 py-2 font-mono text-xs">{e.resource ?? "—"}</td>
                  <td className="px-4 py-2 font-mono text-xs">{e.ip ?? "—"}</td>
                  <td className="px-4 py-2 font-mono text-xs truncate max-w-[300px]">
                    {e.metadata ? JSON.stringify(e.metadata) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="p-6 text-center text-ink-muted">No audit events yet.</div>
        )}
      </div>
    </div>
  );
}

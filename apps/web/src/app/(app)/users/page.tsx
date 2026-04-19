"use client";
import useSWR, { mutate } from "swr";
import { useState } from "react";
import { api, ApiError, fetcher } from "@/lib/api";
import { ROLES } from "@cofemine/shared";

type User = {
  id: string;
  email: string;
  username: string;
  role: string;
  createdAt: string;
};

export default function UsersPage(): JSX.Element {
  const { data } = useSWR<User[]>("/users", fetcher);
  const [email, setEmail] = useState("");
  const [username, setU] = useState("");
  const [password, setP] = useState("");
  const [role, setRole] = useState<(typeof ROLES)[number]>("OPERATOR");
  const [err, setErr] = useState<string | null>(null);

  async function add(): Promise<void> {
    setErr(null);
    try {
      await api.post("/users", { email, username, password, role });
      setEmail("");
      setU("");
      setP("");
      mutate("/users");
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  }

  async function remove(id: string): Promise<void> {
    if (!confirm("Delete user?")) return;
    await api.del(`/users/${id}`);
    mutate("/users");
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Users</h1>
      <div className="card p-5 space-y-3">
        <h2 className="font-medium">Invite a user</h2>
        <div className="grid grid-cols-4 gap-3">
          <input className="input" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input className="input" placeholder="Username" value={username} onChange={(e) => setU(e.target.value)} />
          <input className="input" type="password" placeholder="Password" value={password} onChange={(e) => setP(e.target.value)} />
          <select className="select" value={role} onChange={(e) => setRole(e.target.value as any)}>
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        {err && <div className="text-danger text-sm">{err}</div>}
        <button className="btn-primary" onClick={add}>Create user</button>
      </div>
      <div className="card">
        {data && data.length > 0 ? (
          <ul className="divide-y divide-surface-border">
            {data.map((u) => (
              <li key={u.id} className="px-4 py-3 flex items-center gap-4 text-sm">
                <div className="flex-1">
                  <div className="font-medium">{u.username}</div>
                  <div className="text-xs text-zinc-500">{u.email}</div>
                </div>
                <span className="badge bg-surface-3 text-zinc-300">{u.role}</span>
                <button className="text-xs text-danger hover:underline" onClick={() => remove(u.id)}>delete</button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="p-6 text-center text-zinc-500">No users.</div>
        )}
      </div>
    </div>
  );
}

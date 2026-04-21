"use client";
import { useState } from "react";
import useSWR, { mutate } from "swr";
import { motion } from "framer-motion";
import { api, ApiError, fetcher } from "@/lib/api";
import { ROLES } from "@cofemine/shared";
import { cn } from "@/lib/cn";
import { UserPlus, ClipboardList, Trash2 } from "lucide-react";

type User = {
  id: string;
  email: string;
  username: string;
  role: string;
  createdAt: string;
};

type AuditEvent = {
  id: string;
  action: string;
  resource: string | null;
  metadata: unknown;
  ip: string | null;
  createdAt: string;
  user: { username: string; email: string } | null;
};

type Tab = "users" | "activity";

export default function AdministrationPage(): JSX.Element {
  const [tab, setTab] = useState<Tab>("users");
  return (
    <div className="space-y-6">
      <header>
        <h1 className="heading-xl">Administration</h1>
        <p className="text-ink-secondary mt-2">
          Manage panel users and review activity. Server-specific logs are on
          each server's page.
        </p>
      </header>

      <div className="flex gap-1 border-b border-line">
        <TabButton
          active={tab === "users"}
          onClick={() => setTab("users")}
          icon={<UserPlus size={14} />}
          label="Users"
        />
        <TabButton
          active={tab === "activity"}
          onClick={() => setTab("activity")}
          icon={<ClipboardList size={14} />}
          label="Activity"
        />
      </div>

      {tab === "users" ? <UsersTab /> : <ActivityTab />}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={cn(
        "relative px-4 py-2.5 text-sm inline-flex items-center gap-2",
        active ? "text-ink" : "text-ink-secondary hover:text-ink"
      )}
    >
      {icon}
      <span>{label}</span>
      {active && (
        <motion.span
          layoutId="admin-tab"
          className="absolute -bottom-px left-0 right-0 h-0.5 bg-accent rounded-full"
          transition={{ type: "spring", duration: 0.3 }}
        />
      )}
    </button>
  );
}

function UsersTab(): JSX.Element {
  const { data } = useSWR<User[]>("/users", fetcher);
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="heading-lg">Panel users</h2>
        <button
          className="btn-primary"
          onClick={() => setOpen((v) => !v)}
        >
          <UserPlus size={16} /> Invite user
        </button>
      </div>

      {open && <InviteForm onDone={() => setOpen(false)} />}

      <div className="card overflow-hidden">
        {data && data.length > 0 ? (
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-left text-xs text-ink-muted uppercase tracking-wider">
              <tr>
                <th className="px-5 py-3">User</th>
                <th className="px-5 py-3">Email</th>
                <th className="px-5 py-3">Role</th>
                <th className="px-5 py-3">Joined</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.map((u) => (
                <tr key={u.id} className="hover:bg-surface-2/60">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-3">
                      <span className="w-8 h-8 rounded-full bg-accent-soft text-accent grid place-items-center text-xs font-semibold uppercase">
                        {u.username.slice(0, 2)}
                      </span>
                      <span className="font-medium">{u.username}</span>
                    </div>
                  </td>
                  <td className="px-5 py-3 text-ink-secondary">{u.email}</td>
                  <td className="px-5 py-3">
                    <span className="badge badge-accent">{u.role}</span>
                  </td>
                  <td className="px-5 py-3 text-ink-muted text-xs">
                    {new Date(u.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <button
                      className="text-ink-muted hover:text-danger transition-colors"
                      onClick={async () => {
                        if (!confirm(`Delete ${u.username}?`)) return;
                        await api.del(`/users/${u.id}`);
                        mutate("/users");
                      }}
                      aria-label="Delete user"
                    >
                      <Trash2 size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="p-10 text-center text-ink-muted">
            No users yet. Invite one to get started.
          </div>
        )}
      </div>
    </div>
  );
}

function InviteForm({ onDone }: { onDone: () => void }): JSX.Element {
  const [email, setEmail] = useState("");
  const [username, setU] = useState("");
  const [password, setP] = useState("");
  const [role, setRole] = useState<(typeof ROLES)[number]>("OPERATOR");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      await api.post("/users", { email, username, password, role });
      setEmail("");
      setU("");
      setP("");
      mutate("/users");
      onDone();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      className="card p-5 space-y-3"
    >
      <h3 className="font-medium">Invite new user</h3>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <input
          className="input"
          placeholder="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          className="input"
          placeholder="username"
          value={username}
          onChange={(e) => setU(e.target.value)}
        />
        <input
          className="input"
          type="password"
          placeholder="password"
          value={password}
          onChange={(e) => setP(e.target.value)}
        />
        <select
          className="select"
          value={role}
          onChange={(e) => setRole(e.target.value as any)}
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>
      {err && <div className="text-sm text-danger">{err}</div>}
      <div className="flex gap-2 justify-end">
        <button type="button" className="btn-ghost" onClick={onDone}>
          Cancel
        </button>
        <button className="btn-primary" onClick={submit} disabled={busy}>
          {busy ? "Inviting…" : "Invite"}
        </button>
      </div>
    </motion.div>
  );
}

function ActivityTab(): JSX.Element {
  const { data } = useSWR<{ items: AuditEvent[]; total: number }>(
    "/audit?limit=200",
    fetcher
  );
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="heading-lg">Panel activity</h2>
        {data && (
          <span className="text-sm text-ink-muted">
            {data.total} events recorded
          </span>
        )}
      </div>
      <div className="card overflow-hidden">
        {data && data.items.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface-2 text-left text-xs text-ink-muted uppercase tracking-wider">
                <tr>
                  <th className="px-5 py-3">When</th>
                  <th className="px-5 py-3">Who</th>
                  <th className="px-5 py-3">Action</th>
                  <th className="px-5 py-3">Resource</th>
                  <th className="px-5 py-3">IP</th>
                  <th className="px-5 py-3">Metadata</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.items.map((e) => (
                  <tr key={e.id} className="hover:bg-surface-2/60">
                    <td className="px-5 py-3 font-mono text-xs text-ink-secondary whitespace-nowrap">
                      {new Date(e.createdAt).toLocaleString()}
                    </td>
                    <td className="px-5 py-3 whitespace-nowrap">
                      {e.user?.username ?? (
                        <span className="text-ink-muted italic">system</span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <span className="badge badge-muted font-mono text-[11px]">
                        {e.action}
                      </span>
                    </td>
                    <td className="px-5 py-3 font-mono text-xs text-ink-secondary">
                      {e.resource ?? "—"}
                    </td>
                    <td className="px-5 py-3 font-mono text-xs text-ink-muted">
                      {e.ip ?? "—"}
                    </td>
                    <td className="px-5 py-3 font-mono text-xs text-ink-muted truncate max-w-[280px]">
                      {e.metadata ? JSON.stringify(e.metadata) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-10 text-center text-ink-muted">
            No activity yet.
          </div>
        )}
      </div>
    </div>
  );
}

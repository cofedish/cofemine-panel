"use client";
import { useState } from "react";
import useSWR, { mutate } from "swr";
import { motion } from "framer-motion";
import { api, ApiError, fetcher } from "@/lib/api";
import { ROLES } from "@cofemine/shared";
import { cn } from "@/lib/cn";
import { PageHeader } from "@/components/page-header";
import { Drawer } from "@/components/drawer";
import { Stagger, StaggerItem } from "@/components/motion";
import { Avatar } from "@/components/avatar";
import { UserPlus, ClipboardList, Trash2, KeyRound } from "lucide-react";
import { useDialog } from "@/components/dialog-provider";
import { useT } from "@/lib/i18n";

type User = {
  id: string;
  email: string;
  username: string;
  role: string;
  avatar: string | null;
  createdAt: string;
};

type AuditEvent = {
  id: string;
  action: string;
  resource: string | null;
  metadata: unknown;
  ip: string | null;
  createdAt: string;
  user: {
    username: string;
    email: string;
    avatar: string | null;
  } | null;
};

const TABS = [
  { key: "users", i18n: "admin.tabs.users", icon: UserPlus },
  { key: "activity", i18n: "admin.tabs.audit", icon: ClipboardList },
] as const;
type Tab = (typeof TABS)[number]["key"];

export default function AdministrationPage(): JSX.Element {
  const [tab, setTab] = useState<Tab>("users");
  const { t } = useT();

  return (
    <div className="space-y-8">
      <PageHeader
        title={t("nav.administration")}
        description=""
      />

      <div className="flex gap-1 border-b border-line -mt-2">
        {TABS.map((tb) => {
          const Icon = tb.icon;
          const active = tab === tb.key;
          return (
            <button
              key={tb.key}
              onClick={() => setTab(tb.key)}
              className={cn(
                "relative px-4 py-3 text-sm inline-flex items-center gap-2 transition-colors",
                active
                  ? "text-ink font-medium"
                  : "text-ink-secondary hover:text-ink"
              )}
            >
              <Icon size={14} />
              {t(tb.i18n)}
              {active && (
                <motion.span
                  layoutId="admin-tab"
                  className="absolute -bottom-px left-2 right-2 h-0.5 bg-[rgb(var(--accent))] rounded-full"
                  transition={{ type: "spring", duration: 0.3 }}
                />
              )}
            </button>
          );
        })}
      </div>

      {tab === "users" ? <UsersTab /> : <ActivityTab />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Users                                                              */
/* ------------------------------------------------------------------ */

/**
 * Owner / admin "reset password for this user" flow. Asks the admin to
 * pick: type a new password directly (and tell the user OOB), or trigger
 * the email-link flow. The link mode falls back to copying the link to
 * the response when SMTP isn't configured — useful for ops setups that
 * haven't wired email yet.
 */
async function resetUserPassword(
  u: User,
  dialog: ReturnType<typeof useDialog>,
  t: ReturnType<typeof useT>["t"]
): Promise<void> {
  const choice = await dialog.confirm({
    tone: "info",
    title: t("admin.resetPassword.title"),
    message: t("admin.resetPassword.body", { username: u.username }),
    okLabel: t("admin.resetPassword.sendLink"),
    cancelLabel: t("admin.resetPassword.setManually"),
  });
  try {
    if (choice) {
      const res = await api.post<{
        mode: "link";
        mailed: boolean;
        link: string;
      }>(`/users/${u.id}/reset-password`);
      const lines = [
        res.mailed
          ? t("admin.resetPassword.sentMail", { email: u.email })
          : t("admin.resetPassword.notMailed"),
        "",
        res.link,
      ];
      await dialog.alert({
        tone: res.mailed ? "success" : "warning",
        title: t("common.done"),
        message: lines.join("\n"),
      });
    } else {
      const newPwd = window.prompt(t("admin.resetPassword.setPrompt"));
      if (!newPwd) return;
      if (newPwd.length < 8) {
        await dialog.alert({
          tone: "danger",
          title: t("common.error"),
          message: t("admin.resetPassword.tooShort"),
        });
        return;
      }
      await api.post(`/users/${u.id}/reset-password`, { newPassword: newPwd });
      await dialog.alert({
        tone: "success",
        title: t("common.done"),
        message: t("admin.resetPassword.directDone"),
      });
    }
  } catch (e) {
    await dialog.alert({
      tone: "danger",
      title: t("common.error"),
      message: e instanceof ApiError ? e.message : String(e),
    });
  }
}

function UsersTab(): JSX.Element {
  const { data } = useSWR<User[]>("/users", fetcher);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const dialog = useDialog();
  const { t } = useT();

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="heading-lg">{t("admin.users.title")}</h2>
        <button
          className="btn btn-primary"
          onClick={() => setDrawerOpen(true)}
        >
          <UserPlus size={16} /> {t("admin.users.invite")}
        </button>
      </div>

      {data && data.length > 0 ? (
        <div className="tile overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-left text-xs text-ink-muted uppercase tracking-wider">
              <tr>
                <th className="px-5 py-3 font-medium">{t("admin.users.table.user")}</th>
                <th className="px-5 py-3 font-medium">{t("admin.users.table.email")}</th>
                <th className="px-5 py-3 font-medium">{t("admin.users.table.role")}</th>
                <th className="px-5 py-3 font-medium">{t("admin.users.table.joined")}</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.map((u) => (
                <tr key={u.id} className="hover:bg-[rgb(var(--bg-hover))]">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-3">
                      <Avatar src={u.avatar} name={u.username} size={32} />
                      <span className="font-medium">{u.username}</span>
                    </div>
                  </td>
                  <td className="px-5 py-3 text-ink-secondary">{u.email}</td>
                  <td className="px-5 py-3">
                    <span className="chip chip-accent">{u.role}</span>
                  </td>
                  <td className="px-5 py-3 text-ink-muted text-xs">
                    {new Date(u.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <div className="inline-flex items-center gap-3">
                      <button
                        className="text-ink-muted hover:text-[rgb(var(--accent))] transition-colors"
                        onClick={() => resetUserPassword(u, dialog, t)}
                        aria-label="Reset password"
                        title={t("admin.resetPassword.title")}
                      >
                        <KeyRound size={15} />
                      </button>
                      <button
                        className="text-ink-muted hover:text-[rgb(var(--danger))] transition-colors"
                        onClick={async () => {
                          const ok = await dialog.confirm({
                            tone: "danger",
                            danger: true,
                            title: t("admin.removeUserConfirm.title"),
                            message: t("admin.removeUserConfirm.body", {
                              username: u.username,
                            }),
                            okLabel: t("common.delete"),
                          });
                          if (!ok) return;
                          await api.del(`/users/${u.id}`);
                          mutate("/users");
                        }}
                        aria-label="Delete user"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="tile p-10 text-center text-ink-muted">
          No users yet.
        </div>
      )}

      <InviteDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </div>
  );
}

function InviteDrawer({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): JSX.Element {
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
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Invite a user"
      description="Create an account for a new panel member. They'll sign in with the credentials you set here and can change their password later."
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>
            {busy ? "Inviting…" : "Invite"}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <LabeledField label="Email">
          <input
            className="input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </LabeledField>
        <LabeledField label="Username">
          <input
            className="input"
            value={username}
            onChange={(e) => setU(e.target.value)}
          />
        </LabeledField>
        <LabeledField label="Password" hint="min 8 characters">
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setP(e.target.value)}
          />
        </LabeledField>
        <LabeledField label="Role">
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
        </LabeledField>
        {err && (
          <div className="chip chip-danger !h-auto !py-2 !px-3">{err}</div>
        )}
      </div>
    </Drawer>
  );
}

function LabeledField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-ink-secondary">{label}</label>
      {children}
      {hint && <div className="text-xs text-ink-muted">{hint}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Activity                                                           */
/* ------------------------------------------------------------------ */

function ActivityTab(): JSX.Element {
  const { data } = useSWR<{ items: AuditEvent[]; total: number }>(
    "/audit?limit=200",
    fetcher
  );

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="heading-lg">Activity log</h2>
        {data && (
          <span className="text-sm text-ink-muted">
            {data.total} event{data.total === 1 ? "" : "s"} recorded
          </span>
        )}
      </div>

      {data && data.items.length > 0 ? (
        <Stagger className="tile overflow-hidden">
          <ol className="divide-y divide-line">
            {data.items.map((e) => (
              <StaggerItem key={e.id}>
                <li className="px-5 py-3 flex items-start gap-4 hover:bg-[rgb(var(--bg-hover))]">
                  <Avatar
                    src={e.user?.avatar}
                    name={e.user?.username ?? "system"}
                    size={32}
                    className="shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm">
                        {e.user?.username ?? (
                          <span className="text-ink-muted italic">
                            system
                          </span>
                        )}
                      </span>
                      <span className="chip chip-muted font-mono text-[11px]">
                        {e.action}
                      </span>
                      {e.resource && (
                        <span className="font-mono text-[11px] text-ink-muted truncate">
                          {e.resource}
                        </span>
                      )}
                    </div>
                    {e.metadata ? (
                      <div className="text-xs text-ink-muted mt-1 font-mono truncate">
                        {JSON.stringify(e.metadata)}
                      </div>
                    ) : null}
                  </div>
                  <div className="text-xs text-ink-muted whitespace-nowrap tabular-nums">
                    {new Date(e.createdAt).toLocaleString()}
                  </div>
                </li>
              </StaggerItem>
            ))}
          </ol>
        </Stagger>
      ) : (
        <div className="tile p-10 text-center text-ink-muted">
          No activity yet.
        </div>
      )}
    </div>
  );
}

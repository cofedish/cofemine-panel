"use client";
import { useState } from "react";
import useSWR, { mutate } from "swr";
import { motion } from "framer-motion";
import { api, ApiError, fetcher } from "@/lib/api";
import { PageHeader } from "@/components/page-header";
import { Stagger, StaggerItem } from "@/components/motion";
import { StatusDot } from "@/components/status-dot";
import { Drawer } from "@/components/drawer";
import {
  Plus,
  HardDrive,
  Trash2,
  Activity,
  Pencil,
  Server,
  Clock,
  Network,
} from "lucide-react";
import { useDialog } from "@/components/dialog-provider";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";

type Node = {
  id: string;
  name: string;
  host: string;
  status: string;
  lastSeenAt: string | null;
  serverCount?: number;
};

const STATUS_LABEL: Record<string, string> = {
  ONLINE: "online",
  OFFLINE: "offline",
  UNKNOWN: "unknown",
};

export default function InfrastructurePage(): JSX.Element {
  const { data } = useSWR<Node[]>("/nodes", fetcher);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { t } = useT();

  const onlineCount =
    data?.filter((n) => n.status === "ONLINE").length ?? 0;

  return (
    <div className="space-y-8">
      <PageHeader
        title={t("infra.title")}
        description={t("infra.subtitle")}
        badge={
          data && (
            <span className="chip chip-muted">
              {t("infra.online", { n: onlineCount, total: data.length })}
            </span>
          )
        }
        actions={
          <button
            className="btn btn-primary"
            onClick={() => setDrawerOpen(true)}
          >
            <Plus size={16} /> {t("infra.addNode")}
          </button>
        }
      />

      {data && data.length > 0 ? (
        <Stagger
          className={cn(
            "grid gap-5",
            // A single node looks lonely in a 3-col grid. Pair it with a
            // ghost "Add another" tile in 2 columns so the page reads
            // intentionally rather than half-empty.
            data.length === 1
              ? "grid-cols-1 md:grid-cols-2"
              : "grid-cols-1 md:grid-cols-2 lg:grid-cols-3"
          )}
        >
          {data.map((n) => (
            <StaggerItem key={n.id}>
              <NodeCard node={n} />
            </StaggerItem>
          ))}
          {data.length === 1 && (
            <StaggerItem>
              <AddAnotherTile onAdd={() => setDrawerOpen(true)} />
            </StaggerItem>
          )}
        </Stagger>
      ) : (
        <EmptyState onAdd={() => setDrawerOpen(true)} />
      )}

      <AddNodeDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      />
    </div>
  );
}

function NodeCard({ node }: { node: Node }): JSX.Element {
  const dialog = useDialog();
  const { t } = useT();
  const [busy, setBusy] = useState(false);

  async function check(): Promise<void> {
    setBusy(true);
    try {
      const res = await api.get<{ ok: boolean; version: string }>(
        `/nodes/${node.id}/health`
      );
      mutate("/nodes");
      // Surface the response as a toast so the user actually sees that
      // something happened. The previous version silently revalidated
      // SWR and looked broken because the status chip wasn't moving.
      dialog.toast({
        tone: "success",
        message: t("infra.health.ok", { version: res.version }),
        duration: 3500,
      });
    } catch (e) {
      mutate("/nodes");
      dialog.toast({
        tone: "danger",
        message:
          e instanceof ApiError
            ? t("infra.health.fail", { msg: e.message })
            : String(e),
        duration: 5000,
      });
    } finally {
      setBusy(false);
    }
  }

  async function rename(): Promise<void> {
    const next = await dialog.prompt({
      title: t("infra.rename.title"),
      message: t("infra.rename.body"),
      defaultValue: node.name,
      okLabel: t("common.save"),
      validate: (v) =>
        v.trim().length >= 2 && v.trim().length <= 48
          ? null
          : t("infra.rename.invalid"),
    });
    if (next === null || next.trim() === node.name) return;
    try {
      await api.patch(`/nodes/${node.id}`, { name: next.trim() });
      mutate("/nodes");
    } catch (e) {
      dialog.alert({
        tone: "danger",
        title: t("common.error"),
        message: e instanceof ApiError ? e.message : String(e),
      });
    }
  }

  async function remove(): Promise<void> {
    const ok = await dialog.confirm({
      tone: "danger",
      danger: true,
      title: t("infra.removeNodeConfirm.title"),
      message: t("infra.removeNodeConfirm.body", { name: node.name }),
      okLabel: t("common.delete"),
    });
    if (!ok) return;
    try {
      await api.del(`/nodes/${node.id}`);
      mutate("/nodes");
    } catch (e) {
      dialog.alert({
        tone: "danger",
        title: t("common.error"),
        message: e instanceof ApiError ? e.message : String(e),
      });
    }
  }

  const statusLabel = STATUS_LABEL[node.status] ?? "unknown";
  const tone =
    node.status === "ONLINE"
      ? "chip-success"
      : node.status === "OFFLINE"
        ? "chip-danger"
        : "chip-muted";
  // Status-driven gradient on the hero strip — green for online, red
  // for offline, neutral grey when we haven't yet probed. Mirrors the
  // visual language servers use on the dashboard.
  const heroGradient =
    node.status === "ONLINE"
      ? "linear-gradient(135deg, #064e3b, #10b981)"
      : node.status === "OFFLINE"
        ? "linear-gradient(135deg, #7f1d1d, #dc2626)"
        : "linear-gradient(135deg, #1f2937, #4b5563)";

  return (
    <motion.div whileHover={{ y: -3 }} transition={{ duration: 0.18 }}>
      <div className="tile h-full flex flex-col overflow-hidden">
        {/* Hero strip — visually parallels the server tile's hero so the
            two pages feel like the same family. */}
        <div
          className="relative h-24 text-white px-5 flex items-center justify-between"
          style={{ background: heroGradient }}
        >
          <span className="absolute inset-0 bg-grid-pattern opacity-25" />
          <Network
            size={70}
            strokeWidth={1.25}
            className="absolute -right-3 -bottom-4 opacity-25 pointer-events-none"
          />
          <div className="relative flex items-center gap-2.5">
            <span className="w-9 h-9 rounded-md bg-white/15 backdrop-blur-sm grid place-items-center ring-1 ring-white/25">
              <HardDrive size={18} />
            </span>
            <div>
              <div className="text-[10px] uppercase tracking-widest opacity-75">
                Docker host
              </div>
              <div className="text-[11px] font-mono opacity-90">
                {node.host}
              </div>
            </div>
          </div>
          <span
            className={`chip relative ${tone} bg-white/20 !text-white border border-white/30`}
          >
            <StatusDot
              status={node.status === "ONLINE" ? "running" : "stopped"}
              size={6}
            />
            {statusLabel}
          </span>
        </div>

        <div className="p-5 flex-1 flex flex-col">
          <div className="flex items-start justify-between gap-2">
            <h3 className="heading-md truncate">{node.name}</h3>
            <button
              className="btn-icon btn-ghost !h-7 !w-7 shrink-0"
              onClick={rename}
              aria-label={t("infra.rename.title")}
              title={t("infra.rename.title")}
            >
              <Pencil size={13} />
            </button>
          </div>

          <div className="grid grid-cols-2 gap-4 mt-4 pt-4 border-t border-line">
            <Stat
              icon={<Server size={12} />}
              label={t("infra.stat.servers")}
              value={node.serverCount ?? 0}
            />
            <Stat
              icon={<Clock size={12} />}
              label={t("infra.stat.lastSeen")}
              value={
                node.lastSeenAt
                  ? new Date(node.lastSeenAt).toLocaleString()
                  : "—"
              }
            />
          </div>

          <div className="mt-auto pt-5 flex items-center gap-2">
            <button
              className="btn btn-subtle text-xs !py-1.5 !px-2.5"
              onClick={check}
              disabled={busy}
            >
              <Activity size={13} />{" "}
              {busy ? t("infra.health.checking") : t("infra.health.check")}
            </button>
            <div className="flex-1" />
            <button
              className="btn-icon btn-ghost !h-8 !w-8"
              onClick={remove}
              aria-label={t("common.delete")}
              title={t("common.delete")}
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

function Stat({
  icon,
  label,
  value,
}: {
  icon?: React.ReactNode;
  label: string;
  value: React.ReactNode;
}): JSX.Element {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-ink-muted">
        {icon}
        <span>{label}</span>
      </div>
      <div className="text-sm font-medium text-ink mt-0.5 truncate">
        {value}
      </div>
    </div>
  );
}

/**
 * Dashed "Add another" tile shown next to a single node so the row
 * doesn't look half-empty. Same height as a real card.
 */
function AddAnotherTile({ onAdd }: { onAdd: () => void }): JSX.Element {
  const { t } = useT();
  return (
    <button
      type="button"
      onClick={onAdd}
      className="tile tile-interactive w-full h-full min-h-[260px] border-dashed text-ink-secondary hover:text-ink flex flex-col items-center justify-center gap-3 p-8 text-center"
    >
      <span className="w-12 h-12 rounded-xl bg-[rgb(var(--accent-soft))] text-[rgb(var(--accent))] grid place-items-center">
        <Plus size={20} />
      </span>
      <div className="font-medium">{t("infra.addAnother.title")}</div>
      <div className="text-xs text-ink-muted max-w-[260px]">
        {t("infra.addAnother.body")}
      </div>
    </button>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }): JSX.Element {
  const { t } = useT();
  return (
    <div className="tile p-14 text-center">
      <div className="mx-auto w-16 h-16 rounded-2xl bg-[rgb(var(--accent-soft))] text-[rgb(var(--accent))] grid place-items-center mb-5">
        <HardDrive size={28} />
      </div>
      <h3 className="heading-lg mb-1">{t("infra.empty.title")}</h3>
      <p className="text-ink-secondary max-w-md mx-auto mb-6">
        {t("infra.empty.body")}
      </p>
      <button className="btn btn-primary" onClick={onAdd}>
        <Plus size={16} /> {t("infra.addNode")}
      </button>
    </div>
  );
}

function AddNodeDrawer({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): JSX.Element {
  const { t } = useT();
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [token, setToken] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    setErr(null);
    setBusy(true);
    try {
      await api.post("/nodes", { name, host, token });
      setName("");
      setHost("");
      setToken("");
      mutate("/nodes");
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
      title={t("infra.addNode")}
      description={t("infra.addNode.body")}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>
            {busy ? t("infra.adding") : t("infra.addNode")}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t("infra.field.name")}>
          <input
            className="input"
            placeholder="e.g. eu-west-1"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label={t("infra.field.host")} hint="https://host:4100">
          <input
            className="input font-mono"
            placeholder="https://agent.example.com:4100"
            value={host}
            onChange={(e) => setHost(e.target.value)}
          />
        </Field>
        <Field
          label={t("infra.field.token")}
          hint={t("infra.field.token.hint")}
        >
          <input
            className="input font-mono"
            type="password"
            placeholder="token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </Field>
        {err && (
          <div className="chip chip-danger !h-auto !py-2 !px-3">{err}</div>
        )}
      </div>
    </Drawer>
  );
}

function Field({
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

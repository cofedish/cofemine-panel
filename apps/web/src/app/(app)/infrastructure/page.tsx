"use client";
import { useState } from "react";
import useSWR, { mutate } from "swr";
import { motion } from "framer-motion";
import { api, ApiError, fetcher } from "@/lib/api";
import { PageHeader } from "@/components/page-header";
import { Stagger, StaggerItem } from "@/components/motion";
import { StatusDot } from "@/components/status-dot";
import { Drawer } from "@/components/drawer";
import { Plus, HardDrive, Trash2, Activity } from "lucide-react";
import { useDialog } from "@/components/dialog-provider";
import { useT } from "@/lib/i18n";

type Node = {
  id: string;
  name: string;
  host: string;
  status: string;
  lastSeenAt: string | null;
};

const STATUS_LABEL: Record<string, string> = {
  ONLINE: "online",
  OFFLINE: "offline",
  UNKNOWN: "unknown",
};

export default function InfrastructurePage(): JSX.Element {
  const { data } = useSWR<Node[]>("/nodes", fetcher);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const onlineCount =
    data?.filter((n) => n.status === "ONLINE").length ?? 0;

  return (
    <div className="space-y-8">
      <PageHeader
        title="Infrastructure"
        description="Docker hosts (nodes) that run your Minecraft server containers. Each node runs its own agent; the panel talks to them over a shared secret."
        badge={
          data && (
            <span className="chip chip-muted">
              {onlineCount} / {data.length} online
            </span>
          )
        }
        actions={
          <button
            className="btn btn-primary"
            onClick={() => setDrawerOpen(true)}
          >
            <Plus size={16} /> Add node
          </button>
        }
      />

      {data && data.length > 0 ? (
        <Stagger className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {data.map((n) => (
            <StaggerItem key={n.id}>
              <NodeCard node={n} />
            </StaggerItem>
          ))}
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
  async function check(): Promise<void> {
    try {
      await api.get(`/nodes/${node.id}/health`);
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

  return (
    <motion.div whileHover={{ y: -3 }} transition={{ duration: 0.18 }}>
      <div className="tile p-5 h-full flex flex-col">
        <div className="flex items-start gap-3">
          <span className="w-10 h-10 rounded-lg bg-surface-2 grid place-items-center text-ink-secondary shrink-0">
            <HardDrive size={18} />
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="heading-md truncate">{node.name}</h3>
              <StatusDot
                status={node.status === "ONLINE" ? "running" : "stopped"}
                size={6}
              />
            </div>
            <div className="text-xs text-ink-muted truncate font-mono mt-0.5">
              {node.host}
            </div>
          </div>
          <span className={`chip ${tone}`}>{statusLabel}</span>
        </div>

        <div className="mt-auto pt-5 flex items-center gap-2 border-t border-line mt-5">
          <button
            className="btn btn-subtle text-xs !py-1.5 !px-2.5"
            onClick={check}
          >
            <Activity size={13} /> Health
          </button>
          <div className="flex-1" />
          <button
            className="btn-icon btn-ghost !h-8 !w-8"
            onClick={remove}
            aria-label="Delete node"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    </motion.div>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }): JSX.Element {
  return (
    <div className="tile p-14 text-center">
      <div className="mx-auto w-16 h-16 rounded-2xl bg-surface-2 text-ink-secondary grid place-items-center mb-5">
        <HardDrive size={28} />
      </div>
      <h3 className="heading-lg mb-1">No nodes registered</h3>
      <p className="text-ink-secondary max-w-md mx-auto mb-6">
        A node is a Docker host with the cofemine agent running on it. The
        default compose auto-registers the local agent on first boot.
      </p>
      <button className="btn btn-primary" onClick={onAdd}>
        <Plus size={16} /> Add node
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
      title="Add a node"
      description="Register a remote Docker host. The agent on that host must be reachable over HTTPS with the shared token."
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>
            {busy ? "Adding…" : "Add node"}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Display name">
          <input
            className="input"
            placeholder="e.g. eu-west-1"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Agent URL" hint="https://host:4100">
          <input
            className="input font-mono"
            placeholder="https://agent.example.com:4100"
            value={host}
            onChange={(e) => setHost(e.target.value)}
          />
        </Field>
        <Field label="Shared token" hint="Set in AGENT_TOKEN on the remote agent">
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

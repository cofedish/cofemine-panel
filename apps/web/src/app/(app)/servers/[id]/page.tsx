"use client";
import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import useSWR from "swr";
import { api, ApiError, fetcher } from "@/lib/api";
import { ServerConsole } from "@/components/server-console";
import { ServerFiles } from "@/components/server-files";
import { ServerBackups } from "@/components/server-backups";
import { ServerProperties } from "@/components/server-properties";
import { ServerContent } from "@/components/server-content";
import { ServerSchedules } from "@/components/server-schedules";
import { cn } from "@/lib/cn";

type ServerDetail = {
  id: string;
  name: string;
  description: string | null;
  type: string;
  version: string;
  status: string;
  memoryMb: number;
  cpuLimit: number | null;
  ports: unknown;
  env: Record<string, string>;
  node: { id: string; name: string; status: string };
  lastStartedAt: string | null;
};

type Stats = {
  status: string;
  startedAt: string | null;
  cpuPercent: number | null;
  memoryBytes: number | null;
  memoryLimitBytes: number | null;
};

type Player = { online: number; max: number; players: string[] };

type Tab =
  | "overview"
  | "console"
  | "files"
  | "properties"
  | "backups"
  | "schedules"
  | "mods";

const TABS: { key: Tab; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "console", label: "Console" },
  { key: "files", label: "Files" },
  { key: "properties", label: "server.properties" },
  { key: "backups", label: "Backups" },
  { key: "schedules", label: "Schedules" },
  { key: "mods", label: "Mods / Plugins" },
];

export default function ServerDetailPage(): JSX.Element {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("overview");
  const { data, mutate } = useSWR<ServerDetail>(
    id ? `/servers/${id}` : null,
    fetcher,
    { refreshInterval: 5000 }
  );
  const { data: stats } = useSWR<Stats>(
    id ? `/servers/${id}/stats` : null,
    fetcher,
    { refreshInterval: 5000 }
  );
  const { data: players } = useSWR<Player>(
    id ? `/servers/${id}/players` : null,
    fetcher,
    { refreshInterval: 10000 }
  );

  if (!data) return <div className="text-ink-muted">Loading…</div>;

  async function lifecycle(action: "start" | "stop" | "restart" | "kill"): Promise<void> {
    try {
      await api.post(`/servers/${id}/${action}`);
      mutate();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function remove(): Promise<void> {
    if (!data) return;
    if (!confirm(`Delete server "${data.name}"? This is irreversible.`)) return;
    try {
      await api.del(`/servers/${id}`);
      router.push("/servers");
    } catch (err) {
      alert(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function clone(): Promise<void> {
    try {
      const res = await api.post<{ id: string }>(`/servers/${id}/clone`);
      router.push(`/servers/${res.id}`);
    } catch (err) {
      alert(err instanceof ApiError ? err.message : String(err));
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold">{data.name}</h1>
            <StatusBadge status={data.status} />
          </div>
          <div className="text-sm text-ink-secondary mt-1">
            {data.type} · {data.version} · {data.node.name}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-ghost" onClick={() => lifecycle("start")}>
            Start
          </button>
          <button className="btn-ghost" onClick={() => lifecycle("stop")}>
            Stop
          </button>
          <button className="btn-ghost" onClick={() => lifecycle("restart")}>
            Restart
          </button>
          <button className="btn-ghost" onClick={() => lifecycle("kill")}>
            Kill
          </button>
          <button className="btn-ghost" onClick={clone}>
            Clone
          </button>
          <button className="btn-danger" onClick={remove}>
            Delete
          </button>
        </div>
      </div>

      <div className="border-b border-line flex gap-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={cn(
              "px-4 py-2 text-sm rounded-t-md border-b-2",
              tab === t.key
                ? "border-accent text-ink bg-surface-2"
                : "border-transparent text-ink-secondary hover:text-ink"
            )}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div>
        {tab === "overview" && (
          <OverviewTab data={data} stats={stats ?? null} players={players ?? null} />
        )}
        {tab === "console" && <ServerConsole serverId={id} />}
        {tab === "files" && <ServerFiles serverId={id} />}
        {tab === "properties" && <ServerProperties serverId={id} />}
        {tab === "backups" && <ServerBackups serverId={id} />}
        {tab === "schedules" && <ServerSchedules serverId={id} />}
        {tab === "mods" && <ServerContent serverId={id} />}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }): JSX.Element {
  const style: Record<string, string> = {
    running: "bg-accent-soft text-accent",
    starting: "bg-amber-500/20 text-amber-300",
    stopping: "bg-amber-500/20 text-amber-300",
    stopped: "bg-surface-2 text-ink-secondary",
    crashed: "bg-danger/20 text-danger",
  };
  return (
    <span className={cn("badge", style[status] ?? "bg-surface-2 text-ink-secondary")}>
      {status}
    </span>
  );
}

function OverviewTab({
  data,
  stats,
  players,
}: {
  data: ServerDetail;
  stats: Stats | null;
  players: Player | null;
}): JSX.Element {
  const ports = Array.isArray(data.ports) ? (data.ports as any[]) : [];
  return (
    <div className="grid grid-cols-3 gap-4">
      <div className="card p-5 space-y-3 col-span-2">
        <h3 className="font-medium">Runtime</h3>
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <Row label="Type">{data.type}</Row>
          <Row label="Version">{data.version}</Row>
          <Row label="Memory limit">{data.memoryMb} MB</Row>
          <Row label="CPU limit">{data.cpuLimit ?? "—"}</Row>
          <Row label="Node">{data.node.name}</Row>
          <Row label="Last start">
            {data.lastStartedAt
              ? new Date(data.lastStartedAt).toLocaleString()
              : "—"}
          </Row>
          <Row label="Ports">
            {ports
              .map((p) => `${p.host}→${p.container}/${p.protocol}`)
              .join(", ") || "—"}
          </Row>
          <Row label="Env">{Object.keys(data.env ?? {}).length} vars</Row>
        </dl>
      </div>
      <div className="card p-5 space-y-3">
        <h3 className="font-medium">Live stats</h3>
        <Row label="CPU">{stats?.cpuPercent != null ? `${stats.cpuPercent}%` : "—"}</Row>
        <Row label="Memory">
          {stats?.memoryBytes != null
            ? `${(stats.memoryBytes / 1024 / 1024).toFixed(0)} MB / ${((stats.memoryLimitBytes ?? 0) / 1024 / 1024).toFixed(0)} MB`
            : "—"}
        </Row>
        <Row label="Players">
          {players ? `${players.online} / ${players.max}` : "—"}
        </Row>
        {players && players.players.length > 0 && (
          <div className="text-xs text-ink-secondary">{players.players.join(", ")}</div>
        )}
      </div>
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="text-ink truncate">{children}</dd>
    </div>
  );
}

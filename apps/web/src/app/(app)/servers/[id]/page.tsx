"use client";
import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import useSWR from "swr";
import { motion } from "framer-motion";
import { api, ApiError, fetcher } from "@/lib/api";
import { ServerConsole } from "@/components/server-console";
import { ServerFiles } from "@/components/server-files";
import { ServerBackups } from "@/components/server-backups";
import { ServerProperties } from "@/components/server-properties";
import { ServerContent } from "@/components/server-content";
import { ServerSchedules } from "@/components/server-schedules";
import { StatusDot } from "@/components/status-dot";
import { PageHeader } from "@/components/page-header";
import { getServerMeta, ServerTypeIcon } from "@/components/server-icons";
import { cn } from "@/lib/cn";
import {
  Play,
  Square,
  RotateCw,
  Zap,
  Copy,
  Trash2,
  Users,
  Cpu,
  HardDrive as HardDriveIcon,
  Clock,
} from "lucide-react";

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

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "console", label: "Console" },
  { key: "files", label: "Files" },
  { key: "properties", label: "Properties" },
  { key: "backups", label: "Backups" },
  { key: "schedules", label: "Schedules" },
  { key: "content", label: "Mods & Plugins" },
] as const;
type Tab = (typeof TABS)[number]["key"];

export default function ServerDetailPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
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
  const meta = getServerMeta(data.type);

  async function lifecycle(
    action: "start" | "stop" | "restart" | "kill"
  ): Promise<void> {
    try {
      await api.post(`/servers/${id}/${action}`);
      mutate();
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
  async function remove(): Promise<void> {
    if (!data) return;
    if (!confirm(`Delete server "${data.name}"? This is irreversible.`)) return;
    try {
      await api.del(`/servers/${id}`);
      router.push("/");
    } catch (err) {
      alert(err instanceof ApiError ? err.message : String(err));
    }
  }

  return (
    <div className="space-y-8">
      <PageHeader
        breadcrumbs={[
          { label: "Dashboard", href: "/" },
          { label: data.name },
        ]}
        title={data.name}
        description={data.description || undefined}
        badge={
          <span className="chip chip-muted flex items-center gap-1.5">
            <StatusDot status={data.status} size={6} />
            {data.status}
          </span>
        }
        actions={
          <>
            <button
              className="btn btn-ghost"
              onClick={() => lifecycle("start")}
            >
              <Play size={15} /> Start
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => lifecycle("stop")}
            >
              <Square size={15} /> Stop
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => lifecycle("restart")}
            >
              <RotateCw size={15} /> Restart
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => lifecycle("kill")}
              title="Kill"
            >
              <Zap size={15} />
            </button>
            <button className="btn btn-ghost" onClick={clone} title="Clone">
              <Copy size={15} />
            </button>
            <button className="btn btn-danger" onClick={remove}>
              <Trash2 size={15} />
            </button>
          </>
        }
      />

      {/* Hero banner with live stats overlaid */}
      <section
        className="relative overflow-hidden rounded-2xl text-white p-7 min-h-[160px]"
        style={{
          background: `linear-gradient(135deg, ${meta.from}, ${meta.to})`,
        }}
      >
        <span className="absolute inset-0 bg-grid-pattern opacity-25" />
        <meta.Icon
          size={220}
          strokeWidth={1.25}
          className="absolute -right-6 -bottom-8 opacity-15 pointer-events-none"
        />
        <div className="relative flex items-center gap-3 mb-5">
          <ServerTypeIcon type={data.type} size={38} />
          <div>
            <div className="text-[10px] uppercase tracking-widest opacity-75">
              {meta.label}
            </div>
            <div className="text-sm opacity-90">{data.version}</div>
          </div>
        </div>
        <div className="relative grid grid-cols-2 md:grid-cols-4 gap-6">
          <HeroStat
            icon={<Users size={14} />}
            label="Players"
            value={
              players
                ? `${players.online}/${players.max}`
                : data.status === "running"
                  ? "…"
                  : "—"
            }
          />
          <HeroStat
            icon={<Cpu size={14} />}
            label="CPU"
            value={
              stats?.cpuPercent != null ? `${stats.cpuPercent}%` : "—"
            }
          />
          <HeroStat
            icon={<HardDriveIcon size={14} />}
            label="Memory"
            value={
              stats?.memoryBytes != null
                ? `${(stats.memoryBytes / 1024 / 1024).toFixed(0)} MB`
                : `${data.memoryMb} MB limit`
            }
          />
          <HeroStat
            icon={<Clock size={14} />}
            label="Last start"
            value={
              data.lastStartedAt
                ? new Date(data.lastStartedAt).toLocaleString()
                : "never"
            }
          />
        </div>
      </section>

      {/* Tabs */}
      <div className="border-b border-line flex gap-1 overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "relative px-4 py-3 text-sm whitespace-nowrap transition-colors",
              tab === t.key
                ? "text-ink font-medium"
                : "text-ink-secondary hover:text-ink"
            )}
          >
            {t.label}
            {tab === t.key && (
              <motion.span
                layoutId="server-tab"
                className="absolute -bottom-px left-2 right-2 h-0.5 bg-[rgb(var(--accent))] rounded-full"
                transition={{ type: "spring", duration: 0.3 }}
              />
            )}
          </button>
        ))}
      </div>

      <div>
        {tab === "overview" && (
          <Overview data={data} players={players ?? null} />
        )}
        {tab === "console" && <ServerConsole serverId={id} />}
        {tab === "files" && <ServerFiles serverId={id} />}
        {tab === "properties" && <ServerProperties serverId={id} />}
        {tab === "backups" && <ServerBackups serverId={id} />}
        {tab === "schedules" && <ServerSchedules serverId={id} />}
        {tab === "content" && <ServerContent serverId={id} />}
      </div>
    </div>
  );
}

function HeroStat({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
}): JSX.Element {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-widest opacity-80">
        {icon}
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tracking-tight tabular-nums truncate">
        {value}
      </div>
    </div>
  );
}

function Overview({
  data,
  players,
}: {
  data: ServerDetail;
  players: Player | null;
}): JSX.Element {
  const ports = Array.isArray(data.ports) ? (data.ports as any[]) : [];
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
      <div className="tile p-6 lg:col-span-2 space-y-5">
        <h3 className="heading-md">Runtime configuration</h3>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4 text-sm">
          <Row label="Server type">{data.type}</Row>
          <Row label="Version">{data.version}</Row>
          <Row label="Memory limit">{data.memoryMb} MB</Row>
          <Row label="CPU limit">{data.cpuLimit ?? "unlimited"}</Row>
          <Row label="Node">{data.node.name}</Row>
          <Row label="Ports">
            {ports.length > 0
              ? ports
                  .map((p) => `${p.host}→${p.container}/${p.protocol}`)
                  .join(", ")
              : "—"}
          </Row>
          <Row label="Env vars" full>
            {Object.keys(data.env ?? {}).length === 0 ? (
              <span className="text-ink-muted italic">none</span>
            ) : (
              <div className="flex flex-wrap gap-1.5 mt-1">
                {Object.entries(data.env).map(([k, v]) => (
                  <span
                    key={k}
                    className="chip chip-muted font-mono text-[11px]"
                  >
                    {k}={String(v).slice(0, 20)}
                    {String(v).length > 20 ? "…" : ""}
                  </span>
                ))}
              </div>
            )}
          </Row>
        </dl>
      </div>

      <div className="tile p-6 space-y-4">
        <h3 className="heading-md">Players online</h3>
        {players ? (
          <>
            <div className="text-5xl font-semibold tabular-nums">
              {players.online}
              <span className="text-2xl text-ink-muted">/{players.max}</span>
            </div>
            <div className="divider" />
            {players.players.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {players.players.map((p) => (
                  <span key={p} className="chip chip-accent">
                    {p}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-sm text-ink-muted">
                No players online right now.
              </p>
            )}
          </>
        ) : (
          <p className="text-sm text-ink-muted">
            Player list is fetched from the server via RCON. Start the server to
            see players here.
          </p>
        )}
      </div>
    </div>
  );
}

function Row({
  label,
  children,
  full,
}: {
  label: string;
  children: React.ReactNode;
  full?: boolean;
}): JSX.Element {
  return (
    <div className={full ? "sm:col-span-2" : undefined}>
      <dt className="text-xs uppercase tracking-wider text-ink-muted">
        {label}
      </dt>
      <dd className="mt-1 text-ink">{children}</dd>
    </div>
  );
}

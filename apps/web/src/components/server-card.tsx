"use client";
import Link from "next/link";
import useSWR from "swr";
import { motion } from "framer-motion";
import { cn } from "@/lib/cn";
import { fetcher } from "@/lib/api";
import { Users } from "lucide-react";

export interface ServerSummary {
  id: string;
  name: string;
  description?: string | null;
  type: string;
  version: string;
  status: string;
  memoryMb: number;
  ports: unknown;
  node: { id: string; name: string; status: string };
  lastStartedAt?: string | null;
}

/**
 * Per-server-type hero background. No real images — a tastefully stylised
 * gradient-and-block tile, which stays on-brand regardless of accent choice.
 */
const HERO: Record<string, { from: string; to: string; label: string }> = {
  VANILLA: { from: "#14532d", to: "#22c55e", label: "Vanilla" },
  PAPER: { from: "#334155", to: "#f8fafc", label: "Paper" },
  PURPUR: { from: "#4c1d95", to: "#c084fc", label: "Purpur" },
  FABRIC: { from: "#78350f", to: "#facc15", label: "Fabric" },
  FORGE: { from: "#0f172a", to: "#64748b", label: "Forge" },
  NEOFORGE: { from: "#0f172a", to: "#f97316", label: "NeoForge" },
  MOHIST: { from: "#18181b", to: "#f43f5e", label: "Mohist" },
  QUILT: { from: "#7c2d12", to: "#f59e0b", label: "Quilt" },
};
const DEFAULT_HERO = { from: "#0f172a", to: "#475569", label: "Server" };

const STATUS_BADGE: Record<string, string> = {
  running: "badge badge-success",
  starting: "badge badge-warning",
  stopping: "badge badge-warning",
  stopped: "badge badge-muted",
  crashed: "badge badge-danger",
  unknown: "badge badge-muted",
};

const STATUS_DOT: Record<string, string> = {
  running: "bg-success",
  starting: "bg-warning",
  stopping: "bg-warning",
  stopped: "bg-ink-muted",
  crashed: "bg-danger",
  unknown: "bg-ink-muted",
};

export function ServerCard({ server }: { server: ServerSummary }): JSX.Element {
  const hero = HERO[server.type] ?? DEFAULT_HERO;

  // Live players count — polls only when the server is running.
  const { data: players } = useSWR<{ online: number; max: number }>(
    server.status === "running" ? `/servers/${server.id}/players` : null,
    fetcher,
    { refreshInterval: 20000 }
  );

  const ports = Array.isArray(server.ports) ? (server.ports as any[]) : [];
  const primary = ports[0];

  return (
    <motion.div whileHover={{ y: -4 }} transition={{ duration: 0.18 }}>
      <Link
        href={`/servers/${server.id}`}
        className="card card-interactive overflow-hidden block h-full"
      >
        {/* Hero */}
        <div
          className="relative h-28 p-5 flex items-end text-white overflow-hidden"
          style={{
            background: `linear-gradient(135deg, ${hero.from}, ${hero.to})`,
          }}
        >
          <span className="absolute inset-0 bg-grid opacity-30" />
          <span className="absolute top-3 right-3">
            <span
              className={cn(STATUS_BADGE[server.status] ?? STATUS_BADGE.unknown)}
            >
              <span
                className={cn(
                  "w-1.5 h-1.5 rounded-full mr-1.5",
                  STATUS_DOT[server.status] ?? STATUS_DOT.unknown,
                  server.status === "running" && "animate-pulse"
                )}
              />
              {server.status}
            </span>
          </span>
          <div className="relative">
            <div className="text-[11px] uppercase tracking-wider opacity-75">
              {hero.label}
            </div>
            <div className="font-semibold text-xl leading-tight truncate">
              {server.name}
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          {server.description ? (
            <p className="text-sm text-ink-secondary line-clamp-2">
              {server.description}
            </p>
          ) : (
            <p className="text-sm text-ink-muted italic">No description</p>
          )}
          <div className="grid grid-cols-3 gap-3 text-sm">
            <Stat
              icon={<Users size={13} />}
              label="Players"
              value={
                players
                  ? `${players.online}/${players.max}`
                  : server.status === "running"
                    ? "…"
                    : "—"
              }
            />
            <Stat label="Version" value={server.version} />
            <Stat label="Port" value={primary ? String(primary.host) : "—"} />
          </div>
          <div className="pt-3 border-t border-line flex items-center justify-between text-xs">
            <span className="text-ink-muted">
              Node · <span className="text-ink-secondary">{server.node.name}</span>
            </span>
            <span className="text-accent group-hover:underline">Open →</span>
          </div>
        </div>
      </Link>
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
    <div>
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-ink-muted">
        {icon}
        {label}
      </div>
      <div className="text-ink mt-0.5 text-sm font-medium truncate">{value}</div>
    </div>
  );
}

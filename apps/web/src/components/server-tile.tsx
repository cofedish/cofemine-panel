"use client";
import Link from "next/link";
import useSWR from "swr";
import { motion } from "framer-motion";
import { fetcher } from "@/lib/api";
import { cn } from "@/lib/cn";
import { StatusDot } from "./status-dot";
import { Users, ArrowUpRight, Cpu } from "lucide-react";

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

/** Server-type hero. Each gets a distinct gradient + glyph. */
const HERO: Record<
  string,
  { from: string; to: string; glyph: string; label: string }
> = {
  VANILLA: { from: "#0b3d1a", to: "#22c55e", glyph: "V", label: "Vanilla" },
  PAPER: { from: "#0f172a", to: "#94a3b8", glyph: "P", label: "Paper" },
  PURPUR: { from: "#3b0764", to: "#a855f7", glyph: "PU", label: "Purpur" },
  FABRIC: { from: "#713f12", to: "#fbbf24", glyph: "F", label: "Fabric" },
  FORGE: { from: "#0f172a", to: "#475569", glyph: "FG", label: "Forge" },
  NEOFORGE: { from: "#0c0a09", to: "#f97316", glyph: "NF", label: "NeoForge" },
  MOHIST: { from: "#18181b", to: "#ef4444", glyph: "M", label: "Mohist" },
  QUILT: { from: "#78350f", to: "#f59e0b", glyph: "Q", label: "Quilt" },
};
const DEFAULT_HERO = {
  from: "#0f172a",
  to: "#475569",
  glyph: "·",
  label: "Server",
};

export function ServerTile({ server }: { server: ServerSummary }): JSX.Element {
  const hero = HERO[server.type] ?? DEFAULT_HERO;

  const { data: players } = useSWR<{ online: number; max: number }>(
    server.status === "running" ? `/servers/${server.id}/players` : null,
    fetcher,
    { refreshInterval: 20000 }
  );

  const ports = Array.isArray(server.ports) ? (server.ports as any[]) : [];
  const primary = ports[0];

  return (
    <motion.div whileHover={{ y: -3 }} transition={{ duration: 0.18 }}>
      <Link
        href={`/servers/${server.id}`}
        className="tile tile-interactive overflow-hidden block h-full group"
      >
        {/* Hero — gradient with large glyph + subtle grid pattern */}
        <div
          className="relative h-36 flex items-center justify-center text-white overflow-hidden"
          style={{
            background: `linear-gradient(135deg, ${hero.from}, ${hero.to})`,
          }}
        >
          <span className="absolute inset-0 bg-grid-pattern opacity-25" />
          <span
            className="relative font-display text-[80px] font-black leading-none opacity-90 select-none"
            style={{ letterSpacing: "-0.05em" }}
          >
            {hero.glyph}
          </span>
          <span className="absolute top-3 left-3 text-[10px] uppercase tracking-widest font-semibold opacity-80">
            {hero.label}
          </span>
          <span className="absolute top-3 right-3 flex items-center gap-1.5 bg-black/25 backdrop-blur-sm rounded-full px-2 py-0.5 text-[11px]">
            <StatusDot status={server.status} size={6} />
            <span>{server.status}</span>
          </span>
          <span className="absolute bottom-3 right-3 text-[10px] font-mono opacity-70">
            {server.version}
          </span>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          <div>
            <div className="flex items-start justify-between gap-2">
              <h3 className="heading-md truncate">{server.name}</h3>
              <ArrowUpRight
                size={16}
                className="text-ink-muted shrink-0 mt-0.5 group-hover:text-[rgb(var(--accent))] group-hover:-translate-y-0.5 group-hover:translate-x-0.5 transition-all"
              />
            </div>
            {server.description ? (
              <p className="text-sm text-ink-secondary mt-1 line-clamp-2">
                {server.description}
              </p>
            ) : (
              <p className="text-sm text-ink-muted mt-1 italic">
                No description
              </p>
            )}
          </div>

          <div className="grid grid-cols-3 gap-4 pt-3 border-t border-line">
            <Cell
              icon={<Users size={12} />}
              label="Players"
              value={
                players
                  ? `${players.online}/${players.max}`
                  : server.status === "running"
                    ? "…"
                    : "—"
              }
            />
            <Cell
              icon={<Cpu size={12} />}
              label="Memory"
              value={`${Math.round(server.memoryMb / 1024)}G`}
            />
            <Cell
              label="Port"
              value={primary ? String(primary.host) : "—"}
            />
          </div>

          <div className="flex items-center justify-between text-xs text-ink-muted">
            <span>
              Node <span className="text-ink-secondary">{server.node.name}</span>
            </span>
            {server.lastStartedAt ? (
              <span>Last start {timeAgo(server.lastStartedAt)}</span>
            ) : (
              <span>Never started</span>
            )}
          </div>
        </div>
      </Link>
    </motion.div>
  );
}

function Cell({
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
        <span>{label}</span>
      </div>
      <div className="text-sm font-medium text-ink mt-0.5 tabular-nums">
        {value}
      </div>
    </div>
  );
}

function timeAgo(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

/** Old component alias for files that still import ServerCard. */
export const ServerCard = ServerTile;

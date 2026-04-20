"use client";
import Link from "next/link";
import { motion } from "framer-motion";
import { cn } from "@/lib/cn";
import { Server as ServerIcon, Cpu, Users, Gauge } from "lucide-react";

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

const STATUS_BADGE: Record<string, string> = {
  running: "badge badge-success",
  starting: "badge badge-warning",
  stopping: "badge badge-warning",
  stopped: "badge badge-muted",
  crashed: "badge badge-danger",
  unknown: "badge badge-muted",
};

const STATUS_DOT: Record<string, string> = {
  running: "bg-success animate-pulse",
  starting: "bg-warning",
  stopping: "bg-warning",
  stopped: "bg-ink-muted",
  crashed: "bg-danger",
  unknown: "bg-ink-muted",
};

export function ServerCard({ server }: { server: ServerSummary }): JSX.Element {
  const ports = Array.isArray(server.ports) ? (server.ports as any[]) : [];
  const primary = ports[0];
  return (
    <motion.div whileHover={{ y: -3 }} transition={{ duration: 0.18 }}>
      <Link
        href={`/servers/${server.id}`}
        className="card card-interactive p-5 block h-full"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex items-start gap-3">
            <span className="relative mt-0.5 w-10 h-10 rounded-lg bg-accent-soft text-accent grid place-items-center block-accent shrink-0">
              <ServerIcon size={18} />
              <span
                className={cn(
                  "absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full ring-2 ring-surface-1",
                  STATUS_DOT[server.status] ?? STATUS_DOT.unknown
                )}
              />
            </span>
            <div className="min-w-0">
              <div className="font-semibold text-base truncate">
                {server.name}
              </div>
              {server.description && (
                <div className="text-sm text-ink-muted mt-0.5 line-clamp-2">
                  {server.description}
                </div>
              )}
            </div>
          </div>
          <span
            className={cn(STATUS_BADGE[server.status] ?? STATUS_BADGE.unknown)}
          >
            {server.status}
          </span>
        </div>
        <div className="mt-5 grid grid-cols-3 gap-3">
          <Info icon={<Cpu size={13} />} label="Runtime">
            {server.type} · {server.version}
          </Info>
          <Info icon={<Gauge size={13} />} label="Memory">
            {server.memoryMb} MB
          </Info>
          <Info icon={<Users size={13} />} label="Port">
            {primary ? primary.host : "—"}
          </Info>
        </div>
        <div className="mt-4 pt-4 border-t border-line flex items-center justify-between text-xs">
          <span className="text-ink-muted">
            Node · <span className="text-ink-secondary">{server.node.name}</span>
          </span>
          <span className="text-ink-muted">
            {server.lastStartedAt
              ? `Last start ${timeAgo(server.lastStartedAt)}`
              : "Never started"}
          </span>
        </div>
      </Link>
    </motion.div>
  );
}

function Info({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-ink-muted">
        {icon}
        {label}
      </div>
      <div className="text-ink mt-1 text-sm truncate">{children}</div>
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

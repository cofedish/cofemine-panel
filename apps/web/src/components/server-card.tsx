"use client";
import Link from "next/link";
import { cn } from "@/lib/cn";

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

const STATUS_STYLE: Record<string, string> = {
  running: "bg-accent-muted text-accent",
  starting: "bg-amber-500/20 text-amber-300",
  stopping: "bg-amber-500/20 text-amber-300",
  stopped: "bg-zinc-700/40 text-zinc-300",
  crashed: "bg-danger/20 text-danger",
  unknown: "bg-zinc-700/40 text-zinc-400",
};

export function ServerCard({ server }: { server: ServerSummary }): JSX.Element {
  const ports = Array.isArray(server.ports) ? (server.ports as any[]) : [];
  const primary = ports[0];
  return (
    <Link
      href={`/servers/${server.id}`}
      className="card p-5 hover:border-accent/40 transition-colors block"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="font-semibold text-lg truncate">{server.name}</div>
          {server.description && (
            <div className="text-sm text-zinc-400 mt-0.5 line-clamp-2">
              {server.description}
            </div>
          )}
        </div>
        <span className={cn("badge", STATUS_STYLE[server.status] ?? STATUS_STYLE.unknown)}>
          {server.status}
        </span>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-3 text-xs">
        <Info label="Type">{server.type}</Info>
        <Info label="Version">{server.version}</Info>
        <Info label="Memory">{server.memoryMb} MB</Info>
        <Info label="Node">{server.node.name}</Info>
        <Info label="Port">{primary ? primary.host : "—"}</Info>
        <Info label="Last start">
          {server.lastStartedAt
            ? new Date(server.lastStartedAt).toLocaleString()
            : "—"}
        </Info>
      </div>
    </Link>
  );
}

function Info({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div>
      <div className="text-zinc-500 uppercase tracking-wide">{label}</div>
      <div className="text-zinc-200 mt-0.5 truncate">{children}</div>
    </div>
  );
}

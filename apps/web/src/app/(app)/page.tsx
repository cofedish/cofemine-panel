"use client";
import useSWR from "swr";
import Link from "next/link";
import { fetcher } from "@/lib/api";
import { ServerCard, type ServerSummary } from "@/components/server-card";
import { Stagger, StaggerItem } from "@/components/motion";
import { Server, HardDrive, Users, Plus } from "lucide-react";

export default function Dashboard(): JSX.Element {
  const { data: servers } = useSWR<ServerSummary[]>("/servers", fetcher);
  const { data: nodes } = useSWR<Array<{ id: string; status: string }>>(
    "/nodes",
    fetcher
  );
  const { data: users } = useSWR<Array<unknown>>("/users", fetcher);

  const runningCount =
    servers?.filter((s) => s.status === "running").length ?? 0;

  return (
    <div className="space-y-10">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="heading-xl">Dashboard</h1>
          <p className="text-ink-muted mt-2">
            {servers && servers.length > 0
              ? `${servers.length} server${servers.length === 1 ? "" : "s"}, ${runningCount} running.`
              : "Spin up your first Minecraft server in under a minute."}
          </p>
        </div>
        <Link href="/servers/new" className="btn-primary">
          <Plus size={16} /> Create server
        </Link>
      </div>

      <Stagger className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StaggerItem>
          <Stat
            icon={<Server size={18} />}
            label="Servers"
            value={servers?.length ?? "—"}
            hint={
              servers && servers.length > 0
                ? `${runningCount} running`
                : "none yet"
            }
          />
        </StaggerItem>
        <StaggerItem>
          <Stat
            icon={<HardDrive size={18} />}
            label="Nodes online"
            value={
              nodes
                ? `${nodes.filter((n) => n.status === "ONLINE").length}/${nodes.length}`
                : "—"
            }
            hint="Docker hosts"
          />
        </StaggerItem>
        <StaggerItem>
          <Stat
            icon={<Users size={18} />}
            label="Team"
            value={users?.length ?? "—"}
            hint="members with access"
          />
        </StaggerItem>
      </Stagger>

      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="heading-lg">Your servers</h2>
          {servers && servers.length > 0 && (
            <Link
              href="/servers"
              className="text-sm text-ink-secondary hover:text-accent transition-colors"
            >
              View all →
            </Link>
          )}
        </div>
        {servers && servers.length > 0 ? (
          <Stagger className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {servers.slice(0, 6).map((s) => (
              <StaggerItem key={s.id}>
                <ServerCard server={s} />
              </StaggerItem>
            ))}
          </Stagger>
        ) : (
          <EmptyState />
        )}
      </section>
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  hint?: string;
}): JSX.Element {
  return (
    <div className="card p-5 flex items-center gap-4">
      <div className="w-11 h-11 rounded-lg bg-accent-soft text-accent grid place-items-center block-accent">
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-[11px] uppercase tracking-wider text-ink-muted">
          {label}
        </div>
        <div className="text-2xl font-semibold mt-0.5">{value}</div>
        {hint && <div className="text-xs text-ink-muted mt-0.5">{hint}</div>}
      </div>
    </div>
  );
}

function EmptyState(): JSX.Element {
  return (
    <div className="card p-12 text-center">
      <div className="mx-auto w-14 h-14 rounded-2xl bg-accent-soft text-accent grid place-items-center block-accent mb-4">
        <Server size={24} />
      </div>
      <div className="heading-lg mb-1">No servers yet</div>
      <p className="text-ink-muted max-w-md mx-auto mb-5">
        Pick a type (Vanilla, Paper, Fabric, Forge…), choose a version, and the
        agent will spin up a fresh Minecraft container for you.
      </p>
      <Link href="/servers/new" className="btn-primary">
        <Plus size={16} /> Create your first server
      </Link>
    </div>
  );
}

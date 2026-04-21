"use client";
import useSWR from "swr";
import Link from "next/link";
import { fetcher } from "@/lib/api";
import { ServerTile, type ServerSummary } from "@/components/server-tile";
import { Stagger, StaggerItem } from "@/components/motion";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import {
  Plus,
  ServerCog,
  Radio,
  Users as UsersIcon,
  HardDrive,
  Plug,
} from "lucide-react";

export default function Dashboard(): JSX.Element {
  const { data: servers, isLoading } = useSWR<ServerSummary[]>(
    "/servers",
    fetcher,
    { refreshInterval: 15000 }
  );
  const { data: nodes } = useSWR<Array<{ id: string; status: string }>>(
    "/nodes",
    fetcher
  );

  const running = servers?.filter((s) => s.status === "running").length ?? 0;
  const total = servers?.length ?? 0;
  const onlineNodes = nodes?.filter((n) => n.status === "ONLINE").length ?? 0;

  return (
    <div className="space-y-10">
      <PageHeader
        title="Dashboard"
        description={
          total === 0
            ? "No servers yet — spin up your first Minecraft server in under a minute."
            : "A live view of every Minecraft server you operate."
        }
        actions={
          <Link href="/servers/new" className="btn btn-primary">
            <Plus size={16} /> New server
          </Link>
        }
      />

      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          icon={<ServerCog size={18} />}
          label="Servers"
          value={total}
          hint={total === 0 ? "none yet" : `${running} running`}
          tone="accent"
        />
        <StatCard
          icon={<Radio size={18} />}
          label="Running"
          value={running}
          hint={`${total - running} idle`}
          tone="success"
        />
        <StatCard
          icon={<HardDrive size={18} />}
          label="Nodes online"
          value={nodes ? `${onlineNodes}/${nodes.length}` : "—"}
          hint="Docker hosts"
        />
        <StatCard
          icon={<UsersIcon size={18} />}
          label="Total players"
          value="—"
          hint="live across servers"
        />
      </section>

      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="heading-lg">Your servers</h2>
          <span className="text-sm text-ink-muted">
            {total === 0 ? "Empty" : `${total} total`}
          </span>
        </div>
        {isLoading ? (
          <GridSkeleton />
        ) : total === 0 ? (
          <EmptyState />
        ) : (
          <Stagger className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
            {servers!.map((s) => (
              <StaggerItem key={s.id}>
                <ServerTile server={s} />
              </StaggerItem>
            ))}
          </Stagger>
        )}
      </section>
    </div>
  );
}

function GridSkeleton(): JSX.Element {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="tile overflow-hidden">
          <div className="h-36 bg-surface-2 animate-pulse" />
          <div className="p-5 space-y-3">
            <div className="h-4 bg-surface-2 rounded w-3/4 animate-pulse" />
            <div className="h-3 bg-surface-2 rounded w-full animate-pulse" />
            <div className="h-3 bg-surface-2 rounded w-2/3 animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState(): JSX.Element {
  return (
    <div className="tile p-14 text-center">
      <div className="mx-auto w-16 h-16 rounded-2xl bg-[rgb(var(--accent-soft))] text-[rgb(var(--accent))] grid place-items-center mb-5">
        <ServerCog size={28} />
      </div>
      <h3 className="heading-lg mb-1">Start your first server</h3>
      <p className="text-ink-secondary max-w-md mx-auto mb-6">
        Pick a type (Vanilla, Paper, Fabric, Forge…), choose a version, and
        we'll bring up a fresh Minecraft container for you.
      </p>
      <div className="flex items-center justify-center gap-3">
        <Link href="/servers/new" className="btn btn-primary">
          <Plus size={16} /> Create server
        </Link>
        <Link href="/integrations" className="btn btn-ghost">
          <Plug size={16} /> Integrations
        </Link>
      </div>
    </div>
  );
}

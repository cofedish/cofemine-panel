"use client";
import useSWR from "swr";
import Link from "next/link";
import { fetcher } from "@/lib/api";
import { ServerCard, type ServerSummary } from "@/components/server-card";
import { Stagger, StaggerItem } from "@/components/motion";
import { Server, Plus } from "lucide-react";

export default function Dashboard(): JSX.Element {
  const { data: servers, isLoading } = useSWR<ServerSummary[]>(
    "/servers",
    fetcher,
    { refreshInterval: 15000 }
  );

  const running = servers?.filter((s) => s.status === "running").length ?? 0;
  const total = servers?.length ?? 0;

  return (
    <div className="space-y-8">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="heading-xl">Dashboard</h1>
          <p className="text-ink-secondary mt-2">
            {total === 0
              ? "No servers yet. Spin up your first Minecraft server in under a minute."
              : `${total} server${total === 1 ? "" : "s"} · ${running} running`}
          </p>
        </div>
        <Link href="/servers/new" className="btn-primary">
          <Plus size={16} /> New server
        </Link>
      </header>

      {isLoading ? (
        <GridSkeleton />
      ) : total === 0 ? (
        <EmptyState />
      ) : (
        <Stagger className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {servers!.map((s) => (
            <StaggerItem key={s.id}>
              <ServerCard server={s} />
            </StaggerItem>
          ))}
        </Stagger>
      )}
    </div>
  );
}

function GridSkeleton(): JSX.Element {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="card overflow-hidden">
          <div className="h-28 bg-surface-2 animate-pulse" />
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
    <div className="card p-12 text-center relative overflow-hidden">
      <span className="tile-glow" />
      <div className="relative">
        <div className="mx-auto w-14 h-14 rounded-2xl bg-accent-soft text-accent grid place-items-center mb-4">
          <Server size={24} />
        </div>
        <div className="heading-lg mb-1">Start your first server</div>
        <p className="text-ink-secondary max-w-md mx-auto mb-5">
          Pick a type (Vanilla, Paper, Fabric, Forge…), choose a version, and
          we'll bring up a fresh Minecraft container for you.
        </p>
        <Link href="/servers/new" className="btn-primary">
          <Plus size={16} /> Create server
        </Link>
      </div>
    </div>
  );
}

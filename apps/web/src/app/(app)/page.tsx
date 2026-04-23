"use client";
import useSWR from "swr";
import Link from "next/link";
import { fetcher } from "@/lib/api";
import { ServerTile, type ServerSummary } from "@/components/server-tile";
import { Stagger, StaggerItem } from "@/components/motion";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { useT } from "@/lib/i18n";
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
  const { t } = useT();

  const running = servers?.filter((s) => s.status === "running").length ?? 0;
  const total = servers?.length ?? 0;
  const onlineNodes = nodes?.filter((n) => n.status === "ONLINE").length ?? 0;

  return (
    <div className="space-y-10">
      <PageHeader
        title={t("dashboard.title")}
        description={t("dashboard.subtitle")}
        actions={
          <Link href="/servers/new" className="btn btn-primary">
            <Plus size={16} /> {t("dashboard.newServer")}
          </Link>
        }
      />

      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          icon={<ServerCog size={18} />}
          label={t("dashboard.stats.servers")}
          value={total}
          hint={
            total === 0
              ? t("dashboard.stats.noneYet")
              : t("dashboard.stats.runningNote", { n: running })
          }
          tone="accent"
        />
        <StatCard
          icon={<Radio size={18} />}
          label={t("dashboard.stats.running")}
          value={running}
          hint={t("dashboard.stats.idle", { n: total - running })}
          tone="success"
        />
        <StatCard
          icon={<HardDrive size={18} />}
          label={t("dashboard.stats.nodes")}
          value={nodes ? `${onlineNodes}/${nodes.length}` : "—"}
          hint={t("dashboard.stats.dockerHosts")}
        />
        <StatCard
          icon={<UsersIcon size={18} />}
          label={t("dashboard.stats.players")}
          value="—"
          hint={t("dashboard.stats.liveAcrossServers")}
        />
      </section>

      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="heading-lg">{t("dashboard.yourServers")}</h2>
          <span className="text-sm text-ink-muted">
            {total === 0
              ? t("dashboard.empty")
              : t("dashboard.total", { n: total })}
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
  const { t } = useT();
  return (
    <div className="tile p-14 text-center">
      <div className="mx-auto w-16 h-16 rounded-2xl bg-[rgb(var(--accent-soft))] text-[rgb(var(--accent))] grid place-items-center mb-5">
        <ServerCog size={28} />
      </div>
      <h3 className="heading-lg mb-1">{t("dashboard.startFirst.title")}</h3>
      <p className="text-ink-secondary max-w-md mx-auto mb-6">
        {t("dashboard.startFirst.body")}
      </p>
      <div className="flex items-center justify-center gap-3">
        <Link href="/servers/new" className="btn btn-primary">
          <Plus size={16} /> {t("dashboard.createServer")}
        </Link>
        <Link href="/integrations" className="btn btn-ghost">
          <Plug size={16} /> {t("nav.integrations")}
        </Link>
      </div>
    </div>
  );
}

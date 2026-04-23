"use client";
import Link from "next/link";
import useSWR from "swr";
import { motion } from "framer-motion";
import { fetcher } from "@/lib/api";
import { StatusDot } from "./status-dot";
import { ServerTypeHero, getServerMeta } from "./server-icons";
import { cn } from "@/lib/cn";
import { Users, ArrowUpRight, Cpu } from "lucide-react";
import { useT } from "@/lib/i18n";

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


export function ServerTile({ server }: { server: ServerSummary }): JSX.Element {
  const meta = getServerMeta(server.type);
  const { t } = useT();

  const { data: players } = useSWR<{ online: number; max: number }>(
    server.status === "running" ? `/servers/${server.id}/players` : null,
    fetcher,
    { refreshInterval: 20000 }
  );
  const { data: icon } = useSWR<{ data: string | null }>(
    `/servers/${server.id}/icon`,
    fetcher,
    { shouldRetryOnError: false, revalidateOnFocus: false }
  );

  const ports = Array.isArray(server.ports) ? (server.ports as any[]) : [];
  const primary = ports[0];

  return (
    <motion.div whileHover={{ y: -3 }} transition={{ duration: 0.18 }}>
      <Link
        href={`/servers/${server.id}`}
        className="tile tile-interactive overflow-hidden block h-full group"
      >
        <ServerTypeHero type={server.type} height={144} glyphSize={80}>
          <span className="absolute top-3 left-3 text-[10px] uppercase tracking-widest font-semibold opacity-80">
            {meta.label}
          </span>
          <span className="absolute top-3 right-3 flex items-center gap-1.5 bg-black/25 backdrop-blur-sm rounded-full px-2 py-0.5 text-[11px]">
            <StatusDot status={server.status} size={6} />
            <span>{server.status}</span>
          </span>
          {server.version && server.version !== "LATEST" && (
            <span className="absolute bottom-3 right-3 text-[10px] font-mono opacity-70">
              {server.version}
            </span>
          )}
          {icon?.data && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={icon.data}
              alt=""
              className={cn(
                "absolute bottom-3 left-3 w-12 h-12 rounded-md border border-white/30 shadow-md",
                "pixel-art:image-rendering-pixelated"
              )}
              style={{ imageRendering: "pixelated" }}
              draggable={false}
            />
          )}
        </ServerTypeHero>

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
              label={t("tile.players")}
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
              label={t("tile.memory")}
              value={`${Math.round(server.memoryMb / 1024)}G`}
            />
            <Cell
              label={t("tile.port")}
              value={primary ? String(primary.host) : "—"}
            />
          </div>

          <div className="flex items-center justify-between text-xs text-ink-muted">
            <span>
              {t("tile.node")}{" "}
              <span className="text-ink-secondary">{server.node.name}</span>
            </span>
            {server.lastStartedAt ? (
              <span>{t("tile.lastStart", { ago: timeAgo(server.lastStartedAt, t) })}</span>
            ) : (
              <span>{t("tile.neverStarted")}</span>
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

function timeAgo(
  iso: string,
  t: (k: string, v?: Record<string, string | number>) => string
): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return t("time.secondsAgo", { n: Math.max(1, Math.floor(diff)) });
  if (diff < 3600) return t("time.minutesAgo", { n: Math.floor(diff / 60) });
  if (diff < 86400) return t("time.hoursAgo", { n: Math.floor(diff / 3600) });
  return t("time.daysAgo", { n: Math.floor(diff / 86400) });
}

/** Old component alias for files that still import ServerCard. */
export const ServerCard = ServerTile;

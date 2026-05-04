"use client";
import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import useSWR, { mutate } from "swr";
import { motion } from "framer-motion";
import { api, ApiError, fetcher } from "@/lib/api";
import { ServerConsole } from "@/components/server-console";
import { ServerFiles } from "@/components/server-files";
import { ServerBackups } from "@/components/server-backups";
import { ServerProperties } from "@/components/server-properties";
import { ServerContent } from "@/components/server-content";
import { ServerDiagnostics } from "@/components/server-diagnostics";
import { ServerSchedules } from "@/components/server-schedules";
import { LoaderVersionRow } from "@/components/loader-version-editor";
import Link from "next/link";
import { StatusDot } from "@/components/status-dot";
import { PageHeader } from "@/components/page-header";
import { getServerMeta, ServerTypeIcon } from "@/components/server-icons";
import { ImageUpload } from "@/components/image-upload";
import { cn } from "@/lib/cn";
import { useDialog } from "@/components/dialog-provider";
import { useT } from "@/lib/i18n";
import {
  Play,
  Square,
  RotateCw,
  Zap,
  Copy,
  Trash2,
  Wrench,
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
  { key: "overview", i18n: "server.tabs.overview" },
  { key: "console", i18n: "server.tabs.console" },
  { key: "files", i18n: "server.tabs.files" },
  { key: "properties", i18n: "server.tabs.properties" },
  { key: "backups", i18n: "server.tabs.backups" },
  { key: "schedules", i18n: "server.tabs.schedules" },
  { key: "content", i18n: "server.tabs.content" },
  { key: "diagnostics", i18n: "server.tabs.diagnostics" },
] as const;
type Tab = (typeof TABS)[number]["key"];

export default function ServerDetailPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const dialog = useDialog();
  const { t } = useT();
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
  const { data: iconData } = useSWR<{ data: string | null }>(
    id ? `/servers/${id}/icon` : null,
    fetcher,
    { shouldRetryOnError: false, revalidateOnFocus: false }
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
      dialog.alert({
        tone: "danger",
        title: t("common.error"),
        message: err instanceof ApiError ? err.message : String(err),
      });
    }
  }
  async function clone(): Promise<void> {
    try {
      const res = await api.post<{ id: string }>(`/servers/${id}/clone`);
      router.push(`/servers/${res.id}`);
    } catch (err) {
      dialog.alert({
        tone: "danger",
        title: t("common.error"),
        message: err instanceof ApiError ? err.message : String(err),
      });
    }
  }
  async function repair(): Promise<void> {
    const ok = await dialog.confirm({
      title: t("server.repairConfirm.title"),
      message: t("server.repairConfirm.body"),
    });
    if (!ok) return;
    try {
      const res = await api.post<{ changed: boolean }>(
        `/servers/${id}/repair`
      );
      dialog.alert({
        tone: "success",
        title: t("common.done"),
        message: res.changed
          ? t("server.repair.doneChanged")
          : t("server.repair.doneUnchanged"),
      });
      mutate();
    } catch (err) {
      dialog.alert({
        tone: "danger",
        title: t("common.error"),
        message: err instanceof ApiError ? err.message : String(err),
      });
    }
  }
  async function remove(): Promise<void> {
    if (!data) return;
    // Typed confirmation. Server delete also nukes /data on the
    // agent (worlds, configs, mods — everything), and we don't
    // want a stray click to wipe months of progress. The user has
    // to retype the server name verbatim before the dialog returns.
    const typed = await dialog.prompt({
      tone: "danger",
      title: t("server.deleteConfirm.title"),
      message: t("server.deleteConfirm.body", { name: data.name }),
      placeholder: data.name,
      okLabel: t("common.delete"),
      validate: (v) =>
        v.trim() === data.name
          ? null
          : t("server.deleteConfirm.mismatch", { name: data.name }),
    });
    if (typed === null) return; // cancelled
    try {
      await api.del(`/servers/${id}`);
      // Pop a toast on the dashboard so the user gets a clear
      // "yes, it's gone" signal after navigation.
      dialog.toast({
        tone: "success",
        message: t("server.deleteConfirm.done", { name: data.name }),
      });
      router.push("/");
    } catch (err) {
      dialog.alert({
        tone: "danger",
        title: t("common.error"),
        message: err instanceof ApiError ? err.message : String(err),
      });
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
            <button
              className="btn btn-ghost"
              onClick={repair}
              title="Repair — rebuild container with current integration keys (preserves /data)"
            >
              <Wrench size={15} />
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
          {iconData?.data ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={iconData.data}
              alt=""
              className="w-12 h-12 rounded-md border border-white/30 shadow-md"
              style={{ imageRendering: "pixelated" }}
            />
          ) : (
            <ServerTypeIcon type={data.type} size={38} />
          )}
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
            label={t("tile.players")}
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
            label={t("server.hero.cpu")}
            value={
              stats?.cpuPercent != null ? `${stats.cpuPercent}%` : "—"
            }
          />
          <HeroStat
            icon={<HardDriveIcon size={14} />}
            label={t("tile.memory")}
            value={
              stats?.memoryBytes != null
                ? `${(stats.memoryBytes / 1024 / 1024).toFixed(0)} MB`
                : t("server.hero.memoryLimit", { mb: data.memoryMb })
            }
          />
          <HeroStat
            icon={<Clock size={14} />}
            label={t("tile.lastStartLabel")}
            value={
              data.lastStartedAt
                ? new Date(data.lastStartedAt).toLocaleString()
                : t("tile.neverStarted")
            }
          />
        </div>
      </section>

      {/* Tabs */}
      <div className="border-b border-line flex gap-1 overflow-x-auto">
        {TABS.map((tb) => (
          <button
            key={tb.key}
            onClick={() => setTab(tb.key)}
            className={cn(
              "relative px-4 py-3 text-sm whitespace-nowrap transition-colors",
              tab === tb.key
                ? "text-ink font-medium"
                : "text-ink-secondary hover:text-ink"
            )}
          >
            {t(tb.i18n)}
            {tab === tb.key && (
              <motion.span
                layoutId="server-tab"
                className="absolute -bottom-px left-2 right-2 h-0.5 bg-[rgb(var(--accent))] rounded-full"
                transition={{ type: "spring", duration: 0.3 }}
              />
            )}
          </button>
        ))}
        {/* Live map sits on its own page rather than as another tab —
            the user wanted it full-viewport for proper situational
            awareness. The tab strip just gets a link to it. */}
        <Link
          href={`/servers/${id}/map`}
          className="relative px-4 py-3 text-sm whitespace-nowrap text-ink-secondary hover:text-ink transition-colors ml-auto"
        >
          {t("server.tabs.map")} ↗
        </Link>
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
        {tab === "diagnostics" && <ServerDiagnostics serverId={id} />}
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
  const { t } = useT();
  const ports = Array.isArray(data.ports) ? (data.ports as any[]) : [];
  return (
    <div className="space-y-5">
      <ServerIconEditor serverId={data.id} />
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
      <div className="tile p-6 lg:col-span-2 space-y-5">
        <h3 className="heading-md">{t("server.overview.runtime")}</h3>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4 text-sm">
          <Row label={t("server.hero.serverType")}>
            <DetachableType server={data} />
          </Row>
          <Row label={t("server.hero.version")}>{data.version}</Row>
          <Row label={t("server.overview.loaderVersion")}>
            <LoaderVersionRow server={data} />
          </Row>
          <Row label={t("server.overview.memoryLimit")}>
            {data.memoryMb} MB
          </Row>
          <Row label={t("server.overview.cpuLimit")}>
            {data.cpuLimit ?? t("server.overview.unlimited")}
          </Row>
          <Row label={t("tile.node")}>{data.node.name}</Row>
          <Row label={t("server.overview.ports")}>
            {ports.length > 0
              ? ports
                  .map((p) => `${p.host}→${p.container}/${p.protocol}`)
                  .join(", ")
              : "—"}
          </Row>
          <Row label={t("server.overview.env")} full>
            {Object.keys(data.env ?? {}).length === 0 ? (
              <span className="text-ink-muted italic">
                {t("server.overview.envNone")}
              </span>
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
        <h3 className="heading-md">{t("server.overview.players")}</h3>
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
                {t("server.overview.noPlayers")}
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
    </div>
  );
}

/**
 * Icon uploader for a specific server. Writes a 64x64 PNG to
 * /data/server-icon.png via the agent; itzg picks it up on next start.
 */
function ServerIconEditor({ serverId }: { serverId: string }): JSX.Element {
  const { t } = useT();
  // Load the currently-saved icon so the preview isn't empty after a
  // page refresh. useSWR auto-updates when we POST/DELETE and mutate().
  const { data: current } = useSWR<{ data: string | null }>(
    `/servers/${serverId}/icon`,
    fetcher,
    { shouldRetryOnError: false }
  );
  const [value, setValue] = useState<string | null>(null);
  const [valueDirty, setValueDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  // Sync initial value from server when SWR loads (and user hasn't edited).
  useEffect(() => {
    if (!valueDirty) {
      setValue(current?.data ?? null);
    }
  }, [current, valueDirty]);

  function onChange(v: string | null): void {
    setValue(v);
    setValueDirty(true);
  }

  async function save(): Promise<void> {
    if (!value) return;
    setBusy(true);
    setStatus(null);
    try {
      await api.post(`/servers/${serverId}/icon`, { data: value });
      setStatus(t("server.icon.saved"));
      setValueDirty(false);
      await mutate(`/servers/${serverId}/icon`);
    } catch (e) {
      setStatus(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function clear(): Promise<void> {
    setBusy(true);
    setStatus(null);
    try {
      await api.del(`/servers/${serverId}/icon`);
      setValue(null);
      setValueDirty(false);
      setStatus(t("server.icon.removed"));
      await mutate(`/servers/${serverId}/icon`);
    } catch (e) {
      setStatus(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="tile p-6 space-y-4">
      <div>
        <h3 className="heading-md">{t("server.icon.title")}</h3>
        <p className="text-sm text-ink-muted mt-1">
          {t("server.icon.body")}
        </p>
      </div>
      <ImageUpload
        value={value}
        onChange={onChange}
        targetSize={64}
        previewSize={80}
        shape="square"
      />
      <div className="flex gap-2 items-center">
        <button
          className="btn btn-primary"
          onClick={save}
          disabled={!value || busy}
        >
          {busy ? t("server.icon.saving") : t("server.icon.save")}
        </button>
        <button className="btn btn-ghost" onClick={clear} disabled={busy}>
          {t("server.icon.remove")}
        </button>
        {status && (
          <span className="text-xs text-ink-secondary">{status}</span>
        )}
      </div>
    </section>
  );
}

/**
 * Renders the server type as plain text + a "Detach from source"
 * action when the server is still bound to a CF / Modrinth pack.
 * After detach, the server is a regular native-loader install and
 * mc-image-helper stops fighting the user's mod customisations.
 */
function DetachableType({ server }: { server: ServerDetail }): JSX.Element {
  const { t } = useT();
  const dialog = useDialog();
  const [busy, setBusy] = useState(false);
  const isPack = server.type === "CURSEFORGE" || server.type === "MODRINTH";
  async function detach(): Promise<void> {
    const ok = await dialog.confirm({
      tone: "warning",
      title: t("server.detach.confirmTitle"),
      message: t("server.detach.confirmBody"),
      okLabel: t("server.detach.ok"),
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await api.post<{ type: string; loader: string | null }>(
        `/servers/${server.id}/detach-source`
      );
      mutate(`/servers/${server.id}`);
      dialog.toast({
        tone: "success",
        message: t("server.detach.done", {
          type: res.type,
          loader: res.loader ?? "?",
        }),
      });
    } catch (e) {
      dialog.alert({
        tone: "danger",
        title: t("common.error"),
        message: e instanceof ApiError ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span>{server.type}</span>
      {isPack && (
        <button
          className="btn btn-ghost text-xs"
          onClick={() => void detach()}
          disabled={busy}
          title={t("server.detach.hint")}
        >
          {busy ? "…" : t("server.detach.button")}
        </button>
      )}
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

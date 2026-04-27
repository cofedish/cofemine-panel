"use client";
import { useEffect, useState } from "react";
import useSWR, { mutate } from "swr";
import { motion } from "framer-motion";
import { api, ApiError, fetcher } from "@/lib/api";
import { PageHeader } from "@/components/page-header";
import { Stagger, StaggerItem } from "@/components/motion";
import { Drawer } from "@/components/drawer";
import {
  Check,
  Package,
  Key,
  ExternalLink,
  Sparkles,
  Network,
  Mail,
} from "lucide-react";
import { useT } from "@/lib/i18n";

type Integrations = {
  providers: {
    modrinth: { enabled: boolean };
    curseforge: { enabled: boolean; fallback: string };
  };
};

interface IntegrationDef {
  key: "modrinth" | "curseforge";
  name: string;
  tagline: string;
  description: string;
  tone: { from: string; to: string; mark: string };
  website: string;
}

const DEFS: IntegrationDef[] = [
  {
    key: "modrinth",
    name: "Modrinth",
    tagline: "Open mod platform",
    description:
      "Search mods, modpacks, plugins and datapacks from modrinth.com. Installation is fully automatic — pick a version, the agent downloads it.",
    tone: { from: "#064e3b", to: "#10b981", mark: "M" },
    website: "https://modrinth.com",
  },
  {
    key: "curseforge",
    name: "CurseForge",
    tagline: "Mod catalog (API key)",
    description:
      "Search and install mods or modpacks from curseforge.com. Requires a personal API key. Without one, the panel falls back to manual ZIP upload.",
    tone: { from: "#7c2d12", to: "#f59e0b", mark: "CF" },
    website: "https://console.curseforge.com/",
  },
];

type ProxyDisplay = {
  enabled: boolean;
  protocol: "socks" | "http";
  host: string;
  port: number;
  username?: string;
  hasPassword: boolean;
};

type SmtpDisplay = {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  hasPassword: boolean;
  from: string;
  panelUrl: string;
};

export default function IntegrationsPage(): JSX.Element {
  const { data } = useSWR<Integrations>("/integrations", fetcher);
  const { data: proxy } = useSWR<ProxyDisplay>(
    "/integrations/download-proxy",
    fetcher
  );
  const { data: smtp } = useSWR<SmtpDisplay>("/integrations/smtp", fetcher);
  const { t } = useT();
  const [openKey, setOpenKey] = useState<
    "modrinth" | "curseforge" | "download-proxy" | "smtp" | null
  >(null);

  return (
    <div className="space-y-8">
      <PageHeader
        title={t("integrations.title")}
        description={t("integrations.subtitle")}
      />

      <Stagger className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
        {DEFS.map((def) => (
          <StaggerItem key={def.key}>
            <IntegrationCard
              def={def}
              enabled={!!data?.providers[def.key]?.enabled}
              onOpen={() => setOpenKey(def.key)}
            />
          </StaggerItem>
        ))}
        <StaggerItem>
          <DownloadProxyCard
            proxy={proxy ?? null}
            onOpen={() => setOpenKey("download-proxy")}
          />
        </StaggerItem>
        <StaggerItem>
          <SmtpCard smtp={smtp ?? null} onOpen={() => setOpenKey("smtp")} />
        </StaggerItem>
        <StaggerItem>
          <ComingSoonCard />
        </StaggerItem>
      </Stagger>

      <Drawer
        open={openKey === "modrinth"}
        onClose={() => setOpenKey(null)}
        title="Modrinth"
        description="Public API. No configuration required."
      >
        <ModrinthDetails />
      </Drawer>
      <Drawer
        open={openKey === "curseforge"}
        onClose={() => setOpenKey(null)}
        title="CurseForge"
        description="Manage your API key. The panel encrypts it with SECRETS_KEY before storing."
      >
        <CurseForgeDetails />
      </Drawer>
      <Drawer
        open={openKey === "download-proxy"}
        onClose={() => setOpenKey(null)}
        title={t("proxy.title")}
        description={t("proxy.subtitle")}
      >
        <DownloadProxyDetails />
      </Drawer>
      <Drawer
        open={openKey === "smtp"}
        onClose={() => setOpenKey(null)}
        title={t("smtp.title")}
        description={t("smtp.subtitle")}
      >
        <SmtpDetails />
      </Drawer>
    </div>
  );
}

function IntegrationCard({
  def,
  enabled,
  onOpen,
}: {
  def: IntegrationDef;
  enabled: boolean;
  onOpen: () => void;
}): JSX.Element {
  const { t } = useT();
  return (
    <motion.button
      type="button"
      onClick={onOpen}
      whileHover={{ y: -3 }}
      transition={{ duration: 0.18 }}
      className="tile tile-interactive overflow-hidden h-full flex flex-col text-left"
    >
      <div
        className="relative h-24 grid place-items-center text-white overflow-hidden"
        style={{
          background: `linear-gradient(135deg, ${def.tone.from}, ${def.tone.to})`,
        }}
      >
        <span className="absolute inset-0 bg-grid-pattern opacity-30" />
        <span
          className="relative font-display font-black text-[60px] opacity-85 leading-none"
          style={{ letterSpacing: "-0.05em" }}
        >
          {def.tone.mark}
        </span>
      </div>

      <div className="p-5 flex-1 flex flex-col">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="heading-md">{def.name}</div>
            <div className="text-xs text-ink-muted mt-0.5">{def.tagline}</div>
          </div>
          <span
            className={`chip ${enabled ? "chip-success" : "chip-warning"}`}
          >
            {enabled && <Check size={10} />}{" "}
            {enabled ? t("integrations.enabled") : t("integrations.disabled")}
          </span>
        </div>
        <p className="text-sm text-ink-secondary mt-3 flex-1">
          {def.description}
        </p>
        <div className="mt-5 flex items-center justify-between text-sm">
          <span className="link inline-flex items-center gap-1">
            Configure
            <ExternalLink size={12} className="opacity-60" />
          </span>
        </div>
      </div>
    </motion.button>
  );
}

function DownloadProxyCard({
  proxy,
  onOpen,
}: {
  proxy: ProxyDisplay | null;
  onOpen: () => void;
}): JSX.Element {
  const { t } = useT();
  const configured = !!proxy && !!proxy.host && !!proxy.port;
  const enabled = !!proxy?.enabled;
  return (
    <motion.button
      type="button"
      onClick={onOpen}
      whileHover={{ y: -3 }}
      transition={{ duration: 0.18 }}
      className="tile tile-interactive overflow-hidden h-full flex flex-col text-left"
    >
      <div
        className="relative h-24 grid place-items-center text-white overflow-hidden"
        style={{
          background: "linear-gradient(135deg, #1e293b, #475569)",
        }}
      >
        <span className="absolute inset-0 bg-grid-pattern opacity-30" />
        <Network size={42} className="relative opacity-80" />
      </div>
      <div className="p-5 flex-1 flex flex-col">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="heading-md">{t("proxy.title")}</div>
            <div className="text-xs text-ink-muted mt-0.5">
              {t("proxy.tagline")}
            </div>
          </div>
          <span
            className={`chip ${
              enabled
                ? "chip-success"
                : configured
                  ? "chip-warning"
                  : "chip-muted"
            }`}
          >
            {enabled && <Check size={10} />}{" "}
            {enabled
              ? t("integrations.enabled")
              : configured
                ? t("proxy.configuredButOff")
                : t("proxy.notConfigured")}
          </span>
        </div>
        <p className="text-sm text-ink-secondary mt-3 flex-1">
          {t("proxy.cardDesc")}
        </p>
      </div>
    </motion.button>
  );
}

function DownloadProxyDetails(): JSX.Element {
  const { t } = useT();
  const { data } = useSWR<ProxyDisplay>(
    "/integrations/download-proxy",
    fetcher
  );
  const [enabled, setEnabled] = useState(false);
  const [protocol, setProtocol] = useState<"socks" | "http">("socks");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [passwordDirty, setPasswordDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const [hydrated, setHydrated] = useState(false);
  // Seed the form from SWR data once it arrives. Guard with `hydrated`
  // so typing into the fields afterwards isn't clobbered by late fetches.
  useEffect(() => {
    if (data && !hydrated) {
      setEnabled(data.enabled);
      setProtocol(data.protocol);
      setHost(data.host);
      setPort(data.port ? String(data.port) : "");
      setUsername(data.username ?? "");
      setHydrated(true);
    }
  }, [data, hydrated]);

  async function save(): Promise<void> {
    setBusy(true);
    setMsg(null);
    try {
      const body: Record<string, unknown> = {
        enabled,
        protocol,
        host,
        port: Number(port),
      };
      if (username) body.username = username;
      if (passwordDirty) body.password = password;
      await api.put("/integrations/download-proxy", body);
      setMsg(t("common.success"));
      setPasswordDirty(false);
      setPassword("");
      mutate("/integrations/download-proxy");
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function clear(): Promise<void> {
    setBusy(true);
    setMsg(null);
    try {
      await api.del("/integrations/download-proxy");
      setEnabled(false);
      setHost("");
      setPort("");
      setUsername("");
      setPassword("");
      mutate("/integrations/download-proxy");
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <p className="text-sm text-ink-secondary leading-relaxed">
        {t("proxy.detailsIntro")}
      </p>

      <label className="flex items-center gap-2.5 text-sm cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <span>{t("proxy.enable")}</span>
      </label>

      <div className="grid grid-cols-1 sm:grid-cols-[140px_1fr_120px] gap-3">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-ink-secondary">
            {t("proxy.protocol")}
          </label>
          <select
            className="select"
            value={protocol}
            onChange={(e) => setProtocol(e.target.value as "socks" | "http")}
          >
            <option value="socks">SOCKS5</option>
            <option value="http">HTTP</option>
          </select>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-ink-secondary">
            {t("proxy.host")}
          </label>
          <input
            className="input font-mono"
            placeholder="172.17.0.1"
            value={host}
            onChange={(e) => setHost(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-ink-secondary">
            {t("proxy.port")}
          </label>
          <input
            className="input font-mono"
            type="number"
            min={1}
            max={65535}
            placeholder="2080"
            value={port}
            onChange={(e) => setPort(e.target.value)}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-ink-secondary">
            {t("proxy.username")}{" "}
            <span className="text-ink-muted">({t("proxy.optional")})</span>
          </label>
          <input
            className="input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-ink-secondary">
            {t("proxy.password")}{" "}
            <span className="text-ink-muted">
              ({t("proxy.optional")}
              {data?.hasPassword && !passwordDirty
                ? ` · ${t("proxy.passwordStored")}`
                : ""}
              )
            </span>
          </label>
          <input
            className="input font-mono"
            type="password"
            placeholder={
              data?.hasPassword && !passwordDirty
                ? "••••••••"
                : ""
            }
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setPasswordDirty(true);
            }}
          />
        </div>
      </div>

      <div className="flex gap-2">
        <button
          className="btn btn-primary"
          onClick={save}
          disabled={busy || !host || !port}
        >
          {busy ? t("integrations.saving") : t("integrations.save")}
        </button>
        {data?.host && (
          <button className="btn btn-ghost" onClick={clear} disabled={busy}>
            {t("integrations.remove")}
          </button>
        )}
      </div>
      {msg && (
        <div className="text-xs text-ink-secondary">{msg}</div>
      )}
      <p className="text-xs text-ink-muted leading-relaxed">
        {t("proxy.helperNote")}
      </p>
    </div>
  );
}

function SmtpCard({
  smtp,
  onOpen,
}: {
  smtp: SmtpDisplay | null;
  onOpen: () => void;
}): JSX.Element {
  const { t } = useT();
  const configured = !!smtp && !!smtp.host && !!smtp.from;
  const enabled = !!smtp?.enabled;
  return (
    <motion.button
      type="button"
      onClick={onOpen}
      whileHover={{ y: -3 }}
      transition={{ duration: 0.18 }}
      className="tile tile-interactive overflow-hidden h-full flex flex-col text-left"
    >
      <div
        className="relative h-24 grid place-items-center text-white overflow-hidden"
        style={{ background: "linear-gradient(135deg, #1e3a8a, #2563eb)" }}
      >
        <span className="absolute inset-0 bg-grid-pattern opacity-30" />
        <Mail size={42} className="relative opacity-80" />
      </div>
      <div className="p-5 flex-1 flex flex-col">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="heading-md">{t("smtp.title")}</div>
            <div className="text-xs text-ink-muted mt-0.5">
              {t("smtp.tagline")}
            </div>
          </div>
          <span
            className={`chip ${
              enabled
                ? "chip-success"
                : configured
                  ? "chip-warning"
                  : "chip-muted"
            }`}
          >
            {enabled && <Check size={10} />}{" "}
            {enabled
              ? t("integrations.enabled")
              : configured
                ? t("smtp.configuredButOff")
                : t("smtp.notConfigured")}
          </span>
        </div>
        <p className="text-sm text-ink-secondary mt-3 flex-1">
          {t("smtp.cardDesc")}
        </p>
      </div>
    </motion.button>
  );
}

function SmtpDetails(): JSX.Element {
  const { t } = useT();
  const { data } = useSWR<SmtpDisplay>("/integrations/smtp", fetcher);
  const [enabled, setEnabled] = useState(false);
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [secure, setSecure] = useState(false);
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [passwordDirty, setPasswordDirty] = useState(false);
  const [from, setFrom] = useState("");
  const [panelUrl, setPanelUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [testTo, setTestTo] = useState("");
  const [testBusy, setTestBusy] = useState(false);

  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    if (data && !hydrated) {
      setEnabled(data.enabled);
      setHost(data.host);
      setPort(data.port ? String(data.port) : "");
      setSecure(data.secure);
      setUser(data.user);
      setFrom(data.from);
      setPanelUrl(
        data.panelUrl ||
          (typeof window !== "undefined"
            ? `${window.location.protocol}//${window.location.host}`
            : "")
      );
      setHydrated(true);
    }
  }, [data, hydrated]);

  async function save(): Promise<void> {
    setBusy(true);
    setMsg(null);
    try {
      const body: Record<string, unknown> = {
        enabled,
        host,
        port: Number(port),
        secure,
        from,
        panelUrl,
      };
      if (user) body.user = user;
      if (passwordDirty) body.password = password;
      await api.put("/integrations/smtp", body);
      setMsg(t("common.success"));
      setPasswordDirty(false);
      setPassword("");
      mutate("/integrations/smtp");
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function clearAll(): Promise<void> {
    setBusy(true);
    setMsg(null);
    try {
      await api.del("/integrations/smtp");
      setEnabled(false);
      setHost("");
      setPort("");
      setUser("");
      setPassword("");
      setFrom("");
      mutate("/integrations/smtp");
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function sendTest(): Promise<void> {
    setTestBusy(true);
    setMsg(null);
    try {
      await api.post("/integrations/smtp/test", { to: testTo });
      setMsg(t("smtp.testSent", { to: testTo }));
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : String(err));
    } finally {
      setTestBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <p className="text-sm text-ink-secondary leading-relaxed">
        {t("smtp.detailsIntro")}
      </p>

      <label className="flex items-center gap-2.5 text-sm cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <span>{t("smtp.enable")}</span>
      </label>

      <div className="grid grid-cols-1 sm:grid-cols-[1fr_120px_120px] gap-3">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-ink-secondary">
            {t("smtp.host")}
          </label>
          <input
            className="input font-mono"
            placeholder="smtp.example.com"
            value={host}
            onChange={(e) => setHost(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-ink-secondary">
            {t("smtp.port")}
          </label>
          <input
            className="input font-mono"
            type="number"
            min={1}
            max={65535}
            placeholder="587"
            value={port}
            onChange={(e) => setPort(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-ink-secondary">
            {t("smtp.secure")}
          </label>
          <select
            className="select"
            value={secure ? "ssl" : "starttls"}
            onChange={(e) => setSecure(e.target.value === "ssl")}
          >
            <option value="starttls">STARTTLS</option>
            <option value="ssl">SSL/TLS</option>
          </select>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-ink-secondary">
            {t("smtp.user")}{" "}
            <span className="text-ink-muted">({t("proxy.optional")})</span>
          </label>
          <input
            className="input"
            value={user}
            onChange={(e) => setUser(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-ink-secondary">
            {t("smtp.password")}{" "}
            <span className="text-ink-muted">
              ({t("proxy.optional")}
              {data?.hasPassword && !passwordDirty
                ? ` · ${t("proxy.passwordStored")}`
                : ""}
              )
            </span>
          </label>
          <input
            className="input font-mono"
            type="password"
            placeholder={
              data?.hasPassword && !passwordDirty ? "••••••••" : ""
            }
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setPasswordDirty(true);
            }}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-ink-secondary">
            {t("smtp.from")}
          </label>
          <input
            className="input"
            placeholder='"CofePanel" <panel@example.com>'
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-ink-secondary">
            {t("smtp.panelUrl")}
          </label>
          <input
            className="input font-mono"
            placeholder="https://panel.example.com"
            value={panelUrl}
            onChange={(e) => setPanelUrl(e.target.value)}
          />
        </div>
      </div>

      <div className="flex gap-2">
        <button
          className="btn btn-primary"
          onClick={save}
          disabled={busy || !host || !port || !from || !panelUrl}
        >
          {busy ? t("integrations.saving") : t("integrations.save")}
        </button>
        {data?.host && (
          <button className="btn btn-ghost" onClick={clearAll} disabled={busy}>
            {t("integrations.remove")}
          </button>
        )}
      </div>

      <div className="divider" />

      <div className="space-y-2">
        <label className="text-xs font-medium text-ink-secondary">
          {t("smtp.testTitle")}
        </label>
        <div className="flex gap-2">
          <input
            className="input flex-1"
            type="email"
            placeholder="you@example.com"
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
          />
          <button
            className="btn btn-ghost"
            onClick={sendTest}
            disabled={!testTo || testBusy}
          >
            {testBusy ? t("smtp.testSending") : t("smtp.testSend")}
          </button>
        </div>
      </div>

      {msg && (
        <div className="text-xs text-ink-secondary">{msg}</div>
      )}
      <p className="text-xs text-ink-muted leading-relaxed">
        {t("smtp.helperNote")}
      </p>
    </div>
  );
}

function ComingSoonCard(): JSX.Element {
  return (
    <div className="tile p-5 flex flex-col gap-4 bg-surface-2/50 border-dashed">
      <div className="w-10 h-10 rounded-lg bg-[rgb(var(--accent-soft))] text-[rgb(var(--accent))] grid place-items-center">
        <Sparkles size={18} />
      </div>
      <div>
        <div className="heading-md">More providers</div>
        <p className="text-sm text-ink-muted mt-1">
          Ploopy, Spigot, Bukkit and git-based sources are on the roadmap. The
          provider interface is stable — drop in an implementation and it
          appears here.
        </p>
      </div>
      <span className="chip chip-muted mt-auto w-fit">Planned</span>
    </div>
  );
}

function ModrinthDetails(): JSX.Element {
  const { t } = useT();
  return (
    <div className="space-y-5">
      <p className="text-sm text-ink-secondary leading-relaxed">
        {t("integrations.modrinth.desc")}
      </p>
      <a
        href="https://modrinth.com"
        target="_blank"
        rel="noreferrer"
        className="link text-sm inline-flex items-center gap-1"
      >
        modrinth.com <ExternalLink size={12} />
      </a>
    </div>
  );
}

function CurseForgeDetails(): JSX.Element {
  const { t } = useT();
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const { data } = useSWR<Integrations>("/integrations", fetcher);
  const enabled = data?.providers.curseforge.enabled;

  async function save(): Promise<void> {
    setBusy(true);
    setMsg(null);
    try {
      await api.patch(`/integrations/curseforge.apiKey`, { value: apiKey });
      setApiKey("");
      setMsg(t("common.success"));
      mutate("/integrations");
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function clear(): Promise<void> {
    await api.del(`/integrations/curseforge.apiKey`);
    mutate("/integrations");
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <span
          className={`chip ${enabled ? "chip-success" : "chip-warning"} !h-6 px-2.5`}
        >
          {enabled && <Check size={10} />}
          {enabled ? t("integrations.enabled") : t("integrations.disabled")}
        </span>
      </div>
      <p className="text-sm text-ink-secondary">
        {t("integrations.curseforge.desc")}
      </p>
      <div className="divider" />
      <div className="space-y-2">
        <label className="text-xs font-medium text-ink-secondary">
          {t("integrations.apiKey")}
        </label>
        <input
          className="input font-mono"
          placeholder="$2a$10$..."
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          type="password"
        />
        <div className="flex gap-2">
          <button
            className="btn btn-primary"
            disabled={!apiKey || busy}
            onClick={save}
          >
            {busy ? t("integrations.saving") : t("integrations.save")}
          </button>
          {enabled && (
            <button className="btn btn-ghost" onClick={clear}>
              {t("integrations.remove")}
            </button>
          )}
        </div>
        {msg && (
          <div className="text-xs text-ink-secondary mt-1">{msg}</div>
        )}
      </div>
      <p className="text-xs text-ink-muted">
        <a
          className="link"
          href="https://console.curseforge.com/"
          target="_blank"
          rel="noreferrer"
        >
          {t("integrations.getKey")}
        </a>
        {" — "}
        {t("integrations.apiKeySaved")}
      </p>
    </div>
  );
}

function Row({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-start gap-3 text-sm">
      <span className="mt-0.5 text-ink-muted">{icon}</span>
      <div className="flex-1">
        <div className="text-xs uppercase tracking-wider text-ink-muted">
          {label}
        </div>
        <div className="text-ink-secondary mt-0.5">{value}</div>
      </div>
    </div>
  );
}

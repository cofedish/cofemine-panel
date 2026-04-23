"use client";
import { useState } from "react";
import useSWR, { mutate } from "swr";
import { motion } from "framer-motion";
import { api, ApiError, fetcher } from "@/lib/api";
import { PageHeader } from "@/components/page-header";
import { Stagger, StaggerItem } from "@/components/motion";
import { Drawer } from "@/components/drawer";
import { Check, Package, Key, ExternalLink, Sparkles } from "lucide-react";
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

export default function IntegrationsPage(): JSX.Element {
  const { data } = useSWR<Integrations>("/integrations", fetcher);
  const { t } = useT();
  const [openKey, setOpenKey] = useState<"modrinth" | "curseforge" | null>(
    null
  );

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

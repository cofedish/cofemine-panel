"use client";
import { useState } from "react";
import useSWR, { mutate } from "swr";
import { motion, AnimatePresence } from "framer-motion";
import { api, ApiError, fetcher } from "@/lib/api";
import { Stagger, StaggerItem } from "@/components/motion";
import { ChevronDown, Check, Plug, Package, Key } from "lucide-react";
import { cn } from "@/lib/cn";

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
  tone: { from: string; to: string };
  badge: { text: string; variant: "accent" | "muted" | "warning" | "success" };
  requiresKey: boolean;
}

export default function IntegrationsPage(): JSX.Element {
  const { data } = useSWR<Integrations>("/integrations", fetcher);
  const [openKey, setOpenKey] = useState<string | null>(null);

  const defs: IntegrationDef[] = [
    {
      key: "modrinth",
      name: "Modrinth",
      tagline: "Open mod platform",
      description:
        "Search mods, modpacks, plugins and datapacks from modrinth.com. Installation is fully automatic — pick a version, the agent downloads it.",
      tone: { from: "#064e3b", to: "#10b981" },
      badge: data?.providers.modrinth.enabled
        ? { text: "Enabled", variant: "success" }
        : { text: "Disabled", variant: "muted" },
      requiresKey: false,
    },
    {
      key: "curseforge",
      name: "CurseForge",
      tagline: "Mod catalog (API key)",
      description:
        "Search and install mods or modpacks from curseforge.com. Requires a personal API key. Without one, the panel falls back to manual ZIP upload via the File manager.",
      tone: { from: "#7c2d12", to: "#f59e0b" },
      badge: data?.providers.curseforge.enabled
        ? { text: "Enabled", variant: "success" }
        : { text: "Needs API key", variant: "warning" },
      requiresKey: true,
    },
  ];

  return (
    <div className="space-y-8">
      <header>
        <h1 className="heading-xl">Integrations</h1>
        <p className="text-ink-secondary mt-2">
          Connect external content sources. Providers expose a unified search
          and install flow across all your servers.
        </p>
      </header>

      <Stagger className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
        {defs.map((def) => (
          <StaggerItem key={def.key}>
            <IntegrationCard
              def={def}
              expanded={openKey === def.key}
              onToggle={() =>
                setOpenKey((k) => (k === def.key ? null : def.key))
              }
            />
          </StaggerItem>
        ))}
      </Stagger>
    </div>
  );
}

const BADGE_CLASS: Record<string, string> = {
  accent: "badge badge-accent",
  muted: "badge badge-muted",
  warning: "badge badge-warning",
  success: "badge badge-success",
};

function IntegrationCard({
  def,
  expanded,
  onToggle,
}: {
  def: IntegrationDef;
  expanded: boolean;
  onToggle: () => void;
}): JSX.Element {
  return (
    <motion.div
      className="card overflow-hidden h-full flex flex-col"
      whileHover={{ y: -3 }}
      transition={{ duration: 0.18 }}
    >
      <div
        className="relative h-24 grid place-items-center text-white"
        style={{
          background: `linear-gradient(135deg, ${def.tone.from}, ${def.tone.to})`,
        }}
      >
        <span className="absolute inset-0 bg-grid opacity-30" />
        <span className="relative w-14 h-14 rounded-2xl bg-white/20 backdrop-blur-sm grid place-items-center shadow-lg ring-1 ring-white/30">
          <Plug size={26} />
        </span>
      </div>

      <div className="p-5 flex-1 flex flex-col">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="font-semibold text-base">{def.name}</div>
            <div className="text-xs text-ink-muted mt-0.5">{def.tagline}</div>
          </div>
          <span className={BADGE_CLASS[def.badge.variant]}>
            {def.badge.variant === "success" && (
              <Check size={10} className="mr-1" />
            )}
            {def.badge.text}
          </span>
        </div>
        <p className="text-sm text-ink-secondary mt-3 flex-1">
          {def.description}
        </p>

        <button
          onClick={onToggle}
          className="mt-5 inline-flex items-center justify-center gap-1.5 text-accent text-sm font-medium hover:underline"
        >
          {expanded ? "Collapse" : "Details"}
          <ChevronDown
            size={14}
            className={cn(
              "transition-transform duration-200",
              expanded && "rotate-180"
            )}
          />
        </button>
      </div>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="border-t border-line overflow-hidden"
          >
            <div className="p-5 space-y-4 bg-surface-2/50">
              {def.key === "modrinth" ? <ModrinthDetails /> : null}
              {def.key === "curseforge" ? <CurseForgeDetails /> : null}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function ModrinthDetails(): JSX.Element {
  return (
    <>
      <Row
        icon={<Package size={14} />}
        label="Project types"
        value="mods, modpacks, plugins, datapacks, resourcepacks, shaders"
      />
      <Row
        icon={<Key size={14} />}
        label="Authentication"
        value="None — public API"
      />
      <p className="text-xs text-ink-muted">
        Modpacks are applied via the runtime's <code>MODRINTH_PROJECT</code>{" "}
        env, then the server refetches them on next start.
      </p>
    </>
  );
}

function CurseForgeDetails(): JSX.Element {
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const { data } = useSWR<Integrations>("/integrations", fetcher);

  async function save(): Promise<void> {
    setBusy(true);
    setMsg(null);
    try {
      await api.patch(`/integrations/curseforge.apiKey`, { value: apiKey });
      setApiKey("");
      setMsg("Saved.");
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
    <>
      <Row
        icon={<Key size={14} />}
        label="API key"
        value={
          data?.providers.curseforge.enabled ? "Configured" : "Not configured"
        }
      />
      <div className="flex gap-2">
        <input
          className="input"
          placeholder="Paste API key"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
        <button
          className="btn-primary"
          disabled={!apiKey || busy}
          onClick={save}
        >
          Save
        </button>
        {data?.providers.curseforge.enabled && (
          <button className="btn-ghost" onClick={clear}>
            Clear
          </button>
        )}
      </div>
      {msg && <div className="text-xs text-ink-secondary">{msg}</div>}
      <p className="text-xs text-ink-muted">
        Get a key at{" "}
        <a
          className="text-accent underline"
          href="https://console.curseforge.com/"
          target="_blank"
          rel="noreferrer"
        >
          console.curseforge.com
        </a>
        .
      </p>
    </>
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

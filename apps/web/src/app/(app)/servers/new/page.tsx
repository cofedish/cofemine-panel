"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { motion, AnimatePresence } from "framer-motion";
import { api, ApiError, fetcher } from "@/lib/api";
import { SERVER_TYPES } from "@cofemine/shared";
import { PageHeader } from "@/components/page-header";
import { cn } from "@/lib/cn";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";

type Node = { id: string; name: string; status: string };
type Template = {
  id: string;
  name: string;
  type: string;
  version: string;
  memoryMb: number;
  env: Record<string, string>;
};

const STEPS = ["Runtime", "Resources", "Review"] as const;
type Step = (typeof STEPS)[number];

const TYPE_PRESET: Record<
  string,
  { from: string; to: string; desc: string; glyph: string }
> = {
  VANILLA: {
    from: "#0b3d1a",
    to: "#22c55e",
    desc: "Mojang's official server — no mods.",
    glyph: "V",
  },
  PAPER: {
    from: "#0f172a",
    to: "#94a3b8",
    desc: "High-performance Bukkit/Spigot fork. Most popular for plugins.",
    glyph: "P",
  },
  PURPUR: {
    from: "#3b0764",
    to: "#a855f7",
    desc: "Paper fork with extra gameplay-tuning features.",
    glyph: "PU",
  },
  FABRIC: {
    from: "#713f12",
    to: "#fbbf24",
    desc: "Lightweight mod loader; fast-moving, modern.",
    glyph: "F",
  },
  FORGE: {
    from: "#0f172a",
    to: "#475569",
    desc: "Classic mod loader; widest mod library.",
    glyph: "FG",
  },
  NEOFORGE: {
    from: "#0c0a09",
    to: "#f97316",
    desc: "Forge fork, actively maintained.",
    glyph: "NF",
  },
  MOHIST: {
    from: "#18181b",
    to: "#ef4444",
    desc: "Forge + Bukkit hybrid — mods and plugins together.",
    glyph: "M",
  },
  QUILT: {
    from: "#78350f",
    to: "#f59e0b",
    desc: "Fabric-compatible fork with extra APIs.",
    glyph: "Q",
  },
};

export default function CreateServerPage(): JSX.Element {
  const router = useRouter();
  const { data: nodes } = useSWR<Node[]>("/nodes", fetcher);
  const { data: templates } = useSWR<Template[]>("/templates", fetcher);

  const [step, setStep] = useState<Step>("Runtime");

  const [templateId, setTemplateId] = useState("");
  const [name, setName] = useState("survival");
  const [description, setDescription] = useState("");
  const [nodeId, setNodeId] = useState("");
  const [type, setType] = useState<(typeof SERVER_TYPES)[number]>("PAPER");
  const [version, setVersion] = useState("1.21.1");
  const [memoryMb, setMemoryMb] = useState(2048);
  const [hostPort, setHostPort] = useState(25565);
  const [envText, setEnvText] = useState("DIFFICULTY=normal\nMAX_PLAYERS=20");
  const [eula, setEula] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function applyTemplate(id: string): void {
    setTemplateId(id);
    const t = templates?.find((t) => t.id === id);
    if (!t) return;
    setType(t.type as any);
    setVersion(t.version);
    setMemoryMb(t.memoryMb);
    setEnvText(
      Object.entries(t.env ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join("\n")
    );
  }

  async function submit(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      const env: Record<string, string> = {};
      for (const line of envText.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq < 1) continue;
        env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
      }
      const res = await api.post<{ id: string }>("/servers", {
        name,
        description: description || undefined,
        nodeId,
        type,
        version,
        memoryMb: Number(memoryMb),
        ports: [{ host: Number(hostPort), container: 25565, protocol: "tcp" }],
        env,
        eulaAccepted: eula,
        templateId: templateId || undefined,
      });
      router.push(`/servers/${res.id}`);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const idx = STEPS.indexOf(step);
  const canNext =
    step === "Runtime"
      ? !!name && !!type && !!version
      : step === "Resources"
        ? !!nodeId && memoryMb >= 512 && hostPort > 0
        : eula;

  function next(): void {
    const nextIdx = Math.min(idx + 1, STEPS.length - 1);
    setStep(STEPS[nextIdx] ?? STEPS[0]!);
  }
  function prev(): void {
    const prevIdx = Math.max(idx - 1, 0);
    setStep(STEPS[prevIdx] ?? STEPS[0]!);
  }

  const preset = TYPE_PRESET[type]!;

  return (
    <div className="space-y-8 max-w-4xl">
      <PageHeader
        breadcrumbs={[
          { label: "Dashboard", href: "/" },
          { label: "New server" },
        ]}
        title="Create server"
        description="Servers run as sibling Docker containers using itzg/minecraft-server."
      />

      {/* Stepper */}
      <ol className="flex items-center gap-4">
        {STEPS.map((s, i) => {
          const done = i < idx;
          const current = i === idx;
          return (
            <li
              key={s}
              className="flex items-center gap-2 text-sm"
            >
              <span
                className={cn(
                  "w-6 h-6 grid place-items-center rounded-full text-xs font-semibold transition-colors",
                  done &&
                    "bg-[rgb(var(--accent))] text-[rgb(var(--accent-ink))]",
                  current &&
                    !done &&
                    "bg-[rgb(var(--accent-soft))] text-[rgb(var(--accent))] ring-2 ring-[rgb(var(--accent))]/40",
                  !done &&
                    !current &&
                    "bg-surface-2 text-ink-muted"
                )}
              >
                {done ? <Check size={13} /> : i + 1}
              </span>
              <span
                className={cn(
                  current ? "text-ink font-medium" : "text-ink-muted"
                )}
              >
                {s}
              </span>
              {i < STEPS.length - 1 && (
                <span
                  className={cn(
                    "w-10 h-px transition-colors",
                    done
                      ? "bg-[rgb(var(--accent))]"
                      : "bg-line"
                  )}
                />
              )}
            </li>
          );
        })}
      </ol>

      <AnimatePresence mode="wait">
        <motion.div
          key={step}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.18 }}
        >
          {step === "Runtime" && (
            <div className="tile p-7 space-y-6">
              <h2 className="heading-md">Choose a template (optional)</h2>
              <select
                className="select"
                value={templateId}
                onChange={(e) => applyTemplate(e.target.value)}
              >
                <option value="">— start from scratch —</option>
                {templates?.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} · {t.type} · {t.version}
                  </option>
                ))}
              </select>

              <div className="divider" />

              <div className="space-y-3">
                <h2 className="heading-md">Server type</h2>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  {SERVER_TYPES.map((t) => {
                    const p = TYPE_PRESET[t]!;
                    const active = type === t;
                    return (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setType(t)}
                        className={cn(
                          "relative overflow-hidden rounded-lg border text-left transition-all",
                          active
                            ? "border-[rgb(var(--accent))]/60 ring-2 ring-[rgb(var(--accent))]/25"
                            : "border-line hover:border-line-strong"
                        )}
                      >
                        <div
                          className="h-20 flex items-center justify-center text-white relative"
                          style={{
                            background: `linear-gradient(135deg, ${p.from}, ${p.to})`,
                          }}
                        >
                          <span className="absolute inset-0 bg-grid-pattern opacity-25" />
                          <span
                            className="relative font-display font-black text-4xl leading-none opacity-90"
                            style={{ letterSpacing: "-0.05em" }}
                          >
                            {p.glyph}
                          </span>
                        </div>
                        <div className="px-3 py-2 bg-surface-1">
                          <div className="text-sm font-medium">{t}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
                <p className="text-sm text-ink-muted">{preset.desc}</p>
              </div>

              <div className="divider" />

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <Field label="Name">
                  <input
                    className="input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                  />
                </Field>
                <Field label="Version" hint="e.g. 1.21.1 or LATEST">
                  <input
                    className="input"
                    value={version}
                    onChange={(e) => setVersion(e.target.value)}
                  />
                </Field>
                <Field label="Description (optional)">
                  <input
                    className="input"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </Field>
              </div>
            </div>
          )}

          {step === "Resources" && (
            <div className="tile p-7 space-y-6">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <Field label="Node">
                  <select
                    className="select"
                    value={nodeId}
                    onChange={(e) => setNodeId(e.target.value)}
                  >
                    <option value="">— select —</option>
                    {nodes?.map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.name} ({n.status})
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Memory (MB)" hint="container limit">
                  <input
                    className="input"
                    type="number"
                    min={512}
                    max={65536}
                    step={512}
                    value={memoryMb}
                    onChange={(e) => setMemoryMb(Number(e.target.value))}
                  />
                </Field>
                <Field label="Host port" hint="container 25565">
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={65535}
                    value={hostPort}
                    onChange={(e) => setHostPort(Number(e.target.value))}
                  />
                </Field>
              </div>
              <Field label="Environment" hint="KEY=VALUE per line">
                <textarea
                  className="textarea font-mono text-xs h-36"
                  value={envText}
                  onChange={(e) => setEnvText(e.target.value)}
                />
              </Field>
            </div>
          )}

          {step === "Review" && (
            <div className="tile p-7 space-y-6">
              <div
                className="rounded-xl h-32 overflow-hidden relative text-white flex items-end p-5"
                style={{
                  background: `linear-gradient(135deg, ${preset.from}, ${preset.to})`,
                }}
              >
                <span className="absolute inset-0 bg-grid-pattern opacity-25" />
                <span
                  className="absolute right-5 top-[-22px] font-display font-black text-[140px] leading-none opacity-25"
                  style={{ letterSpacing: "-0.05em" }}
                >
                  {preset.glyph}
                </span>
                <div className="relative">
                  <div className="text-xs uppercase tracking-widest opacity-80">
                    {type}
                  </div>
                  <div className="font-semibold text-2xl">{name}</div>
                </div>
              </div>

              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3 text-sm">
                <ReviewRow label="Version">{version}</ReviewRow>
                <ReviewRow label="Memory">{memoryMb} MB</ReviewRow>
                <ReviewRow label="Host port">{hostPort}</ReviewRow>
                <ReviewRow label="Node">
                  {nodes?.find((n) => n.id === nodeId)?.name ?? "—"}
                </ReviewRow>
                <ReviewRow label="Env vars">
                  {envText
                    .split("\n")
                    .filter((l) => l.trim() && !l.startsWith("#")).length}{" "}
                  defined
                </ReviewRow>
              </dl>

              <div className="divider" />

              <label className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={eula}
                  onChange={(e) => setEula(e.target.checked)}
                  className="mt-1"
                />
                <span>
                  I accept the{" "}
                  <a
                    className="link"
                    href="https://www.minecraft.net/en-us/eula"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Minecraft EULA
                  </a>
                  . Required to run any Minecraft server.
                </span>
              </label>

              {err && (
                <div className="chip chip-danger !h-auto !py-2 !px-3">
                  {err}
                </div>
              )}
            </div>
          )}
        </motion.div>
      </AnimatePresence>

      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => (idx === 0 ? router.back() : prev())}
          className="btn btn-ghost"
        >
          <ChevronLeft size={15} /> {idx === 0 ? "Cancel" : "Back"}
        </button>
        {step !== "Review" ? (
          <button
            type="button"
            onClick={next}
            className="btn btn-primary"
            disabled={!canNext}
          >
            Next <ChevronRight size={15} />
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            className="btn btn-primary"
            disabled={busy || !canNext}
          >
            {busy ? "Creating…" : "Create server"}
          </button>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-ink-secondary">{label}</label>
      {children}
      {hint && <div className="text-xs text-ink-muted">{hint}</div>}
    </div>
  );
}

function ReviewRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wider text-ink-muted">
        {label}
      </dt>
      <dd className="text-ink mt-1 font-medium">{children}</dd>
    </div>
  );
}

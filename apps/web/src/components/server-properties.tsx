"use client";
import useSWR, { mutate } from "swr";
import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { api, fetcher } from "@/lib/api";
import { cn } from "@/lib/cn";
import {
  DEFS_BY_GROUP,
  GROUP_LABELS,
  KNOWN_KEYS,
  type PropertyDef,
  type PropertyGroup,
} from "./server-properties-meta";
import { Save, Undo2, Search } from "lucide-react";

type Props = {
  raw: string;
  parsed: Record<string, string>;
};

const GROUP_ORDER: PropertyGroup[] = [
  "world",
  "gameplay",
  "players",
  "network",
  "security",
  "performance",
];

export function ServerProperties({
  serverId,
}: {
  serverId: string;
}): JSX.Element {
  const { data } = useSWR<Props>(`/servers/${serverId}/properties`, fetcher);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [section, setSection] = useState<PropertyGroup>("world");

  const merged = useMemo(
    () => ({ ...(data?.parsed ?? {}), ...edits }),
    [data, edits]
  );

  const unknownKeys = useMemo(() => {
    if (!data) return [] as string[];
    return Object.keys(data.parsed)
      .filter((k) => !KNOWN_KEYS.has(k))
      .sort();
  }, [data]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return GROUP_ORDER.flatMap((g) =>
      DEFS_BY_GROUP[g].filter(
        (d) =>
          d.key.toLowerCase().includes(q) ||
          d.label.toLowerCase().includes(q) ||
          (d.help ?? "").toLowerCase().includes(q)
      )
    );
  }, [query]);

  if (!data) return <div className="text-ink-muted">Loading…</div>;

  const dirtyCount = Object.keys(edits).length;

  async function save(): Promise<void> {
    setBusy(true);
    try {
      await api.put(`/servers/${serverId}/properties`, {
        properties: edits,
      });
      setEdits({});
      mutate(`/servers/${serverId}/properties`);
    } finally {
      setBusy(false);
    }
  }

  function setValue(key: string, value: string): void {
    setEdits((prev) => ({ ...prev, [key]: value }));
  }

  function resetField(key: string): void {
    setEdits((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  function applyDefault(def: PropertyDef): void {
    const def2: any = def;
    const value =
      def2.default !== undefined ? String(def2.default) : "";
    setValue(def.key, value);
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-5">
      {/* Sidebar — group nav */}
      <aside className="space-y-4">
        <div className="tile p-3 space-y-1">
          <div className="px-2 pt-1 pb-2">
            <div className="relative">
              <Search
                size={13}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-muted"
              />
              <input
                className="input pl-8 !py-1.5 text-xs"
                placeholder="Search settings…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          </div>
          {GROUP_ORDER.map((g) => {
            const active = section === g && !query;
            return (
              <button
                key={g}
                type="button"
                onClick={() => {
                  setQuery("");
                  setSection(g);
                }}
                className={cn(
                  "w-full text-left px-3 py-1.5 rounded-md text-sm transition-colors flex items-center justify-between",
                  active
                    ? "bg-[rgb(var(--accent-soft))] text-[rgb(var(--accent))] font-medium"
                    : "text-ink-secondary hover:text-ink hover:bg-surface-2"
                )}
              >
                <span>{GROUP_LABELS[g]}</span>
                <span className="text-[10px] text-ink-muted">
                  {DEFS_BY_GROUP[g].length}
                </span>
              </button>
            );
          })}
          {unknownKeys.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                setSection("__unknown" as any);
              }}
              className={cn(
                "w-full text-left px-3 py-1.5 rounded-md text-sm transition-colors flex items-center justify-between",
                section === ("__unknown" as any)
                  ? "bg-[rgb(var(--accent-soft))] text-[rgb(var(--accent))] font-medium"
                  : "text-ink-secondary hover:text-ink hover:bg-surface-2"
              )}
            >
              <span>Other keys</span>
              <span className="text-[10px] text-ink-muted">
                {unknownKeys.length}
              </span>
            </button>
          )}
        </div>

        {dirtyCount > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            className="tile p-3 space-y-2 border-[rgb(var(--accent))]/40"
          >
            <div className="text-xs text-ink-muted">
              {dirtyCount} unsaved change{dirtyCount === 1 ? "" : "s"}
            </div>
            <div className="flex gap-2">
              <button
                className="btn btn-primary !py-1.5 !px-3 text-xs w-full"
                disabled={busy}
                onClick={save}
              >
                <Save size={13} /> Save
              </button>
              <button
                className="btn btn-ghost !py-1.5 !px-3 text-xs"
                onClick={() => setEdits({})}
              >
                <Undo2 size={13} />
              </button>
            </div>
          </motion.div>
        )}
      </aside>

      {/* Content */}
      <div className="space-y-5">
        {query ? (
          <Section
            title={`Search results (${filtered?.length ?? 0})`}
            defs={filtered ?? []}
            merged={merged}
            setValue={setValue}
            edits={edits}
            reset={resetField}
            applyDefault={applyDefault}
          />
        ) : section === ("__unknown" as any) ? (
          <UnknownKeysPanel
            keys={unknownKeys}
            values={merged}
            setValue={setValue}
            edits={edits}
            reset={resetField}
          />
        ) : (
          <Section
            title={GROUP_LABELS[section]}
            defs={DEFS_BY_GROUP[section]}
            merged={merged}
            setValue={setValue}
            edits={edits}
            reset={resetField}
            applyDefault={applyDefault}
          />
        )}

        <p className="text-xs text-ink-muted">
          Changes write to{" "}
          <code className="kbd">server.properties</code> immediately. Most
          settings take effect on next server restart.
        </p>
      </div>
    </div>
  );
}

function Section({
  title,
  defs,
  merged,
  setValue,
  edits,
  reset,
  applyDefault,
}: {
  title: string;
  defs: PropertyDef[];
  merged: Record<string, string>;
  setValue: (k: string, v: string) => void;
  edits: Record<string, string>;
  reset: (k: string) => void;
  applyDefault: (d: PropertyDef) => void;
}): JSX.Element {
  return (
    <section className="tile p-6">
      <h3 className="heading-md mb-5">{title}</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-5">
        {defs.map((d) => (
          <Row
            key={d.key}
            def={d}
            current={merged[d.key]}
            dirty={d.key in edits}
            onChange={(v) => setValue(d.key, v)}
            onReset={() => reset(d.key)}
            onDefault={() => applyDefault(d)}
          />
        ))}
      </div>
      {defs.length === 0 && (
        <div className="text-sm text-ink-muted">Nothing matches.</div>
      )}
    </section>
  );
}

function Row({
  def,
  current,
  dirty,
  onChange,
  onReset,
  onDefault,
}: {
  def: PropertyDef;
  current: string | undefined;
  dirty: boolean;
  onChange: (v: string) => void;
  onReset: () => void;
  onDefault: () => void;
}): JSX.Element {
  const fullWidth = def.type === "string" && (def as any).long;
  return (
    <div
      className={cn("space-y-1.5", fullWidth && "md:col-span-2")}
    >
      <div className="flex items-center justify-between gap-2">
        <label className="text-sm font-medium text-ink">{def.label}</label>
        {dirty && (
          <button
            type="button"
            className="text-[10px] text-ink-muted hover:text-ink underline"
            onClick={onReset}
          >
            revert
          </button>
        )}
      </div>
      {renderControl(def, current, onChange)}
      {def.help ? (
        <div className="text-xs text-ink-muted">
          {def.help}{" "}
          <button
            type="button"
            className="underline hover:text-ink"
            onClick={onDefault}
          >
            reset to default
          </button>
        </div>
      ) : (
        <div className="text-xs">
          <button
            type="button"
            className="text-ink-muted underline hover:text-ink"
            onClick={onDefault}
          >
            reset to default
          </button>
          <span className="text-ink-muted/60 font-mono ml-2">{def.key}</span>
        </div>
      )}
    </div>
  );
}

function renderControl(
  def: PropertyDef,
  current: string | undefined,
  onChange: (v: string) => void
): JSX.Element {
  if (def.type === "boolean") {
    const on =
      current === undefined ? def.default : current === "true";
    return (
      <button
        type="button"
        onClick={() => onChange(on ? "false" : "true")}
        className={cn(
          "relative inline-flex items-center h-7 w-12 rounded-full transition-colors",
          on
            ? "bg-[rgb(var(--accent))]"
            : "bg-surface-3 border border-line"
        )}
        aria-pressed={on}
        aria-label={def.label}
      >
        <motion.span
          initial={false}
          animate={{ x: on ? 22 : 2 }}
          transition={{ type: "spring", stiffness: 420, damping: 30 }}
          className="absolute w-5 h-5 rounded-full bg-white shadow top-1"
        />
      </button>
    );
  }
  if (def.type === "enum") {
    return (
      <select
        className="select"
        value={current ?? def.default}
        onChange={(e) => onChange(e.target.value)}
      >
        {def.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  if (def.type === "number") {
    return (
      <input
        type="number"
        className="input tabular-nums"
        value={current ?? String(def.default)}
        min={def.min}
        max={def.max}
        step={def.step}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <input
      type="text"
      className={cn("input", def.monospace && "font-mono text-xs")}
      value={current ?? def.default ?? ""}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function UnknownKeysPanel({
  keys,
  values,
  setValue,
  edits,
  reset,
}: {
  keys: string[];
  values: Record<string, string>;
  setValue: (k: string, v: string) => void;
  edits: Record<string, string>;
  reset: (k: string) => void;
}): JSX.Element {
  return (
    <section className="tile p-6">
      <h3 className="heading-md mb-1">Other keys</h3>
      <p className="text-sm text-ink-muted mb-5">
        Keys present in <code className="kbd">server.properties</code> that
        aren't in the curated list above (custom / mod-specific settings).
      </p>
      <div className="space-y-3">
        {keys.map((k) => (
          <div key={k} className="grid grid-cols-1 md:grid-cols-[220px_1fr_auto] gap-3 items-center">
            <code className="text-xs font-mono text-ink-secondary truncate">
              {k}
            </code>
            <input
              className="input font-mono text-xs"
              value={values[k] ?? ""}
              onChange={(e) => setValue(k, e.target.value)}
            />
            {k in edits && (
              <button
                type="button"
                className="text-xs text-ink-muted hover:text-ink underline"
                onClick={() => reset(k)}
              >
                revert
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

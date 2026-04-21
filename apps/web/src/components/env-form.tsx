"use client";
import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/cn";
import {
  ENV_DEFS_BY_GROUP,
  ENV_GROUP_LABELS,
  ENV_KNOWN_KEYS,
  type EnvDef,
  type EnvGroup,
} from "./env-meta";
import { ChevronDown, Plus, Trash2 } from "lucide-react";

const GROUP_ORDER: EnvGroup[] = [
  "gameplay",
  "world",
  "spawning",
  "jvm",
  "advanced",
];

/**
 * Typed form for itzg container env vars. The external state is the plain
 * `Record<string,string>` that the wizard already sends to the API, so the
 * form is a drop-in replacement for the old KEY=VALUE textarea.
 *
 * Anything in env that isn't in the curated list is surfaced in a
 * "Custom variables" editor at the bottom (add, edit, remove).
 */
export function EnvForm({
  env,
  onChange,
}: {
  env: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}): JSX.Element {
  const [openGroups, setOpenGroups] = useState<Record<EnvGroup, boolean>>({
    gameplay: true,
    world: false,
    spawning: false,
    jvm: false,
    advanced: false,
  });

  const customKeys = useMemo(
    () =>
      Object.keys(env)
        .filter((k) => !ENV_KNOWN_KEYS.has(k))
        .sort(),
    [env]
  );

  function setKey(key: string, value: string | undefined): void {
    const next = { ...env };
    if (value === undefined || value === "") {
      delete next[key];
    } else {
      next[key] = value;
    }
    onChange(next);
  }

  function toggleGroup(g: EnvGroup): void {
    setOpenGroups((s) => ({ ...s, [g]: !s[g] }));
  }

  return (
    <div className="space-y-3">
      {GROUP_ORDER.map((g) => {
        const defs = ENV_DEFS_BY_GROUP[g];
        const overriddenCount = defs.filter((d) => d.key in env).length;
        const open = openGroups[g];
        return (
          <div key={g} className="border border-line rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => toggleGroup(g)}
              className="w-full flex items-center justify-between px-4 py-3 bg-surface-2 hover:bg-[rgb(var(--bg-hover))] transition-colors"
            >
              <div className="flex items-center gap-3">
                <span className="font-medium text-sm">
                  {ENV_GROUP_LABELS[g]}
                </span>
                <span className="text-xs text-ink-muted">
                  {defs.length} settings
                  {overriddenCount > 0 && (
                    <>
                      {" · "}
                      <span className="text-[rgb(var(--accent))]">
                        {overriddenCount} set
                      </span>
                    </>
                  )}
                </span>
              </div>
              <ChevronDown
                size={16}
                className={cn(
                  "text-ink-muted transition-transform",
                  open && "rotate-180"
                )}
              />
            </button>
            {open && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                className="p-5 bg-[rgb(var(--bg-surface-1))]"
              >
                <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-5">
                  {defs.map((d) => (
                    <FieldRow
                      key={d.key}
                      def={d}
                      value={env[d.key]}
                      onChange={(v) => setKey(d.key, v)}
                    />
                  ))}
                </div>
              </motion.div>
            )}
          </div>
        );
      })}

      {/* Custom vars */}
      <CustomSection
        keys={customKeys}
        env={env}
        onSet={setKey}
      />
    </div>
  );
}

function FieldRow({
  def,
  value,
  onChange,
}: {
  def: EnvDef;
  value: string | undefined;
  onChange: (v: string | undefined) => void;
}): JSX.Element {
  const isSet = value !== undefined;
  const fullWidth = def.type === "string" && (def as any).long;
  return (
    <div className={cn("space-y-1.5", fullWidth && "md:col-span-2")}>
      <div className="flex items-center justify-between gap-2">
        <label className="text-sm font-medium text-ink">{def.label}</label>
        <div className="flex items-center gap-2 text-[10px] text-ink-muted">
          <code className="font-mono">{def.key}</code>
          {isSet && (
            <button
              type="button"
              onClick={() => onChange(undefined)}
              className="underline hover:text-ink"
            >
              clear
            </button>
          )}
        </div>
      </div>
      {renderControl(def, value, onChange)}
      {def.help && (
        <div className="text-xs text-ink-muted">{def.help}</div>
      )}
    </div>
  );
}

function renderControl(
  def: EnvDef,
  current: string | undefined,
  onChange: (v: string | undefined) => void
): JSX.Element {
  if (def.type === "boolean") {
    const on =
      current === undefined
        ? (def.default ?? false)
        : current === "true" || current === "TRUE" || current === "1";
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
        value={current ?? def.default ?? def.options[0]}
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
        value={current ?? (def.default !== undefined ? String(def.default) : "")}
        min={def.min}
        max={def.max}
        step={def.step}
        onChange={(e) => onChange(e.target.value || undefined)}
      />
    );
  }
  // string
  const Cmp = (def as any).long ? "textarea" : "input";
  return (
    <Cmp
      className={cn(
        (def as any).long ? "textarea h-20" : "input",
        (def as any).monospace && "font-mono text-xs"
      )}
      value={current ?? def.default ?? ""}
      onChange={(e: any) => onChange(e.target.value || undefined)}
      placeholder={def.default}
    />
  );
}

function CustomSection({
  keys,
  env,
  onSet,
}: {
  keys: string[];
  env: Record<string, string>;
  onSet: (key: string, value: string | undefined) => void;
}): JSX.Element {
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");

  function add(): void {
    const k = newKey.trim().toUpperCase();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) return;
    onSet(k, newValue);
    setNewKey("");
    setNewValue("");
  }

  return (
    <div className="border border-line rounded-lg overflow-hidden">
      <div className="px-4 py-3 bg-surface-2 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="font-medium text-sm">Custom variables</span>
          <span className="text-xs text-ink-muted">
            {keys.length === 0
              ? "none"
              : `${keys.length} defined`}
          </span>
        </div>
      </div>
      <div className="p-5 space-y-3">
        {keys.map((k) => (
          <div
            key={k}
            className="grid grid-cols-1 md:grid-cols-[220px_1fr_auto] gap-3 items-center"
          >
            <code className="text-xs font-mono text-ink-secondary truncate">
              {k}
            </code>
            <input
              className="input font-mono text-xs"
              value={env[k] ?? ""}
              onChange={(e) => onSet(k, e.target.value)}
            />
            <button
              type="button"
              className="btn btn-ghost btn-icon !h-8 !w-8"
              onClick={() => onSet(k, undefined)}
              aria-label="Remove"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        <div className="grid grid-cols-1 md:grid-cols-[220px_1fr_auto] gap-3 items-center pt-2 border-t border-line">
          <input
            className="input font-mono text-xs"
            placeholder="NEW_KEY"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
            }}
          />
          <input
            className="input font-mono text-xs"
            placeholder="value"
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
            }}
          />
          <button
            type="button"
            className="btn btn-subtle !h-8 !px-3"
            onClick={add}
            disabled={!newKey.trim() || !/^[A-Z_][A-Z0-9_]*$/.test(newKey.trim().toUpperCase())}
          >
            <Plus size={14} /> Add
          </button>
        </div>
        <p className="text-xs text-ink-muted">
          Any env var accepted by the{" "}
          <code className="kbd">itzg/minecraft-server</code> image will work.
        </p>
      </div>
    </div>
  );
}

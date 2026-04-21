"use client";
import { cn } from "@/lib/cn";

/** Present RAM in a human-friendly unit. 1024 MB → "1 GB", 8192 → "8 GB". */
export function formatMemory(mb: number): string {
  if (mb >= 1024) {
    const g = mb / 1024;
    return `${Number.isInteger(g) ? g.toFixed(0) : g.toFixed(1)} GB`;
  }
  return `${mb} MB`;
}

const PRESETS = [1024, 2048, 4096, 6144, 8192, 12288, 16384];

/**
 * Memory picker — range slider with presets. Far friendlier than a number
 * input, especially on mobile. Step = 512 MB so users can still dial in
 * half-gigabyte values for Vanilla if they want.
 */
export function MemorySlider({
  value,
  onChange,
  min = 512,
  max = 32768,
  step = 512,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}): JSX.Element {
  const pct = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between">
        <span className="text-3xl font-semibold tabular-nums">
          {formatMemory(value)}
        </span>
        <span className="text-xs text-ink-muted">
          {formatMemory(min)} — {formatMemory(max)}
        </span>
      </div>

      <div
        className="relative h-2 rounded-full bg-surface-3"
        style={{ touchAction: "none" }}
      >
        <div
          className="absolute left-0 top-0 h-full rounded-full bg-[rgb(var(--accent))]"
          style={{ width: `${pct}%` }}
        />
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          aria-label="Memory"
        />
        <span
          className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-4 h-4 rounded-full bg-white border-2 border-[rgb(var(--accent))] shadow-sm pointer-events-none transition-all"
          style={{ left: `${pct}%` }}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        {PRESETS.map((p) => {
          const active = value === p;
          return (
            <button
              key={p}
              type="button"
              onClick={() => onChange(Math.min(max, Math.max(min, p)))}
              className={cn(
                "px-3 py-1 text-xs rounded-full border transition-colors",
                active
                  ? "bg-[rgb(var(--accent-soft))] border-[rgb(var(--accent))]/40 text-[rgb(var(--accent))]"
                  : "border-line text-ink-secondary hover:bg-surface-2"
              )}
            >
              {formatMemory(p)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

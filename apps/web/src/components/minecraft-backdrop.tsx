"use client";

import { useMemo } from "react";
import { useMotionEnabled } from "@/lib/motion-pref";
import { useBackdropBeat } from "@/lib/backdrop-beat";

/**
 * Decorative Minecraft-ish backdrop — a blocky pseudo-skyline of
 * coloured squares rising from the bottom of the viewport. Each column
 * has a base height and a "live" height that lifts the column by an
 * integer number of blocks on every beat — never a fractional cell, so
 * the top "grass" slab is always either fully in cell N or fully in
 * cell N+1. Snap, not slide. That preserves the pixel-block feel.
 *
 * Animation source:
 *   • If background music is on and a manifest track is playing, the
 *     beat counter (from <BackdropBeatProvider>) ticks on every quarter
 *     note, and the backdrop pulses in sync with the soundtrack.
 *   • Otherwise the same counter advances at a fallback 90 BPM so the
 *     panel still has a quiet pulse without sound.
 *
 * Determinism: `seededColumns` derives the base silhouette + each
 * column's beat-response signature from a fixed seed, so SSR and the
 * client hydration pass land on the same shape.
 *
 * Sits behind all content (fixed, z-0, pointer-events: none) and picks
 * up the active theme accent through CSS variables.
 */

const COLS = 80;
const BLOCK = 20; // px in the viewBox
const MAX_HEIGHT = 14; // in blocks
const SEED = 1337;
const TOTAL_W = COLS * BLOCK;
const TOTAL_H = MAX_HEIGHT * BLOCK;

type Column = {
  x: number;
  baseBlocks: number; // silhouette height, in whole blocks
  /** How many blocks this column lifts on a "strong" beat (1–3). */
  pulse: number;
  /** Mod period — column reacts on beats where `beat % period === phase`.
   *  Distributing periods across {1,2,3,4} gives kick/snare/hat-style
   *  layering instead of every column flashing in unison. */
  period: number;
  phase: number;
};

function seededColumns(): Column[] {
  const out: Column[] = [];
  let s = SEED;
  const rand = (): number => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
  for (let i = 0; i < COLS; i++) {
    const r = rand();
    const base = 0.55 + 0.45 * Math.sin(i / 4 + r * 1.5);
    const baseBlocks = Math.max(
      2,
      Math.min(MAX_HEIGHT, Math.floor(base * MAX_HEIGHT))
    );
    // Distribute pulse periods. ~50% react every beat (kick), ~30%
    // every other beat (snare), ~20% every 4th (off-beat accent).
    const pr = rand();
    const period = pr < 0.5 ? 1 : pr < 0.8 ? 2 : 4;
    const phase = Math.floor(rand() * period);
    // Pulse amplitude in whole blocks. Constrained so a column never
    // exceeds MAX_HEIGHT.
    const headroom = MAX_HEIGHT - baseBlocks;
    const wantedPulse = 1 + Math.floor(rand() * 3); // 1..3
    const pulse = Math.max(0, Math.min(wantedPulse, headroom));
    out.push({ x: i * BLOCK, baseBlocks, pulse, period, phase });
  }
  return out;
}

export function MinecraftBackdrop(): JSX.Element {
  const cols = useMemo(seededColumns, []);
  const motionOn = useMotionEnabled();
  const { beat } = useBackdropBeat();

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 bottom-0 z-0 select-none opacity-[0.18] dark:opacity-[0.22]"
      style={{
        height: "clamp(220px, 44vh, 440px)",
        WebkitMaskImage:
          "linear-gradient(to top, black 0%, black 35%, transparent 100%)",
        maskImage:
          "linear-gradient(to top, black 0%, black 35%, transparent 100%)",
      }}
    >
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${TOTAL_W} ${TOTAL_H}`}
        preserveAspectRatio="xMidYMax slice"
      >
        <defs>
          {/* Faint 1px pixel grid — makes the silhouette read as
              "blocks" rather than one big shape. */}
          <pattern
            id="mc-grid"
            width={BLOCK}
            height={BLOCK}
            patternUnits="userSpaceOnUse"
          >
            <path
              d={`M ${BLOCK} 0 L 0 0 0 ${BLOCK}`}
              fill="none"
              stroke="rgb(var(--accent))"
              strokeOpacity="0.35"
              strokeWidth="1"
            />
          </pattern>
        </defs>

        {cols.map((c, i) => {
          // Live height = baseBlocks + pulse-on-this-beat. When motion
          // is off we render the static silhouette only.
          const lift =
            motionOn && c.pulse > 0 && beat % c.period === c.phase
              ? c.pulse
              : 0;
          const heightBlocks = c.baseBlocks + lift;
          const heightPx = heightBlocks * BLOCK;
          const y = TOTAL_H - heightPx;
          return (
            <g key={i}>
              {/* Body of the column — the "dirt" */}
              <rect
                x={c.x}
                y={y}
                width={BLOCK}
                height={heightPx}
                fill="rgb(var(--accent))"
                opacity="0.55"
              />
              {/* Top slab — the "grass". Always exactly one block tall,
                  always snapped to a grid cell (no fractional y). */}
              <rect
                x={c.x}
                y={y}
                width={BLOCK}
                height={BLOCK}
                fill="rgb(var(--accent))"
              />
            </g>
          );
        })}

        {/* Grid overlay so cell seams are visible. */}
        <rect
          x={0}
          y={0}
          width={TOTAL_W}
          height={TOTAL_H}
          fill="url(#mc-grid)"
        />
      </svg>
    </div>
  );
}

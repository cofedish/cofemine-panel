"use client";

import { useMemo } from "react";
import { useMotionEnabled } from "@/lib/motion-pref";

/**
 * Decorative Minecraft-ish backdrop — a blocky pseudo-skyline of squares
 * that rises from the bottom of the viewport with a jagged top and fades
 * into the background. Deterministic (seeded) column heights so the SVG
 * stays identical between SSR and the client hydration pass, and so the
 * user sees the same silhouette across reloads.
 *
 * Animation, when motion is enabled: each column pulses vertically like
 * an audio equalizer — the column's *height* oscillates while its base
 * stays anchored to the floor. Implemented via SMIL `<animate>` on the
 * rect's `y` and `height` attributes (no transforms, so the grass slabs
 * stay perfectly square at every frame). Per-column duration, amplitude
 * and delay are seeded so neighbours fall out of phase and you see a
 * wave-like ripple instead of every column bouncing in unison.
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
  baseH: number; // pixels
  baseY: number; // pixels (top of column)
  ampl: number; // pixels of vertical pulse
  dur: number; // seconds
  delay: number; // seconds (negative — start mid-cycle)
};

function seededColumns(): Column[] {
  // Single LCG fed from `SEED` produces every per-column value
  // deterministically. SSR and client hydration land on the same shape.
  const out: Column[] = [];
  let s = SEED;
  const rand = (): number => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
  for (let i = 0; i < COLS; i++) {
    const r = rand();
    const base = 0.55 + 0.45 * Math.sin(i / 4 + r * 1.5);
    const heightBlocks = Math.max(2, Math.min(MAX_HEIGHT, Math.floor(base * MAX_HEIGHT)));
    const baseH = heightBlocks * BLOCK;
    const baseY = TOTAL_H - baseH;
    // Pulse amplitude: 0.4–1.2 blocks. Clamped so a column never grows
    // taller than MAX_HEIGHT (top of viewBox).
    const headroom = baseY; // pixels we can grow upward before hitting 0
    const wantedAmpl = (0.4 + rand() * 0.8) * BLOCK;
    const ampl = Math.max(2, Math.min(wantedAmpl, headroom));
    // Per-column duration in [2.4s, 4.8s] so the row reads as an
    // equalizer with multiple frequencies, not a single uniform wave.
    const dur = 2.4 + rand() * 2.4;
    // Negative offset so the column starts mid-cycle on first paint.
    const delay = -rand() * dur;
    out.push({ x: i * BLOCK, baseH, baseY, ampl, dur, delay });
  }
  return out;
}

export function MinecraftBackdrop(): JSX.Element {
  const cols = useMemo(seededColumns, []);
  const motionOn = useMotionEnabled();

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
          {/* Faint 1px pixel grid that makes the skyline read as "blocks"
              rather than one big coloured shape. */}
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

        {cols.map((c, i) => (
          <Column key={i} c={c} animated={motionOn} />
        ))}

        {/* Grid overlay on top of everything so block seams are visible. */}
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

function Column({ c, animated }: { c: Column; animated: boolean }): JSX.Element {
  // Animated values: column grows by `ampl` upward (y shrinks, height grows
  // by the same amount). Bottom edge stays pinned to TOTAL_H so blocks
  // never separate from the floor.
  const minY = c.baseY - c.ampl;
  const maxH = c.baseH + c.ampl;
  // Two-phase keyframe pattern so the up/down ramps spend equal time —
  // a 0→1→0 sin-ish triangle. `keyTimes` smooths the apex.
  const yValues = `${c.baseY};${minY};${c.baseY}`;
  const hValues = `${c.baseH};${maxH};${c.baseH}`;
  const grassY = `${c.baseY};${minY};${c.baseY}`;

  return (
    <g>
      {/* Body of the column — the "dirt" */}
      <rect
        x={c.x}
        y={c.baseY}
        width={BLOCK}
        height={c.baseH}
        fill="rgb(var(--accent))"
        opacity="0.55"
      >
        {animated && (
          <>
            <animate
              attributeName="y"
              values={yValues}
              keyTimes="0;0.5;1"
              dur={`${c.dur}s`}
              begin={`${c.delay}s`}
              repeatCount="indefinite"
              calcMode="spline"
              keySplines="0.4 0 0.6 1; 0.4 0 0.6 1"
            />
            <animate
              attributeName="height"
              values={hValues}
              keyTimes="0;0.5;1"
              dur={`${c.dur}s`}
              begin={`${c.delay}s`}
              repeatCount="indefinite"
              calcMode="spline"
              keySplines="0.4 0 0.6 1; 0.4 0 0.6 1"
            />
          </>
        )}
      </rect>
      {/* Brighter top slab — the "grass". Always exactly one block tall so
          the square shape never distorts; only its `y` follows the body. */}
      <rect
        x={c.x}
        y={c.baseY}
        width={BLOCK}
        height={BLOCK}
        fill="rgb(var(--accent))"
      >
        {animated && (
          <animate
            attributeName="y"
            values={grassY}
            keyTimes="0;0.5;1"
            dur={`${c.dur}s`}
            begin={`${c.delay}s`}
            repeatCount="indefinite"
            calcMode="spline"
            keySplines="0.4 0 0.6 1; 0.4 0 0.6 1"
          />
        )}
      </rect>
    </g>
  );
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMotionEnabled } from "@/lib/motion-pref";
import { useBackdropBeat } from "@/lib/backdrop-beat";

/**
 * Minecraft block silhouette that IS the music visualiser.
 *
 * 120 grass-capped block columns drawn as SVG. Each column is mapped
 * to its own log-spaced FFT band. When music plays, column heights
 * are driven by the analyser's frequency data — the silhouette
 * itself dances. When music isn't playing, columns smoothly settle
 * back to their seeded baseline heights, so the row always reads as
 * the familiar Minecraft skyline.
 *
 * Why this and not audiomotion-analyzer? The user wants the MC
 * silhouette columns themselves to react, not a separate visualiser
 * layered on top. audioMotion can't render Minecraft-style
 * grass-capped pixel-block columns — only LED bars / bands — so we
 * own the rendering, and audioMotion's analyser became unnecessary.
 *
 * Anti-jitter pipeline (lessons from earlier revisions):
 *   - Per-column FLOAT level smoothed with peak-hold + slow decay.
 *   - Float → integer cell count via HYSTERESIS (deadband 0.6 cells)
 *     so a level oscillating around a half-cell boundary doesn't
 *     flicker between two integer heights every frame.
 *   - Each column draws a "dirt" body + a one-cell "grass" cap,
 *     both snapped to integer cell boundaries — slabs are always
 *     fully aligned with one grid cell.
 *
 * Also lays a pixel-grid overlay on top to keep the block aesthetic
 * even on tall columns.
 */

const COLS = 120;
const BLOCK = 8; // viewBox px per cell
const MAX_HEIGHT = 28; // cells
const TOTAL_W = COLS * BLOCK; // 960
const TOTAL_H = MAX_HEIGHT * BLOCK; // 224
const SEED = 1337;

// Frequency band edges (Hz). C418 / synth / percussive content lives
// almost entirely in this range.
const MIN_HZ = 60;
const MAX_HZ = 6000;

// dB normalisation window. Float frequency data from the analyser is
// in dBFS; we squish [-65..-20] to bar height. NOISE_FLOOR_DB hard-
// cuts so quiet bands fall off the silhouette instead of holding a
// flat plateau.
const MIN_DB = -65;
const MAX_DB = -20;
const NOISE_FLOOR_DB = -58;

// Smoothing.
const ATTACK = 0.55; // float lerp on rising edge (~3 frames to peak)
const DECAY = 0.93; // multiplicative tail per frame
const HYSTERESIS = 0.6; // cell deadband on integer rounding
// How fast columns drift back toward the seeded baseline when music
// stops. Slow lerp so the transition feels organic.
const IDLE_DRIFT = 0.05;

type Column = {
  /** Seeded baseline height in cells — what the silhouette looks
   *  like when music is paused. */
  baseHeight: number;
};

function seededColumns(): Column[] {
  const out: Column[] = [];
  let s = SEED;
  for (let i = 0; i < COLS; i++) {
    s = (s * 9301 + 49297) % 233280;
    const r = s / 233280;
    const base = 0.55 + 0.45 * Math.sin(i / 4 + r * 1.5);
    out.push({
      baseHeight: Math.max(2, Math.min(MAX_HEIGHT, Math.floor(base * MAX_HEIGHT))),
    });
  }
  return out;
}

export function MinecraftBackdrop(): JSX.Element {
  const motionOn = useMotionEnabled();
  const { getAnalyser, playing } = useBackdropBeat();
  const cols = useMemo(seededColumns, []);

  // Smoothed per-column height in CELLS (float). Rendering snaps to
  // integer via hysteresis. Initialised to baseline so the first
  // paint is a clean silhouette.
  const liveRef = useRef<Float32Array>(
    Float32Array.from(cols.map((c) => c.baseHeight))
  );
  // Integer cell counts actually drawn. Updated only when the float
  // crosses the hysteresis deadband.
  const displayedRef = useRef<Int8Array>(
    Int8Array.from(cols.map((c) => c.baseHeight))
  );
  // FFT buffer.
  const freqRef = useRef<Float32Array<ArrayBuffer>>(
    new Float32Array(new ArrayBuffer(1024 * 4))
  );
  // Bumped each frame to trigger re-render; the rect attrs read
  // from displayedRef directly.
  const [, setFrame] = useState(0);

  // Per-column FFT bin range. Built lazily once we know the audio
  // sample rate (taken from the analyser's audioContext).
  const binRangesRef = useRef<Array<[number, number]> | null>(null);
  const lastSampleRateRef = useRef(0);
  function ensureBinRanges(sampleRate: number, binCount: number): void {
    if (
      binRangesRef.current &&
      lastSampleRateRef.current === sampleRate
    ) {
      return;
    }
    const hzPerBin = sampleRate / (binCount * 2);
    const lnMin = Math.log(MIN_HZ);
    const lnMax = Math.log(MAX_HZ);
    const ranges: Array<[number, number]> = [];
    let prevHz = MIN_HZ;
    for (let i = 0; i < COLS; i++) {
      const tNext = (i + 1) / COLS;
      const nextHz = Math.exp(lnMin + tNext * (lnMax - lnMin));
      const startBin = clamp(
        Math.floor(prevHz / hzPerBin),
        1,
        binCount - 1
      );
      const endBin = clamp(
        Math.max(startBin + 1, Math.ceil(nextHz / hzPerBin)),
        startBin + 1,
        binCount
      );
      ranges.push([startBin, endBin]);
      prevHz = nextHz;
    }
    binRangesRef.current = ranges;
    lastSampleRateRef.current = sampleRate;
  }

  useEffect(() => {
    if (!motionOn) {
      // Snap to baseline silhouette.
      for (let i = 0; i < COLS; i++) {
        liveRef.current[i] = cols[i]!.baseHeight;
        displayedRef.current[i] = cols[i]!.baseHeight;
      }
      setFrame((f) => (f + 1) % 1024);
      return;
    }
    let raf = 0;
    const tick = (): void => {
      const live = liveRef.current;
      const analyser = getAnalyser();
      if (analyser && playing) {
        const binCount = analyser.frequencyBinCount;
        ensureBinRanges(analyser.context.sampleRate, binCount);
        const ranges = binRangesRef.current!;
        if (freqRef.current.length !== binCount) {
          freqRef.current = new Float32Array(new ArrayBuffer(binCount * 4));
        }
        analyser.getFloatFrequencyData(freqRef.current);
        const f = freqRef.current;
        for (let i = 0; i < COLS; i++) {
          const [start, end] = ranges[i]!;
          // Per-band peak in dB.
          let peakDb = -Infinity;
          for (let b = start; b < end; b++) {
            const v = f[b]!;
            if (v > peakDb) peakDb = v;
          }
          let targetCells: number;
          if (peakDb < NOISE_FLOOR_DB) {
            // Below the noise gate — fall back to the baseline so
            // quiet bands still show the silhouette beneath the
            // peaks. Without this, a silent FFT wipes the silhouette
            // as soon as music starts.
            targetCells = cols[i]!.baseHeight;
          } else {
            let norm = (peakDb - MIN_DB) / (MAX_DB - MIN_DB);
            if (norm < 0) norm = 0;
            else if (norm > 1) norm = 1;
            // Power 1.4 squashes mids so bars with real content stand
            // out and most others sit near baseline.
            norm = Math.pow(norm, 1.4);
            // Map to total height. We use max(silhouette, fft) so
            // FFT can ONLY add to the column, never push it below
            // the static baseline. The user's "ВОТ ОНИ И ДОЛЖНЫ ПОД
            // МУЗЫКУ ДВИГАТЬСЯ" — columns dance UP from the silhouette.
            targetCells = Math.max(
              cols[i]!.baseHeight,
              Math.round(norm * MAX_HEIGHT)
            );
          }
          const cur = live[i]!;
          // Peak-hold + slow decay: snap up fast, drift down slow.
          if (targetCells > cur) {
            live[i] = cur + (targetCells - cur) * ATTACK;
          } else {
            live[i] = Math.max(targetCells, cur * DECAY);
          }
        }
      } else {
        // Music paused / not initialised. Drift each column toward
        // its seeded baseline so the silhouette settles in cleanly.
        for (let i = 0; i < COLS; i++) {
          const target = cols[i]!.baseHeight;
          const cur = live[i]!;
          live[i] = cur + (target - cur) * IDLE_DRIFT;
        }
      }

      // Float → integer cell count with hysteresis. Stops the
      // half-cell flicker.
      const disp = displayedRef.current;
      for (let i = 0; i < COLS; i++) {
        const f = live[i]!;
        const cur = disp[i]!;
        if (f - cur > HYSTERESIS) {
          disp[i] = Math.min(MAX_HEIGHT, Math.floor(f));
        } else if (cur - f > HYSTERESIS) {
          disp[i] = Math.max(0, Math.ceil(f));
        }
      }

      setFrame((fr) => (fr + 1) % 1024);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [motionOn, playing, getAnalyser, cols]);

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 bottom-0 z-0 select-none opacity-[0.32] dark:opacity-[0.42]"
      style={{
        height: "clamp(180px, 32vh, 360px)",
        WebkitMaskImage:
          "linear-gradient(to top, black 0%, black 60%, transparent 100%)",
        maskImage:
          "linear-gradient(to top, black 0%, black 60%, transparent 100%)",
      }}
    >
      <svg
        className="w-full h-full"
        viewBox={`0 0 ${TOTAL_W} ${TOTAL_H}`}
        preserveAspectRatio="xMidYMax slice"
      >
        <defs>
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
              strokeOpacity="0.32"
              strokeWidth="0.5"
            />
          </pattern>
        </defs>

        {Array.from({ length: COLS }).map((_, i) => {
          const blocks = displayedRef.current[i] ?? 0;
          if (blocks <= 0) return null;
          const heightPx = blocks * BLOCK;
          const y = TOTAL_H - heightPx;
          return (
            <g key={i}>
              {/* Dirt body */}
              <rect
                x={i * BLOCK}
                y={y}
                width={BLOCK}
                height={heightPx}
                fill="rgb(var(--accent))"
                opacity="0.55"
              />
              {/* Grass cap — exactly one cell, snapped to the
                  column's current top edge. Always fully inside
                  one grid cell, never floating between two. */}
              <rect
                x={i * BLOCK}
                y={y}
                width={BLOCK}
                height={BLOCK}
                fill="rgb(var(--accent))"
              />
            </g>
          );
        })}

        {/* Pixel-grid overlay on top of everything so cell seams
            cross both the columns and the empty viewBox above. */}
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

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

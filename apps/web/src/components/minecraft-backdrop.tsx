"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMotionEnabled } from "@/lib/motion-pref";
import { useBackdropBeat } from "@/lib/backdrop-beat";

/**
 * Music-reactive Minecraft-y backdrop. Renders a row of narrow column
 * blocks at the bottom of the viewport whose heights are driven by
 * frequency data from the live audio stream.
 *
 * When music is playing:
 *   - Pull a freshly-sampled FFT spectrum from the BackdropBeat
 *     provider's AnalyserNode each animation frame.
 *   - Map columns to FFT bins on a mild log curve so each column
 *     covers a roughly equal-width band of perceptual frequencies.
 *   - Boost low-amplitude signals via a sqrt curve so quiet ambient
 *     tracks like "Sweden" still drive visible motion.
 *
 * When music is paused or unavailable, a procedural "calm waves"
 * fallback drives the columns so the panel still has gentle motion.
 *
 * Stepping (the bit the user cares about most):
 *   - Heights are integer multiples of BLOCK. The top "grass" slab is
 *     ALWAYS fully aligned with one grid cell — never half-way between
 *     two cells.
 *   - Per frame, the rendered height moves by AT MOST `RISE_STEP` cells
 *     up or `FALL_STEP` cells down toward the FFT-derived target. So a
 *     column can never teleport across cells — it always passes through
 *     every intermediate cell on its way to a peak. Stepping is fast
 *     (60 fps × 2 cells/frame = 120 cells/sec on attack), so visually
 *     it reads as snappy, but every cell gets at least one frame.
 *   - Attack > Release for the classic peak-meter pop-and-tail.
 *
 * Sits behind everything (fixed, z-0, pointer-events: none).
 */

const COLS = 160;
const BLOCK = 6;
const MAX_HEIGHT = 36; // in blocks → 216px viewBox tall
const TOTAL_W = COLS * BLOCK;
const TOTAL_H = MAX_HEIGHT * BLOCK;

// Per-frame step limits, in whole BLOCK cells. Rise faster than fall so
// peaks pop and tails linger — peak-meter style. Both are positive.
const RISE_STEP = 2;
const FALL_STEP = 1;
// Always keep at least this many blocks visible so quiet tracks aren't
// flat lines.
const FLOOR_BLOCKS = 2;

export function MinecraftBackdrop(): JSX.Element {
  const motionOn = useMotionEnabled();
  const { getAnalyser, playing } = useBackdropBeat();
  // Per-column rendered heights, in WHOLE BLOCK cells. Persistent
  // across frames; the rAF loop nudges each value at most `RISE_STEP`
  // up or `FALL_STEP` down per frame toward the current FFT target,
  // never skipping cells. Stored as a 16-bit int array — heights are
  // never larger than MAX_HEIGHT (36) so 8-bit would do too, but 16
  // matches typical rAF perf on every browser.
  const heightsRef = useRef<Int16Array>(new Int16Array(COLS));
  // Reusable buffer for getByteFrequencyData. fftSize=512 → 256 bins.
  // Using `new ArrayBuffer(...)` keeps the byte buffer typed as
  // `ArrayBuffer` (not `ArrayBufferLike`) so newer DOM lib types
  // accept it as the parameter to `getByteFrequencyData`.
  const freqRef = useRef<Uint8Array<ArrayBuffer>>(
    new Uint8Array(new ArrayBuffer(256))
  );
  // Bumped each frame so React re-renders the SVG; the rect attrs
  // read from heightsRef.current at render time.
  const [, setFrame] = useState(0);

  // Per-column FFT bin index, computed once. Log mapping concentrates
  // the columns over the audible/musical range and avoids the dead
  // tail of high bins where there's nothing to show.
  const binMap = useMemo(() => {
    const out = new Uint16Array(COLS);
    const minBin = 2; // skip DC + first bin (rumble)
    const maxBin = 110; // ~10kHz at 48kHz sample rate; rest is mostly silent
    for (let i = 0; i < COLS; i++) {
      const t = i / (COLS - 1);
      // Mild log curve — pure log was too bottom-heavy.
      const k = Math.pow(t, 1.5);
      out[i] = Math.min(
        maxBin,
        Math.max(minBin, Math.round(minBin + k * (maxBin - minBin)))
      );
    }
    return out;
  }, []);

  useEffect(() => {
    if (!motionOn) {
      // Static silhouette — settle to a flat baseline.
      heightsRef.current.fill(Math.floor(MAX_HEIGHT * 0.4));
      setFrame((f) => (f + 1) % 1024);
      return;
    }
    let raf = 0;
    let phase = 0;
    const tick = (): void => {
      const heights = heightsRef.current;
      const analyser = getAnalyser();
      // 1) Compute integer cell target per column.
      // 2) Step current toward target by at most RISE_STEP / FALL_STEP
      //    cells. Never teleport — every intermediate cell gets at
      //    least one frame on screen.
      if (analyser && playing) {
        analyser.getByteFrequencyData(freqRef.current);
        const f = freqRef.current;
        for (let i = 0; i < COLS; i++) {
          const raw = f[binMap[i]!]! / 255;
          // sqrt expands small signals (ambient C418 tracks barely
          // peg the bytes; we want the bars visibly moving anyway).
          const level = Math.sqrt(raw);
          const target = clamp(
            Math.round(level * MAX_HEIGHT),
            FLOOR_BLOCKS,
            MAX_HEIGHT
          );
          heights[i] = stepToward(heights[i]!, target);
        }
      } else {
        // Procedural fallback. Two sine layers, slow phase, low amp.
        phase += 0.012;
        for (let i = 0; i < COLS; i++) {
          const t =
            0.32 +
            0.18 * Math.sin(i * 0.16 + phase) +
            0.08 * Math.sin(i * 0.43 + phase * 1.7);
          const target = clamp(
            Math.round(t * MAX_HEIGHT),
            FLOOR_BLOCKS,
            MAX_HEIGHT
          );
          // In fallback mode neither rise nor fall should be jumpy —
          // we want the silhouette to read as breathing, not pulsing.
          // 1 cell per frame in either direction is plenty.
          heights[i] = stepTowardCalm(heights[i]!, target);
        }
      }
      setFrame((f) => (f + 1) % 1024);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [motionOn, playing, getAnalyser, binMap]);

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
          {/* Pixel grid overlay — keeps the block aesthetic even with
              sub-pixel column heights. */}
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
              strokeWidth="0.5"
            />
          </pattern>
          {/* Vertical accent gradient — bottom slightly darker, top
              brighter — so each column reads "lit from above". */}
          <linearGradient id="mc-col-grad" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="rgb(var(--accent))" stopOpacity="1" />
            <stop offset="100%" stopColor="rgb(var(--accent))" stopOpacity="0.55" />
          </linearGradient>
        </defs>

        {Array.from({ length: COLS }).map((_, i) => {
          // Heights are integer cell counts → multiplying by BLOCK
          // keeps the top edge perfectly aligned with a grid cell, so
          // the bright "grass" slab is always fully inside one cell.
          const blocks = heightsRef.current[i] ?? 0;
          const heightPx = blocks * BLOCK;
          const y = TOTAL_H - heightPx;
          return (
            <g key={i}>
              {/* Column body — gradient gives depth. */}
              <rect
                x={i * BLOCK}
                y={y}
                width={BLOCK}
                height={heightPx}
                fill="url(#mc-col-grad)"
              />
              {/* Bright "grass" strip exactly one block tall, snapped
                  to the column's current top. Square-block silhouette
                  preserved at every frame. */}
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

/* ============================== HELPERS ============================== */

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Step `current` toward `target` by at most RISE_STEP cells up or
 * FALL_STEP cells down. Returns the new integer height. The constraint
 * "≤ N cells per frame" is what guarantees the top slab passes through
 * every intermediate cell on its way to a peak instead of teleporting.
 */
function stepToward(current: number, target: number): number {
  if (current === target) return current;
  if (current < target) {
    const diff = target - current;
    return current + (diff < RISE_STEP ? diff : RISE_STEP);
  }
  const diff = current - target;
  return current - (diff < FALL_STEP ? diff : FALL_STEP);
}

/**
 * Calmer step variant for the no-music procedural fallback — exactly
 * one cell per frame in either direction. The silhouette breathes
 * instead of pulsing.
 */
function stepTowardCalm(current: number, target: number): number {
  if (current === target) return current;
  return current < target ? current + 1 : current - 1;
}

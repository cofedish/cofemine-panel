"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMotionEnabled } from "@/lib/motion-pref";
import { useBackdropBeat } from "@/lib/backdrop-beat";

/**
 * Music-reactive backdrop, rebuilt to behave like a real audio
 * visualiser (audioMotion / Winamp / Wallpaper Engine vibe).
 *
 * Pattern, in three sentences:
 *   1. Each frame, sample the AnalyserNode's byte frequency data and
 *      pull one bin per column (octave-equal mapping).
 *   2. Convert the raw byte to a perceptual loudness via a mild power
 *      curve, then apply per-column "peak hold + exponential decay":
 *      if the new value is higher than the current, snap to it (fast
 *      attack via a one-pole low-pass); otherwise let the column tail
 *      drop a small fraction every frame. That's what gives a real
 *      visualiser its sharp peaks and lingering tails.
 *   3. Render heights as sub-pixel floats — no integer-cell snapping.
 *      The grid pattern overlay keeps the pixel-block feel; the
 *      "grass-slab" cap from the previous revision is dropped because
 *      it can't be both fully-aligned-to-a-cell *and* smooth.
 *
 * When music is paused or unavailable, a per-column independent
 * sine oscillator (no horizontal traveling wave) drives a calm
 * breathing silhouette so the panel still has motion.
 */

const COLS = 160;
const BAR_WIDTH = 6; // viewBox px per bar
const TOTAL_W = COLS * BAR_WIDTH;
const TOTAL_H = 240; // viewBox tall

// Smoothing knobs. ATTACK is the fraction of "new target → current"
// blended in on the rising edge — 0.6 means peaks land in ~3 frames.
// DECAY is the per-frame multiplier when the input drops below the
// current peak — 0.94 gives a tail that halves over ~12 frames
// (~200ms at 60fps), the classic "peak meter" look.
const ATTACK = 0.6;
const DECAY = 0.94;
// Floor as a fraction of viewBox height. Quiet ambient passages
// settle into a thin baseline instead of vanishing entirely.
const FLOOR = 0.02;

export function MinecraftBackdrop(): JSX.Element {
  const motionOn = useMotionEnabled();
  const { getAnalyser, playing } = useBackdropBeat();
  // Per-column rendered heights as floats in [0, 1]. Persistent
  // across frames; the rAF loop mutates in place.
  const heightsRef = useRef<Float32Array>(new Float32Array(COLS));
  // Reusable buffer for getByteFrequencyData. fftSize=512 → 256 bins.
  const freqRef = useRef<Uint8Array<ArrayBuffer>>(
    new Uint8Array(new ArrayBuffer(256))
  );
  const [, setFrame] = useState(0);

  // Octave-equal log mapping from column index to FFT bin. Range
  // 2..64 covers the audible band where C418-style ambient + most
  // synth/percussive material actually has content (~85 Hz to
  // 5.5 kHz at 44.1 kHz sample rate). Linear or wider mappings left
  // the right half of the row dead.
  const binMap = useMemo(() => {
    const out = new Uint16Array(COLS);
    const minBin = 2;
    const maxBin = 64;
    const lnMin = Math.log(minBin);
    const lnMax = Math.log(maxBin);
    for (let i = 0; i < COLS; i++) {
      const t = i / (COLS - 1);
      out[i] = clamp(
        Math.round(Math.exp(lnMin + t * (lnMax - lnMin))),
        minBin,
        maxBin
      );
    }
    return out;
  }, []);

  // Per-column independent oscillator parameters for the no-music
  // fallback. Time-only sin() argument means columns pulse vertically
  // and never form a horizontal traveling wave.
  const oscillators = useMemo(() => {
    const out = new Array<{ freq: number; phase: number; amp: number }>(COLS);
    let s = 0xbeef;
    const rand = (): number => {
      s = (s * 9301 + 49297) % 233280;
      return s / 233280;
    };
    for (let i = 0; i < COLS; i++) {
      out[i] = {
        freq: 0.2 + rand() * 0.4, // Hz
        phase: rand() * Math.PI * 2,
        amp: 0.06 + rand() * 0.12,
      };
    }
    return out;
  }, []);

  useEffect(() => {
    if (!motionOn) {
      heightsRef.current.fill(0.32);
      setFrame((f) => (f + 1) % 1024);
      return;
    }
    let raf = 0;
    const startTs = performance.now();
    const tick = (): void => {
      const heights = heightsRef.current;
      const analyser = getAnalyser();
      if (analyser && playing) {
        analyser.getByteFrequencyData(freqRef.current);
        const f = freqRef.current;
        for (let i = 0; i < COLS; i++) {
          const raw = f[binMap[i]!]! / 255;
          // Power curve gives a perceptual-loudness look: doubles the
          // visual response of quiet content without blowing up loud
          // content like sqrt did.
          const target = Math.pow(raw, 0.7);
          const cur = heights[i]!;
          // Peak-hold + slow decay: if the spectrum spike came in,
          // snap up fast (one-pole low-pass at ATTACK); else tail
          // drops a fixed fraction per frame. Matches what real
          // visualizers do.
          if (target > cur) {
            heights[i] = cur + (target - cur) * ATTACK;
          } else {
            heights[i] = Math.max(target, cur * DECAY);
          }
        }
      } else {
        // No-music fallback. Per-column independent oscillator. Same
        // float smoothing path so transitions in/out of music feel
        // continuous.
        const tSec = (performance.now() - startTs) / 1000;
        for (let i = 0; i < COLS; i++) {
          const o = oscillators[i]!;
          const wave = Math.sin(tSec * o.freq * Math.PI * 2 + o.phase);
          const target = clamp(0.28 + o.amp * wave, FLOOR, 1);
          const cur = heights[i]!;
          // Symmetric mild lerp — fallback should breathe, not pulse.
          heights[i] = cur + (target - cur) * 0.04;
        }
      }
      setFrame((f) => (f + 1) % 1024);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [motionOn, playing, getAnalyser, binMap, oscillators]);

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
          {/* Pixel grid overlay — preserves the block-aesthetic
              without forcing the bars to snap to integer cells. */}
          <pattern
            id="mc-grid"
            width={BAR_WIDTH}
            height={BAR_WIDTH}
            patternUnits="userSpaceOnUse"
          >
            <path
              d={`M ${BAR_WIDTH} 0 L 0 0 0 ${BAR_WIDTH}`}
              fill="none"
              stroke="rgb(var(--accent))"
              strokeOpacity="0.3"
              strokeWidth="0.5"
            />
          </pattern>
          {/* Vertical accent gradient — bottom darker, top brighter
              so each bar reads "lit from above". */}
          <linearGradient id="mc-bar-grad" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="rgb(var(--accent))" stopOpacity="1" />
            <stop offset="100%" stopColor="rgb(var(--accent))" stopOpacity="0.55" />
          </linearGradient>
        </defs>

        {Array.from({ length: COLS }).map((_, i) => {
          const level = heightsRef.current[i] ?? 0;
          const heightPx = Math.max(level, FLOOR) * TOTAL_H;
          const y = TOTAL_H - heightPx;
          return (
            <rect
              key={i}
              x={i * BAR_WIDTH}
              y={y}
              width={BAR_WIDTH}
              height={heightPx}
              fill="url(#mc-bar-grad)"
            />
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

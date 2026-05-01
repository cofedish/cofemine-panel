"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMotionEnabled } from "@/lib/motion-pref";
import { useBackdropBeat } from "@/lib/backdrop-beat";

/**
 * Music-reactive visualiser backdrop.
 *
 * Final design after a few iterations:
 *
 * - 80 distinct bars across the row with a visible gap between each
 *   one, so individual columns read clearly instead of merging into a
 *   solid mass like the previous 160-zero-gap revision.
 * - Heights snap to integer cells (each column's top is always
 *   perfectly aligned with one grid cell) and a one-block "grass" cap
 *   sits on top, fully inside its cell. The constraint only applies
 *   to the rendered height — the underlying smoothed value is a float
 *   so peaks rise quickly through several cells per frame, but they
 *   land on whole-cell boundaries.
 * - Per-column peak-hold + exponential decay smoothing in float
 *   space:
 *     attack: lerp toward target at ATTACK each frame  (one-pole LP)
 *     decay : current *= DECAY                          (slow tail)
 *   ATTACK chosen so peaks reach ~95% in 3-4 frames (~60ms — fast,
 *   but the rise is visible). DECAY drops a peak by half over ~12
 *   frames (~200ms) — the classic "peak meter" tail.
 * - When music is off, each column has its own independent sine
 *   oscillator (time-only argument — no horizontal traveling wave),
 *   so the row breathes column-by-column.
 */

const COLS = 80;
const BLOCK = 10; // viewBox px per cell (vertical AND horizontal)
const BAR_WIDTH = 5; // 50/50 bar/gap — visually distinct columns
const BAR_INSET = (BLOCK - BAR_WIDTH) / 2;
const MAX_HEIGHT = 24; // in cells
const TOTAL_W = COLS * BLOCK; // 800
const TOTAL_H = MAX_HEIGHT * BLOCK; // 240

// Frequency band edges (Hz). 60 Hz floor cuts subsonic rumble, 6 kHz
// ceiling matches where C418 / chiptune / synth content actually ends.
// Each column spans one slice of an octave-equal log subdivision.
const MIN_HZ = 60;
const MAX_HZ = 6000;

// dB normalisation window. Float frequency data from the analyser is
// in dBFS — typically -100 (silence) to 0 (full scale).
//
// Window is intentionally narrow ([-65..-20]) and the power curve is
// steep (1.8). The previous wider window + 1.3 power had quiet ambient
// content sitting at 4-5 cells and peaks at 7-8 cells — a 2× range,
// not enough contrast. WE-style references have ~10× range: most
// bars at the floor (1 cell or invisible), occasional peaks reaching
// the top of the viewport. Tighter window pushes mid signals up and
// the steep curve crushes everything below mid into the noise.
const MIN_DB = -65;
const MAX_DB = -20;
const NOISE_FLOOR_DB = -60;
const POWER = 1.8;

// Float-space peak-hold smoothing.
const ATTACK = 0.6; // one-pole low-pass on rise (~3-4 frames to peak)
// Slower than before (was 0.9). Tail halves in ~17 frames (~280 ms),
// bars actually HOLD their height for a moment before stepping down
// instead of collapsing every frame. WE-style sustain.
const DECAY = 0.96;
// Hysteresis on the integer cell rounding. Without it, a float that
// hovers near 5.5 oscillates rounded value between 5 and 6 each
// frame, which reads as the column "shaking". With a 0.6-cell
// deadband, the displayed integer only steps once the float has
// moved meaningfully past its current level.
const HYSTERESIS = 0.6;

export function MinecraftBackdrop(): JSX.Element {
  const motionOn = useMotionEnabled();
  const { getAnalyser, playing } = useBackdropBeat();
  // Smoothed per-column levels in [0..1] — float so peaks lerp
  // smoothly. The integer cell count is derived at render time via a
  // hysteresis pass — see `displayedRef`.
  const levelsRef = useRef<Float32Array>(new Float32Array(COLS));
  // Integer cell counts actually shown on screen. Tracked separately
  // from the smoothed float so we can apply hysteresis: the displayed
  // integer only steps when the float has crossed a deadband around
  // it. Stops the half-cell jitter the float-then-round path produced.
  const displayedRef = useRef<Int8Array>(new Int8Array(COLS));
  // Reusable Float32 buffer for getFloatFrequencyData. Sized for
  // fftSize=2048 → 1024 bins. Float data is dBFS, much better
  // dynamic range than the byte version. Using `new ArrayBuffer(...)`
  // keeps the underlying buffer typed as `ArrayBuffer` (not
  // `ArrayBufferLike`) so newer DOM lib types accept it as the
  // parameter to `getFloatFrequencyData`.
  const freqRef = useRef<Float32Array<ArrayBuffer>>(
    new Float32Array(new ArrayBuffer(1024 * 4))
  );
  const [, setFrame] = useState(0);

  // Per-column FFT bin RANGE (start..end). Each visualiser column
  // covers one slice of a log/octave-equal frequency band, and the
  // signal it shows is the PEAK dB across the bins it covers — that
  // way each column has its own slice of the spectrum, no two
  // columns ever land on the same bin (which is what was making
  // adjacent columns rise together in the previous revision).
  const binRanges = useRef<Array<[number, number]> | null>(null);
  // Cache the last sample rate we built ranges for; rebuild if the
  // AudioContext switches (rare, but cheap).
  const lastSampleRateRef = useRef(0);

  function ensureBinRanges(sampleRate: number, binCount: number): void {
    if (
      binRanges.current &&
      lastSampleRateRef.current === sampleRate
    ) {
      return;
    }
    const hzPerBin = sampleRate / (binCount * 2);
    const lnMin = Math.log(MIN_HZ);
    const lnMax = Math.log(MAX_HZ);
    const ranges: Array<[number, number]> = [];
    let prevEdgeHz = MIN_HZ;
    for (let i = 0; i < COLS; i++) {
      const tNext = (i + 1) / COLS;
      const nextEdgeHz = Math.exp(lnMin + tNext * (lnMax - lnMin));
      const startBin = clamp(
        Math.floor(prevEdgeHz / hzPerBin),
        1,
        binCount - 1
      );
      const endBin = clamp(
        Math.max(startBin + 1, Math.ceil(nextEdgeHz / hzPerBin)),
        startBin + 1,
        binCount
      );
      ranges.push([startBin, endBin]);
      prevEdgeHz = nextEdgeHz;
    }
    binRanges.current = ranges;
    lastSampleRateRef.current = sampleRate;
  }

  // Per-column independent oscillator parameters for the no-music
  // fallback. Time-only sin() argument — never `i` — so columns pulse
  // vertically and never form a horizontal traveling wave.
  const oscillators = useMemo(() => {
    const out = new Array<{ freq: number; phase: number; amp: number }>(COLS);
    let s = 0xbeef;
    const rand = (): number => {
      s = (s * 9301 + 49297) % 233280;
      return s / 233280;
    };
    for (let i = 0; i < COLS; i++) {
      out[i] = {
        freq: 0.18 + rand() * 0.4, // Hz
        phase: rand() * Math.PI * 2,
        amp: 0.05 + rand() * 0.1,
      };
    }
    return out;
  }, []);

  useEffect(() => {
    if (!motionOn) {
      levelsRef.current.fill(0);
      setFrame((f) => (f + 1) % 1024);
      return;
    }
    let raf = 0;
    const startTs = performance.now();
    const tick = (): void => {
      const lv = levelsRef.current;
      const analyser = getAnalyser();
      if (analyser && playing) {
        const binCount = analyser.frequencyBinCount;
        ensureBinRanges(analyser.context.sampleRate, binCount);
        const ranges = binRanges.current!;
        // Resize freq buffer if fftSize ever changes under us.
        if (freqRef.current.length !== binCount) {
          freqRef.current = new Float32Array(new ArrayBuffer(binCount * 4));
        }
        analyser.getFloatFrequencyData(freqRef.current);
        const f = freqRef.current;
        for (let i = 0; i < COLS; i++) {
          const [start, end] = ranges[i]!;
          // Per-band PEAK in dB. Peak (not average) keeps single-bin
          // transients punchy — averaging would smear a kick across
          // its band and lose the snap.
          let peakDb = -Infinity;
          for (let b = start; b < end; b++) {
            const v = f[b]!;
            if (v > peakDb) peakDb = v;
          }
          // Hard noise floor: anything below this band's threshold
          // becomes 0. That kills the "everything sits at the same
          // baseline" plateau the user complained about.
          if (peakDb < NOISE_FLOOR_DB) {
            lv[i] = lv[i]! * DECAY;
            continue;
          }
          // Normalise into [0..1] across the meaningful dB window.
          let target = (peakDb - MIN_DB) / (MAX_DB - MIN_DB);
          if (target < 0) target = 0;
          else if (target > 1) target = 1;
          // Power curve squashes small signals further so they don't
          // pile up at the same baseline height. With POWER=1.8 a
          // mid-quiet signal at norm=0.4 collapses to 0.18 (~4 cells)
          // while a near-peak at norm=0.9 stays at 0.83 (~20 cells)
          // — that 5× spread is what gives the visualiser the
          // "mostly flat with a few sharp peaks" look.
          target = Math.pow(target, POWER);
          const cur = lv[i]!;
          if (target > cur) {
            lv[i] = cur + (target - cur) * ATTACK;
          } else {
            lv[i] = Math.max(target, cur * DECAY);
          }
        }
      } else {
        // No-music fallback. Per-column independent oscillator.
        const tSec = (performance.now() - startTs) / 1000;
        for (let i = 0; i < COLS; i++) {
          const o = oscillators[i]!;
          const wave = Math.sin(tSec * o.freq * Math.PI * 2 + o.phase);
          const target = clamp(0.18 + o.amp * wave, 0, 1);
          const cur = lv[i]!;
          lv[i] = cur + (target - cur) * 0.05;
        }
      }
      // Hysteresis pass: convert each smoothed float level into an
      // integer cell count, but only step the displayed integer when
      // the float has crossed past its deadband. This is what kills
      // the "vibrating" look — without it, a float oscillating in
      // [5.45, 5.55] would flicker render between 5 and 6 each frame.
      const disp = displayedRef.current;
      for (let i = 0; i < COLS; i++) {
        const blocksFloat = lv[i]! * MAX_HEIGHT;
        const cur = disp[i]!;
        if (blocksFloat - cur > HYSTERESIS) {
          // Float has moved meaningfully above current — snap to the
          // new integer floor.
          disp[i] = Math.min(MAX_HEIGHT, Math.floor(blocksFloat));
        } else if (cur - blocksFloat > HYSTERESIS) {
          disp[i] = Math.max(0, Math.ceil(blocksFloat));
        }
        // else: stay at current integer (within deadband — no flicker).
      }
      setFrame((f) => (f + 1) % 1024);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [motionOn, playing, getAnalyser, oscillators]);

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 bottom-0 z-0 select-none opacity-[0.20] dark:opacity-[0.24]"
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
          {/* Faint pixel grid — keeps the block aesthetic. Drawn at
              cell resolution so the block grid the eye sees matches
              the resolution the bars snap to. */}
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
              strokeOpacity="0.25"
              strokeWidth="0.5"
            />
          </pattern>
        </defs>

        {Array.from({ length: COLS }).map((_, i) => {
          // Heights come from displayedRef — already integer cells +
          // hysteresis applied in the rAF tick. The grass cap is
          // therefore always fully aligned with one grid cell, and
          // float wobble around half-cell boundaries can no longer
          // make the bar flicker between two values.
          const blocks = displayedRef.current[i] ?? 0;
          if (blocks <= 0) return null;
          const heightPx = blocks * BLOCK;
          const y = TOTAL_H - heightPx;
          const x = i * BLOCK + BAR_INSET;
          return (
            <g key={i}>
              {/* Column body — solid accent at 60% alpha, the "dirt". */}
              <rect
                x={x}
                y={y}
                width={BAR_WIDTH}
                height={heightPx}
                fill="rgb(var(--accent))"
                opacity="0.6"
              />
              {/* Grass cap — full-strength accent, exactly one cell
                  tall, snapped to the bar's current top edge. */}
              <rect
                x={x}
                y={y}
                width={BAR_WIDTH}
                height={BLOCK}
                fill="rgb(var(--accent))"
              />
            </g>
          );
        })}

        {/* Grid overlay sits on top so cell seams are visible across
            both the bars and the empty viewBox above them. */}
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

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
 *     covers a roughly equal-width band of perceptual frequencies
 *     (otherwise a linear mapping crowds all the audible content into
 *     the leftmost few columns and the rest stay flat).
 *   - Boost low-amplitude signals via a sqrt curve so quiet ambient
 *     tracks like "Sweden" still drive visible motion.
 *   - Apply a peak-meter style attack/release to the per-column level
 *     so peaks pop fast and tails decay slow — that's what makes a
 *     visualiser look alive instead of janky.
 *
 * When music is paused or unavailable:
 *   - Drive a procedural "calm waves" fallback so the panel still has
 *     gentle motion. Slow phase, low amplitude, no spikes.
 *
 * Geometry:
 *   - BLOCK is now small (6px in the viewBox) so each column is a thin
 *     strip — the eye reads a smooth curve, but the grid overlay still
 *     keeps the pixel-block feel. The "grass" slab on top is kept as a
 *     brighter band one block tall, snapped to the column's top.
 *
 * Sits behind everything (fixed, z-0, pointer-events: none).
 */

const COLS = 160;
const BLOCK = 6;
const MAX_HEIGHT = 36; // in blocks → 216px viewBox tall
const TOTAL_W = COLS * BLOCK;
const TOTAL_H = MAX_HEIGHT * BLOCK;

// Attack/release smoothing (per-column persistent levels). Numbers
// chosen by feel — peaks rise to ~80% of target in ~3 frames, decay
// over ~12 frames so the room "breathes" between bass hits.
const ATTACK = 0.45;
const RELEASE = 0.08;
// Always keep at least this fraction of the column visible so quiet
// tracks aren't silent flatlines.
const FLOOR = 0.05;

export function MinecraftBackdrop(): JSX.Element {
  const motionOn = useMotionEnabled();
  const { getAnalyser, playing } = useBackdropBeat();
  // Per-column levels (0..1). Persistent across frames for the
  // smoothing pass. Mutated in place inside the rAF loop.
  const levelsRef = useRef<Float32Array>(new Float32Array(COLS));
  // Reusable buffer for getByteFrequencyData. fftSize=512 → 256 bins.
  // Using `new ArrayBuffer(...)` keeps the byte buffer typed as
  // `ArrayBuffer` (not `ArrayBufferLike`) so newer DOM lib types
  // accept it as the parameter to `getByteFrequencyData`.
  const freqRef = useRef<Uint8Array<ArrayBuffer>>(
    new Uint8Array(new ArrayBuffer(256))
  );
  // Bumped each frame so React re-renders the SVG; the rect attrs
  // read from levelsRef.current at render time.
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
      // Static silhouette — clear levels.
      levelsRef.current.fill(0.4);
      setFrame((f) => (f + 1) % 1024);
      return;
    }
    let raf = 0;
    let phase = 0;
    const tick = (): void => {
      const lv = levelsRef.current;
      const analyser = getAnalyser();
      if (analyser && playing) {
        analyser.getByteFrequencyData(freqRef.current);
        const f = freqRef.current;
        for (let i = 0; i < COLS; i++) {
          const raw = f[binMap[i]!]! / 255;
          // Expand small signals — sqrt is a good fit for perceptual
          // loudness without going over the top like log does.
          const target = Math.max(FLOOR, Math.sqrt(raw));
          const cur = lv[i]!;
          lv[i] =
            target > cur
              ? cur + (target - cur) * ATTACK
              : cur + (target - cur) * RELEASE;
        }
      } else {
        // Procedural fallback. Two sine layers in slow drift give a
        // calm-water silhouette that doesn't compete for attention.
        phase += 0.012;
        for (let i = 0; i < COLS; i++) {
          const target =
            0.32 +
            0.18 * Math.sin(i * 0.16 + phase) +
            0.08 * Math.sin(i * 0.43 + phase * 1.7);
          const cur = lv[i]!;
          // Gentler smoothing — no need for fast attack when there's
          // nothing percussive to react to.
          lv[i] = cur + (target - cur) * 0.06;
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
          const level = levelsRef.current[i] ?? 0;
          const heightPx = level * TOTAL_H;
          const y = TOTAL_H - heightPx;
          return (
            <g key={i}>
              {/* Column body — the gradient gives it depth without a
                  separate "dirt" rect. */}
              <rect
                x={i * BLOCK}
                y={y}
                width={BLOCK}
                height={heightPx}
                fill="url(#mc-col-grad)"
              />
              {/* Bright "grass" strip exactly one block tall, snapped
                  to the column's current top. Same width as the column,
                  so the square-block silhouette is preserved. */}
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

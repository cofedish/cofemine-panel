"use client";

import { useEffect, useMemo, useRef } from "react";
import AudioMotionAnalyzer from "audiomotion-analyzer";
import { useMotionEnabled } from "@/lib/motion-pref";
import { useBackdropBeat } from "@/lib/backdrop-beat";

/**
 * Layered Minecraft-y backdrop:
 *
 *   1. Static SVG silhouette at the very back. Seeded jagged
 *      block-columns with a brighter "grass" cap on each — always
 *      visible, even with music off, so the panel never looks empty.
 *      This is what the user keeps asking us to "bring back".
 *   2. audiomotion-analyzer canvas on top. Renders dense, narrow,
 *      solid bars when music is playing; transparent when silent
 *      (lets the static silhouette show through).
 *   3. Pixel-grid overlay on top of both, so the whole bottom band
 *      reads as a tiled Minecraft block field.
 *
 * Heights and column count are tuned to be dense enough to fill the
 * entire width without obvious gaps, while audioMotion is set to its
 * highest density (1/24 octave bands across a wide frequency range)
 * so the bars also span edge-to-edge.
 */

const GRADIENT_NAME = "cofemine";

// Static-skyline params. 120 columns at BLOCK=8 gives a dense
// silhouette that fills the row edge-to-edge without gaps.
const SKY_COLS = 120;
const SKY_BLOCK = 8;
const SKY_MAX = 28; // in cells
const SKY_W = SKY_COLS * SKY_BLOCK; // 960
const SKY_H = SKY_MAX * SKY_BLOCK; // 224
const SKY_SEED = 1337;

function seededSkylineHeights(): number[] {
  const out: number[] = [];
  let s = SKY_SEED;
  for (let i = 0; i < SKY_COLS; i++) {
    s = (s * 9301 + 49297) % 233280;
    const r = s / 233280;
    const base = 0.55 + 0.45 * Math.sin(i / 4 + r * 1.5);
    const h = Math.floor(base * SKY_MAX);
    out.push(Math.max(2, Math.min(SKY_MAX, h)));
  }
  return out;
}

export function MinecraftBackdrop(): JSX.Element {
  const motionOn = useMotionEnabled();
  const { getAudioElement } = useBackdropBeat();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const amRef = useRef<AudioMotionAnalyzer | null>(null);
  const skylineHeights = useMemo(seededSkylineHeights, []);

  useEffect(() => {
    if (!motionOn) return;
    const container = containerRef.current;
    if (!container) return;
    const audio = getAudioElement();
    let am: AudioMotionAnalyzer | null = null;
    try {
      am = new AudioMotionAnalyzer(container, {
        source: audio,
        // Mode 8 = 1/24 octave bands. Combined with a wide frequency
        // range that's ~9 octaves × 24 ≈ 200 bars — dense enough that
        // edge-to-edge the row reads as a tightly-packed equaliser.
        mode: 8,
        ledBars: false, // SOLID single-column bars
        showScaleX: false,
        showScaleY: false,
        showPeaks: true,
        showBgColor: false,
        bgAlpha: 0,
        overlay: true,
        radial: false,
        reflexRatio: 0,
        mirror: 0,
        weightingFilter: "D",
        smoothing: 0.7,
        minDecibels: -85,
        maxDecibels: -25,
        // Wider range than before (was 60-6000 Hz) so we get more
        // distinct bars across the row — content thins out above
        // ~6 kHz but the bars are still drawn, dense.
        minFreq: 30,
        maxFreq: 16000,
        peakLine: false,
        channelLayout: "single",
        // Sharp solid columns. Smaller barSpace because density is
        // already higher — too much spacing makes individual bars
        // disappear.
        barSpace: 0.3,
        roundBars: false,
        outlineBars: false,
        alphaBars: false,
        fillAlpha: 1,
        lineWidth: 0,
        loRes: false,
        colorMode: "gradient",
      });
      applyGradient(am);
      amRef.current = am;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[backdrop] audiomotion init failed:", err);
    }
    return () => {
      try {
        am?.destroy();
      } catch {
        /* best-effort */
      }
      amRef.current = null;
    };
  }, [motionOn, getAudioElement]);

  // Re-apply gradient on accent change.
  useEffect(() => {
    let lastAccent = readAccentRgb();
    const observer = new MutationObserver(() => {
      const cur = readAccentRgb();
      if (cur === lastAccent) return;
      lastAccent = cur;
      const am = amRef.current;
      if (am) applyGradient(am);
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme"],
    });
    return () => observer.disconnect();
  }, []);

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
      {/* Static seeded skyline — always visible. Fills the entire
          row with grass-capped block columns so the panel always has
          its Minecraft silhouette, even with music off. */}
      <svg
        className="absolute inset-0 w-full h-full"
        viewBox={`0 0 ${SKY_W} ${SKY_H}`}
        preserveAspectRatio="xMidYMax slice"
      >
        <defs>
          {/* Pixel-grid overlay — restores the cell aesthetic. */}
          <pattern
            id="mc-grid"
            width={SKY_BLOCK}
            height={SKY_BLOCK}
            patternUnits="userSpaceOnUse"
          >
            <path
              d={`M ${SKY_BLOCK} 0 L 0 0 0 ${SKY_BLOCK}`}
              fill="none"
              stroke="rgb(var(--accent))"
              strokeOpacity="0.32"
              strokeWidth="0.5"
            />
          </pattern>
        </defs>
        {skylineHeights.map((h, i) => {
          const heightPx = h * SKY_BLOCK;
          const y = SKY_H - heightPx;
          return (
            <g key={i}>
              {/* Dirt body */}
              <rect
                x={i * SKY_BLOCK}
                y={y}
                width={SKY_BLOCK}
                height={heightPx}
                fill="rgb(var(--accent))"
                opacity="0.55"
              />
              {/* Grass cap — exactly one cell tall, fully aligned
                  with one grid cell. */}
              <rect
                x={i * SKY_BLOCK}
                y={y}
                width={SKY_BLOCK}
                height={SKY_BLOCK}
                fill="rgb(var(--accent))"
              />
            </g>
          );
        })}
        {/* Grid overlay sits on top of the skyline, so cell seams
            cross the columns and the empty viewBox above. */}
        <rect
          x={0}
          y={0}
          width={SKY_W}
          height={SKY_H}
          fill="url(#mc-grid)"
        />
      </svg>

      {/* audioMotion canvas — overlays the skyline. Transparent
          when silent (skyline shows through), reactive bars on top
          when music plays. */}
      <div
        ref={containerRef}
        className="absolute inset-0"
        style={{ mixBlendMode: "screen" }}
      />
    </div>
  );
}

function readAccentRgb(): string {
  if (typeof window === "undefined") return "5 150 105";
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue("--accent")
    .trim();
  return v || "5 150 105";
}

function applyGradient(am: AudioMotionAnalyzer): void {
  const accent = readAccentRgb(); // "R G B" space-separated
  // Modern `rgb(R G B / a)` syntax — accepts the space-separated
  // bytes straight from the CSS variable, so accent swaps in
  // Settings flow through without string surgery.
  const c = (a: number): string => `rgb(${accent} / ${a})`;
  am.registerGradient(GRADIENT_NAME, {
    bgColor: "transparent",
    colorStops: [
      { pos: 0, color: c(1) },
      { pos: 0.06, color: c(1) },
      { pos: 0.07, color: c(0.7) },
      { pos: 0.95, color: c(0.6) },
      { pos: 1, color: c(0.45) },
    ],
  });
  am.gradient = GRADIENT_NAME;
}

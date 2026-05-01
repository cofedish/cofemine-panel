"use client";

import { useEffect, useRef } from "react";
import AudioMotionAnalyzer from "audiomotion-analyzer";
import { useMotionEnabled } from "@/lib/motion-pref";
import { useBackdropBeat } from "@/lib/backdrop-beat";

/**
 * Decorative music-reactive backdrop powered by `audiomotion-analyzer`.
 *
 * After several rounds of hand-rolling FFT bin mapping, peak-hold,
 * hysteresis and decay logic — and getting it visibly wrong every time
 * — we hand the whole thing off to a battle-tested library. audioMotion
 * is the analyser behind the audioMotion player; ~5k stars on GitHub,
 * ESM, no deps, gives us octave-band bars with a proper LED look out
 * of the box. All the previously-hand-rolled stuff (octave-equal
 * mapping, dB normalisation, attack/release smoothing, peak hold,
 * hysteresis) is now done inside the library, frame-tight and
 * canvas-rendered.
 *
 * What we configure here:
 *   - `mode: 6`           1/12 octave bands → ~80 bars across the row
 *   - `showLeds: true`    Draws each bar as a stack of LED-block
 *                          segments; matches the Minecraft block feel
 *                          we've been chasing the whole time
 *   - `bgAlpha: 0`        Transparent canvas — the panel bg shows
 *                          through above the bars
 *   - custom gradient     Two-stop accent gradient using the active
 *                          theme colour (rgb(var(--accent)))
 *   - `weightingFilter: 'D'`  Perceptual weighting so the bars
 *                              respond like the ear hears
 *   - `smoothing: 0.7`    Pre-FFT time smoothing
 *
 * Sits behind everything (fixed, z-0, pointer-events: none).
 */

const GRADIENT_NAME = "cofemine";

export function MinecraftBackdrop(): JSX.Element {
  const motionOn = useMotionEnabled();
  const { getAudioElement } = useBackdropBeat();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const amRef = useRef<AudioMotionAnalyzer | null>(null);

  useEffect(() => {
    if (!motionOn) return;
    const container = containerRef.current;
    if (!container) return;
    // The audio element is created lazily by the provider; call it
    // here so audioMotion has something to attach a media-element
    // source to. After this, ALL audio routes through audioMotion's
    // internal graph (input → analyser → destination).
    const audio = getAudioElement();
    let am: AudioMotionAnalyzer | null = null;
    try {
      am = new AudioMotionAnalyzer(container, {
        source: audio,
        // Layout — unchanged from the previous revision; user said
        // positions and movement are fine, only visual style needs
        // to match the panel's Minecraft-block aesthetic.
        mode: 6, // 1/12 octave bands → ~80 bars
        ledBars: true,
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
        minFreq: 60,
        maxFreq: 6000,
        peakLine: false,
        channelLayout: "single",
        // Pixel-block styling — this is the bit the user actually
        // wants. Wide gaps between bars + low-res rendering + sharp
        // square corners + opaque fill makes each bar read as a
        // proper stack of Minecraft blocks instead of a thin LED
        // strip. `colorMode: "gradient"` makes each bar's segments
        // pick their colour from the registered gradient stops based
        // on vertical position.
        barSpace: 0.45,
        roundBars: false,
        outlineBars: false,
        alphaBars: false,
        fillAlpha: 1,
        lineWidth: 0,
        loRes: true,
        colorMode: "gradient",
      });

      applyGradient(am);
      amRef.current = am;
    } catch (err) {
      // createMediaElementSource throws "InvalidStateError: Failed
      // to execute 'createMediaElementSource'..." if it's already
      // been called for this element. Shouldn't happen with the
      // refactored provider, but log just in case so it doesn't fail
      // silently.
      // eslint-disable-next-line no-console
      console.error("[backdrop] audiomotion init failed:", err);
    }

    return () => {
      try {
        am?.destroy();
      } catch {
        /* destroy is best-effort */
      }
      amRef.current = null;
    };
  }, [motionOn, getAudioElement]);

  // Re-apply gradient on theme changes (accent CSS variable updates).
  // audioMotion caches gradients, so we overwrite the existing slot.
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const am = amRef.current;
      if (am) applyGradient(am);
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-accent", "data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 bottom-0 z-0 select-none opacity-[0.32] dark:opacity-[0.35]"
      style={{
        height: "clamp(220px, 44vh, 440px)",
        // Fade the top edge into the page background so the canvas
        // doesn't have a hard horizon line.
        WebkitMaskImage:
          "linear-gradient(to top, black 0%, black 35%, transparent 100%)",
        maskImage:
          "linear-gradient(to top, black 0%, black 35%, transparent 100%)",
      }}
    >
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
}

/**
 * Read the active accent colour from the CSS variable as an
 * "r, g, b" string, suitable for embedding in `rgba(${val}, a)`.
 * Falls back to the brand emerald if the var is missing.
 */
function readAccentRgb(): string {
  if (typeof window === "undefined") return "5, 150, 105";
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue("--accent")
    .trim();
  return v || "5, 150, 105";
}

/**
 * Build the Minecraft "grass-on-top, dirt-below" gradient and apply
 * it to the analyser. In audioMotion `pos: 0` is the TOP of each bar
 * and `pos: 1` is the bottom, so:
 *   - top sliver (pos 0..0.06)        : bright accent — the "grass"
 *   - body       (pos 0.07..0.95)     : medium accent — the "dirt"
 *   - bottom     (pos 0.95..1)        : dim accent — shadowed dirt
 *
 * Each bar is rendered as a stack of LED segments; with
 * `colorMode: "gradient"` each segment picks its colour from this
 * palette by its vertical position, so the topmost block of every
 * bar is grass-bright while the stack below it is dirt-dim. Matches
 * the visual language of the rest of the panel.
 */
function applyGradient(am: AudioMotionAnalyzer): void {
  const accent = readAccentRgb();
  am.registerGradient(GRADIENT_NAME, {
    bgColor: "transparent",
    colorStops: [
      // Bright grass band
      { pos: 0, color: `rgba(${accent}, 1)` },
      { pos: 0.06, color: `rgba(${accent}, 1)` },
      // Sharp transition into the dirt body
      { pos: 0.07, color: `rgba(${accent}, 0.7)` },
      // Dirt body — uniform, slightly translucent
      { pos: 0.95, color: `rgba(${accent}, 0.6)` },
      // Faint shadow at the very bottom
      { pos: 1, color: `rgba(${accent}, 0.45)` },
    ],
  });
  am.gradient = GRADIENT_NAME;
}

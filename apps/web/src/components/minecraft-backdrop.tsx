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
        // Visual config
        mode: 6, // 1/12 octave bands → ~80 bars wide
        ledBars: true, // LED-block bars — exactly the Minecraft block feel
        showScaleX: false,
        showScaleY: false,
        showPeaks: true, // small floating peak marker on each bar
        showBgColor: false,
        bgAlpha: 0,
        overlay: true,
        fillAlpha: 0.85,
        lineWidth: 0,
        radial: false,
        reflexRatio: 0,
        mirror: 0,
        // Spectrum analysis tuning
        weightingFilter: "D",
        smoothing: 0.7,
        minDecibels: -85,
        maxDecibels: -25,
        minFreq: 60,
        maxFreq: 6000,
        peakLine: false,
        // Channel layout: single (mono mix) — full row shows the
        // combined L+R signal rather than splitting the screen.
        channelLayout: "single",
      });

      // Custom gradient using the live theme accent colour. We read it
      // from the CSS variable so theme switching can re-apply.
      const accent = readAccentRgb();
      am.registerGradient(GRADIENT_NAME, {
        bgColor: "transparent",
        colorStops: [
          { pos: 0, color: `rgba(${accent}, 0.55)` },
          { pos: 1, color: `rgba(${accent}, 1)` },
        ],
      });
      am.gradient = GRADIENT_NAME;
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

  // Re-register gradient on theme changes (accent CSS variable
  // updates). audioMotion caches gradients, so we overwrite the
  // existing slot.
  useEffect(() => {
    const am = amRef.current;
    if (!am) return;
    const observer = new MutationObserver(() => {
      const accent = readAccentRgb();
      am.registerGradient(GRADIENT_NAME, {
        bgColor: "transparent",
        colorStops: [
          { pos: 0, color: `rgba(${accent}, 0.55)` },
          { pos: 1, color: `rgba(${accent}, 1)` },
        ],
      });
      am.gradient = GRADIENT_NAME;
    });
    // The theme provider toggles a class / data-attr on <html>; watch
    // that so we pick up accent swaps without needing an explicit
    // event channel.
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

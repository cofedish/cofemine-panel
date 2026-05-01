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
        // More bars + thinner. mode 7 = 1/24 octave (≈ 160 bars over
        // our 60Hz–6kHz range). With high barSpace each bar reads as
        // a thin column instead of a fat block.
        mode: 7,
        // SOLID single-column bars — LED segmentation off. The user
        // wants the WE-reference look: each bar is one filled rect
        // top to bottom, not a stack of glowing pixels.
        ledBars: false,
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
        // Sharp solid columns: thick gap between bars, no rounding,
        // no outline, full opacity. `colorMode: "gradient"` paints
        // each whole bar from a single gradient (top of bar = pos 0,
        // bottom of bar = pos 1), so the grass-on-top, dirt-below
        // palette still reads cleanly even without LED segments.
        barSpace: 0.55,
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

  // Re-apply the gradient whenever the theme accent changes. The
  // accent provider toggles `accent-*` classes on <html>; we watch
  // the class attr and re-apply when the resolved CSS variable value
  // differs from what we last set.
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
      className="pointer-events-none fixed inset-x-0 bottom-0 z-0 select-none opacity-[0.4] dark:opacity-[0.5]"
      style={{
        // Skinnier band hugged to the bottom edge so bars feel like a
        // horizon line rather than floating in the middle of the page.
        // Was clamp(220px, 44vh, 440px) — that took up almost half the
        // viewport, and at low FFT levels short bars sat in the top
        // of a too-tall container looking like they floated.
        height: "clamp(160px, 30vh, 320px)",
        // Light top fade only — keeps the canvas reaching the very
        // bottom edge of the viewport so the "horizon" reads cleanly.
        WebkitMaskImage:
          "linear-gradient(to top, black 0%, black 60%, transparent 100%)",
        maskImage:
          "linear-gradient(to top, black 0%, black 60%, transparent 100%)",
      }}
    >
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
}

/**
 * Read the active accent colour from the CSS variable. The panel
 * stores it as space-separated bytes ("5 150 105") for Tailwind's
 * `rgb(var(--accent) / <alpha>)` consumer, so we keep it that way
 * and use the modern space-syntax `rgb(R G B / a)` form below.
 *
 * The OLD code wrapped this in `rgba(${val}, 0.5)` which produced
 * invalid CSS like `rgba(5 150 105, 0.5)`, so the gradient never
 * reflected accent changes — that was the "theme doesn't react" bug.
 */
function readAccentRgb(): string {
  if (typeof window === "undefined") return "5 150 105";
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue("--accent")
    .trim();
  return v || "5 150 105";
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
  const accent = readAccentRgb(); // "R G B" (space-separated)
  // Modern `rgb(R G B / a)` syntax accepts the space-separated bytes
  // straight from the CSS variable, so when the user picks a new
  // accent the new colour flows through without any string surgery.
  const c = (a: number): string => `rgb(${accent} / ${a})`;
  am.registerGradient(GRADIENT_NAME, {
    bgColor: "transparent",
    colorStops: [
      // Bright grass slab — the top sliver of every bar is
      // full-strength accent, mimicking a Minecraft grass block.
      { pos: 0, color: c(1) },
      { pos: 0.06, color: c(1) },
      // Sharp transition into the dirt body — visible step
      // distinguishes the grass cap from the column below.
      { pos: 0.07, color: c(0.7) },
      // Dirt body, slightly translucent.
      { pos: 0.95, color: c(0.6) },
      // Faint shadow at the very bottom.
      { pos: 1, color: c(0.45) },
    ],
  });
  am.gradient = GRADIENT_NAME;
}

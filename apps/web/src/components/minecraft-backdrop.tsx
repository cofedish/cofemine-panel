"use client";

import { motion } from "framer-motion";
import { useMemo } from "react";
import { useMotionEnabled } from "@/lib/motion-pref";

/**
 * Decorative Minecraft-ish backdrop — a blocky pseudo-skyline of squares
 * that rises from the bottom of the viewport with a jagged top and fades
 * into the background. Deterministic (seeded) column heights so the SVG
 * stays identical between SSR and the client hydration pass, and so the
 * user sees the same silhouette across reloads.
 *
 * When motion is enabled the layer also gets:
 *   • a slow horizontal drift on the whole skyline (parallax feel),
 *   • a few semi-transparent "cloud" blocks crossing the upper area,
 *   • a barely-perceptible breathing on the accent glow.
 *
 * Sits behind all content (fixed, z-0, pointer-events: none) and picks
 * up the active theme accent through CSS variables.
 */

const COLS = 80;
const BLOCK = 20; // px in the viewBox
const MAX_HEIGHT = 14; // in blocks
const SEED = 1337;

function seededHeights(): number[] {
  const arr: number[] = [];
  let s = SEED;
  for (let i = 0; i < COLS; i++) {
    s = (s * 9301 + 49297) % 233280;
    const r = s / 233280;
    const base = 0.55 + 0.45 * Math.sin(i / 4 + r * 1.5);
    const bump = Math.floor(base * MAX_HEIGHT);
    arr.push(Math.max(2, Math.min(MAX_HEIGHT, bump)));
  }
  return arr;
}

type Cloud = {
  top: string;
  size: number;
  duration: number;
  delay: number;
  opacity: number;
};

function seededClouds(): Cloud[] {
  // Eight small block-clouds drifting across the upper band of the
  // backdrop. Deterministic so SSR/CSR match.
  const out: Cloud[] = [];
  let s = SEED ^ 0xc10d;
  for (let i = 0; i < 8; i++) {
    s = (s * 9301 + 49297) % 233280;
    const r = s / 233280;
    out.push({
      top: `${6 + Math.floor(r * 60)}%`,
      size: 16 + Math.floor(((s >> 3) % 36)),
      duration: 60 + ((s >> 5) % 40),
      delay: -((s >> 7) % 60),
      opacity: 0.06 + ((s >> 9) % 8) / 100,
    });
  }
  return out;
}

export function MinecraftBackdrop(): JSX.Element {
  const heights = useMemo(seededHeights, []);
  const clouds = useMemo(seededClouds, []);
  const motionOn = useMotionEnabled();
  const totalW = COLS * BLOCK;
  const totalH = MAX_HEIGHT * BLOCK;

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-0 select-none overflow-hidden"
    >
      {/* Drifting accent glow that softly breathes in/out. Sits high in
          the viewport so the page reads as "lit from above" without
          drawing attention. */}
      <motion.span
        className="absolute -top-40 left-1/2 -translate-x-1/2 w-[900px] h-[900px] rounded-full blur-3xl"
        style={{
          background:
            "radial-gradient(circle, rgb(var(--accent) / 0.12) 0%, transparent 60%)",
        }}
        animate={
          motionOn
            ? { scale: [1, 1.06, 1], opacity: [0.7, 1, 0.7] }
            : undefined
        }
        transition={
          motionOn
            ? { duration: 16, repeat: Infinity, ease: "easeInOut" }
            : undefined
        }
      />

      {/* Cloud band — small translucent blocks drifting left→right across
          the upper half of the screen. */}
      {motionOn && (
        <div className="absolute inset-x-0 top-0 h-1/2">
          {clouds.map((c, i) => (
            <motion.span
              key={i}
              className="absolute rounded-[3px] bg-[rgb(var(--accent))] ring-1 ring-[rgb(var(--accent))]/30"
              style={{
                top: c.top,
                width: c.size,
                height: c.size,
                opacity: c.opacity,
              }}
              initial={{ x: "-10vw" }}
              animate={{ x: "110vw" }}
              transition={{
                duration: c.duration,
                delay: c.delay,
                repeat: Infinity,
                ease: "linear",
              }}
            />
          ))}
        </div>
      )}

      {/* Skyline. The whole strip slowly drifts left/right when motion is
          on so the panel feels "alive" without anything actually moving
          on a per-frame basis the user can fixate on. */}
      <motion.div
        className="absolute inset-x-0 bottom-0 opacity-[0.18] dark:opacity-[0.22]"
        style={{
          height: "clamp(220px, 44vh, 440px)",
          WebkitMaskImage:
            "linear-gradient(to top, black 0%, black 35%, transparent 100%)",
          maskImage:
            "linear-gradient(to top, black 0%, black 35%, transparent 100%)",
        }}
        animate={motionOn ? { x: [0, -18, 0, 12, 0] } : undefined}
        transition={
          motionOn
            ? { duration: 60, repeat: Infinity, ease: "easeInOut" }
            : undefined
        }
      >
        <svg
          width="100%"
          height="100%"
          viewBox={`0 0 ${totalW} ${totalH}`}
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
                strokeOpacity="0.35"
                strokeWidth="1"
              />
            </pattern>
          </defs>

          {heights.map((h, i) => {
            const x = i * BLOCK;
            const heightPx = h * BLOCK;
            const y = totalH - heightPx;
            return (
              <g key={i}>
                <rect
                  x={x}
                  y={y}
                  width={BLOCK}
                  height={heightPx}
                  fill="rgb(var(--accent))"
                  opacity="0.55"
                />
                <rect
                  x={x}
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
            width={totalW}
            height={totalH}
            fill="url(#mc-grid)"
          />
        </svg>
      </motion.div>
    </div>
  );
}

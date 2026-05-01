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
 * When motion is enabled the skyline gets two subtle treatments:
 *   • slow horizontal parallax drift on the whole strip,
 *   • per-column vertical "breathing" via CSS keyframes (phase-shifted
 *     by index so the silhouette undulates like wind across grass).
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

export function MinecraftBackdrop(): JSX.Element {
  const heights = useMemo(seededHeights, []);
  const motionOn = useMotionEnabled();
  const totalW = COLS * BLOCK;
  const totalH = MAX_HEIGHT * BLOCK;

  return (
    <motion.div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 bottom-0 z-0 select-none opacity-[0.18] dark:opacity-[0.22]"
      style={{
        height: "clamp(220px, 44vh, 440px)",
        WebkitMaskImage:
          "linear-gradient(to top, black 0%, black 35%, transparent 100%)",
        maskImage:
          "linear-gradient(to top, black 0%, black 35%, transparent 100%)",
      }}
      animate={motionOn ? { x: [0, -16, 0, 12, 0] } : undefined}
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
          {/* Faint 1px pixel grid that makes the skyline read as "blocks"
              rather than one big coloured shape. */}
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
          // Stagger the breathing across columns so the wave reads as
          // motion travelling left → right rather than every block
          // bouncing in unison. Negative delays so the wave is mid-cycle
          // on first paint, not flat.
          const delay = motionOn ? -((i % 14) * 0.5).toFixed(2) : 0;
          return (
            <g
              key={i}
              className={motionOn ? "mc-col" : undefined}
              style={motionOn ? { animationDelay: `${delay}s` } : undefined}
            >
              {/* Body of the column — the "dirt" */}
              <rect
                x={x}
                y={y}
                width={BLOCK}
                height={heightPx}
                fill="rgb(var(--accent))"
                opacity="0.55"
              />
              {/* Brighter top slab — the "grass". One block tall. */}
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

        {/* Grid overlay on top of everything so block seams are visible */}
        <rect
          x={0}
          y={0}
          width={totalW}
          height={totalH}
          fill="url(#mc-grid)"
        />
      </svg>
    </motion.div>
  );
}

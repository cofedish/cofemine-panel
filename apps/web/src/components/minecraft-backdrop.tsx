"use client";

/**
 * Decorative Minecraft-ish backdrop — a blocky pseudo-skyline of squares
 * that rises from the bottom of the viewport with a jagged top and fades
 * into the background. Deterministic (seeded) column heights so the SVG
 * stays identical between SSR and the client hydration pass, and so the
 * user sees the same silhouette across reloads.
 *
 * Sits behind all content (fixed, z-0, pointer-events: none) and picks
 * up the active theme accent through CSS variables.
 */

const COLS = 80;
const BLOCK = 20; // px in the viewBox
const MAX_HEIGHT = 10; // in blocks
const SEED = 1337;

function seededHeights(): number[] {
  const arr: number[] = [];
  let s = SEED;
  for (let i = 0; i < COLS; i++) {
    // LCG — cheap deterministic noise
    s = (s * 9301 + 49297) % 233280;
    const r = s / 233280;
    // Smooth-ish pseudo-noise: mix two frequencies so you don't get a
    // random carpet, you get something that reads as terrain.
    const base = 0.55 + 0.45 * Math.sin(i / 4 + r * 1.5);
    const bump = Math.floor(base * MAX_HEIGHT);
    arr.push(Math.max(2, Math.min(MAX_HEIGHT, bump)));
  }
  return arr;
}

export function MinecraftBackdrop(): JSX.Element {
  const heights = seededHeights();
  const totalW = COLS * BLOCK;
  const totalH = MAX_HEIGHT * BLOCK;

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 bottom-0 z-0 select-none opacity-[0.18] dark:opacity-[0.22]"
      style={{
        height: "clamp(160px, 32vh, 320px)",
        // Soft fade from fully-visible at the bottom to transparent at the top
        // so the skyline dissolves into the page background.
        WebkitMaskImage:
          "linear-gradient(to top, black 0%, black 35%, transparent 100%)",
        maskImage:
          "linear-gradient(to top, black 0%, black 35%, transparent 100%)",
      }}
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
          return (
            <g key={i}>
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
    </div>
  );
}

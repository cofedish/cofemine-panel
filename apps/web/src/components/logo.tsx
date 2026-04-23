/**
 * Cofemine wordmark + block-mug mark. Not literal pixel art; an isometric
 * coffee cup stylised as a Minecraft-ish block. Uses `currentColor` for
 * the cup body and `--accent` tokens for highlights so it recolours with
 * the theme automatically.
 */
export function LogoMark({
  size = 26,
  className,
}: {
  size?: number;
  className?: string;
}): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      {/* cup silhouette (isometric block top) */}
      <path
        d="M6 10l10-5 10 5-10 5L6 10z"
        fill="rgb(var(--accent))"
        opacity="0.9"
      />
      {/* cup body left */}
      <path
        d="M6 10v13l10 5V15L6 10z"
        fill="currentColor"
        opacity="0.85"
      />
      {/* cup body right */}
      <path
        d="M26 10v13l-10 5V15l10-5z"
        fill="currentColor"
      />
      {/* steam */}
      <path
        d="M13 3c0 1.2 1.5 1.2 1.5 2.5M17 2c0 1.2 1.5 1.2 1.5 2.5"
        stroke="rgb(var(--accent))"
        strokeWidth="1.4"
        strokeLinecap="round"
        opacity="0.9"
      />
      {/* highlight square on top */}
      <path
        d="M16 8.5l-4 2 4 2 4-2-4-2z"
        fill="rgb(var(--accent-ink))"
        opacity="0.55"
      />
    </svg>
  );
}

/**
 * CofePanel wordmark in Press Start 2P (pixel font). "Cofe" uses the
 * theme accent; "Panel" uses the ink colour so both halves stay legible
 * on every background. A subtle 2-px offset shadow mimics the chunky
 * drop-shadow used on Minecraft's own title screen.
 */
export function Wordmark({
  className = "",
}: {
  className?: string;
}): JSX.Element {
  return (
    <span
      className={`font-pixel leading-none inline-flex items-baseline gap-[1px] ${className}`}
      style={{
        textShadow: "2px 2px 0 rgb(0 0 0 / 0.35)",
      }}
    >
      <span className="text-[rgb(var(--accent))]">Cofe</span>
      <span className="text-[rgb(var(--ink))]">Panel</span>
    </span>
  );
}

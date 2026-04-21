/**
 * Symbolic brand marks. These are simplified re-drawings in the spirit of
 * the official logos — recognisable but not pixel-identical. Use
 * `currentColor` so they tint with the parent text colour.
 */
type IconProps = { size?: number; className?: string };

export function ModrinthMark({
  size = 20,
  className,
}: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M3 12a9 9 0 1 0 18 0 9 9 0 0 0-18 0z" />
      <path d="M3.5 14c1-4 4-6.5 8-6.5 2.4 0 4.3 1.2 5.3 3" />
      <path d="M8 10.5l2.5 2.5" />
      <path d="M12 13.5l4-4" />
      <path d="M16 10.5l2 2-3 3-2-2" />
    </svg>
  );
}

export function CurseForgeMark({
  size = 20,
  className,
}: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {/* three stylised claw marks */}
      <path d="M5 4c0 5 3.5 9 7 9" />
      <path d="M10 3c0 5 3.5 9 7 9" />
      <path d="M15 4c0 5 3 9 5 9" />
      {/* flame base */}
      <path d="M4 14c2 2 5 3 8 3s6-1 8-3c-1 4-4 7-8 7s-7-3-8-7z" />
    </svg>
  );
}

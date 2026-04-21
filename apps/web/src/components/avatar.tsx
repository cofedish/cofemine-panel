import { cn } from "@/lib/cn";

/**
 * Avatar that falls back to initials on a branded background when no image
 * is provided. Used in the top-nav, user dropdown, and admin user list.
 */
export function Avatar({
  src,
  name,
  size = 32,
  className,
}: {
  src?: string | null;
  name?: string | null;
  size?: number;
  className?: string;
}): JSX.Element {
  const initials = (name ?? "··")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0])
    .join("")
    .toUpperCase()
    .padEnd(2, "·")
    .slice(0, 2);

  const style: React.CSSProperties = {
    width: size,
    height: size,
    fontSize: Math.max(10, size * 0.38),
  };

  if (src) {
    return (
      <span
        className={cn(
          "inline-block rounded-full overflow-hidden bg-surface-2",
          className
        )}
        style={style}
        aria-label={name ?? "Avatar"}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt=""
          className="w-full h-full object-cover"
          draggable={false}
        />
      </span>
    );
  }

  return (
    <span
      className={cn(
        "inline-grid place-items-center rounded-full bg-[rgb(var(--accent))] text-[rgb(var(--accent-ink))] font-semibold select-none",
        className
      )}
      style={style}
      aria-label={name ?? "Avatar"}
    >
      {initials}
    </span>
  );
}

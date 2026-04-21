import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Compact metric card used on Dashboard and other landing areas.
 * Accent tint is subtle — no loud gradients, keeps it classic.
 */
export function StatCard({
  icon,
  label,
  value,
  hint,
  tone = "neutral",
  className,
}: {
  icon?: ReactNode;
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "neutral" | "accent" | "success" | "warning" | "danger";
  className?: string;
}): JSX.Element {
  const iconBg: Record<string, string> = {
    neutral: "bg-surface-2 text-ink-secondary",
    accent: "bg-[rgb(var(--accent-soft))] text-[rgb(var(--accent))]",
    success: "bg-[rgb(var(--success-soft))] text-[rgb(var(--success))]",
    warning: "bg-[rgb(var(--warning-soft))] text-[rgb(var(--warning))]",
    danger: "bg-[rgb(var(--danger-soft))] text-[rgb(var(--danger))]",
  };
  return (
    <div className={cn("tile p-5 flex items-center gap-4", className)}>
      {icon && (
        <div
          className={cn(
            "w-11 h-11 rounded-lg grid place-items-center",
            iconBg[tone]
          )}
        >
          {icon}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-[11px] uppercase tracking-wider text-ink-muted">
          {label}
        </div>
        <div className="text-2xl font-semibold tracking-tight mt-0.5 truncate">
          {value}
        </div>
        {hint && (
          <div className="text-xs text-ink-muted mt-0.5 truncate">{hint}</div>
        )}
      </div>
    </div>
  );
}

import { cn } from "@/lib/cn";

const TONE: Record<string, string> = {
  running: "bg-[rgb(var(--success))]",
  starting: "bg-[rgb(var(--warning))]",
  stopping: "bg-[rgb(var(--warning))]",
  stopped: "bg-[rgb(var(--fg-muted))]",
  crashed: "bg-[rgb(var(--danger))]",
  unknown: "bg-[rgb(var(--fg-muted))]",
};

export function StatusDot({
  status,
  className,
  size = 8,
}: {
  status: string;
  className?: string;
  size?: number;
}): JSX.Element {
  const base = TONE[status] ?? TONE.unknown;
  return (
    <span className={cn("relative inline-flex items-center justify-center", className)}>
      {status === "running" && (
        <span
          className={cn("absolute rounded-full opacity-40 animate-ping", base)}
          style={{ width: size, height: size }}
        />
      )}
      <span
        className={cn("relative rounded-full", base)}
        style={{ width: size, height: size }}
      />
    </span>
  );
}

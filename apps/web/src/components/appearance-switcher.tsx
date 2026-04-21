"use client";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Sun, Moon, Monitor, Check } from "lucide-react";
import { ACCENTS, useAccent, type Accent } from "./theme-provider";
import { cn } from "@/lib/cn";

const ACCENT_PREVIEW: Record<Accent, { label: string; hex: string }> = {
  emerald: { label: "Emerald", hex: "#059669" },
  sky: { label: "Sky", hex: "#0EA5E9" },
  violet: { label: "Violet", hex: "#7C3AED" },
  ruby: { label: "Ruby", hex: "#E11D48" },
  lucifer: { label: "Lucifer", hex: "#991B1B" },
  caramel: { label: "Caramel", hex: "#B45309" },
};

/**
 * Full appearance panel — mode (light/dark/system) + accent color.
 * Lives on the Settings page.
 */
export function AppearancePanel(): JSX.Element {
  const { theme, setTheme } = useTheme();
  const { accent, setAccent } = useAccent();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <div className="space-y-6">
      <div>
        <h3 className="font-medium mb-3">Mode</h3>
        <div className="grid grid-cols-3 gap-3 max-w-xl">
          <ModeTile
            active={mounted && theme === "light"}
            onClick={() => setTheme("light")}
            icon={<Sun size={16} />}
            label="Light"
          />
          <ModeTile
            active={mounted && theme === "dark"}
            onClick={() => setTheme("dark")}
            icon={<Moon size={16} />}
            label="Dark"
          />
          <ModeTile
            active={mounted && theme === "system"}
            onClick={() => setTheme("system")}
            icon={<Monitor size={16} />}
            label="System"
          />
        </div>
      </div>

      <div>
        <h3 className="font-medium mb-3">Accent</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 max-w-xl">
          {ACCENTS.map((a) => {
            const preview = ACCENT_PREVIEW[a];
            const isActive = accent === a;
            return (
              <button
                key={a}
                type="button"
                onClick={() => setAccent(a)}
                className={cn(
                  "relative flex items-center gap-3 px-4 py-3 rounded-lg border text-left transition-all",
                  isActive
                    ? "border-[var(--accent-raw)] bg-surface-2"
                    : "border-line hover:border-line-strong hover:bg-surface-2"
                )}
                style={{ ["--accent-raw" as any]: preview.hex }}
              >
                <span
                  className="w-5 h-5 rounded-full ring-2 ring-surface-1 shadow"
                  style={{ background: preview.hex }}
                />
                <span className="text-sm font-medium flex-1">
                  {preview.label}
                </span>
                {isActive && <Check size={14} className="text-accent" />}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ModeTile({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative px-4 py-3 rounded-lg border text-sm font-medium transition-colors",
        active
          ? "border-accent/60 bg-surface-2"
          : "border-line hover:bg-surface-2"
      )}
    >
      {active && (
        <motion.span
          layoutId="mode-active"
          className="absolute inset-0 rounded-lg ring-2 ring-accent/40 pointer-events-none"
          transition={{ type: "spring", duration: 0.35 }}
        />
      )}
      <span className="flex items-center gap-2 relative z-10">
        <span
          className={active ? "text-accent" : "text-ink-secondary"}
        >
          {icon}
        </span>
        {label}
      </span>
    </button>
  );
}

/** Compact toggle for the topbar — just mode. */
export function ThemeToggle(): JSX.Element {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const isDark = mounted && resolvedTheme === "dark";
  return (
    <button
      type="button"
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className="h-9 w-9 grid place-items-center rounded-lg border border-line text-ink-secondary hover:text-ink hover:border-line-strong hover:bg-surface-2 transition-colors"
    >
      {isDark ? <Moon size={16} /> : <Sun size={16} />}
    </button>
  );
}

"use client";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Sun, Moon, Monitor, Check, Music, SkipForward } from "lucide-react";
import { ACCENTS, useAccent, type Accent } from "./theme-provider";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n";
import { useMotionPref, type MotionPref } from "@/lib/motion-pref";
import { useMusicPref, type MusicPref } from "@/lib/music-pref";
import { useBackdropBeat } from "@/lib/backdrop-beat";

const ACCENT_PREVIEW: Record<Accent, { label: string; hex: string }> = {
  emerald: { label: "Emerald", hex: "#059669" },
  sky: { label: "Sky", hex: "#0EA5E9" },
  violet: { label: "Violet", hex: "#7C3AED" },
  ruby: { label: "Ruby", hex: "#E11D48" },
  lucifer: { label: "Lucifer", hex: "#991B1B" },
  caramel: { label: "Caramel", hex: "#B45309" },
  minecraft: { label: "Minecraft", hex: "#65A30D" },
};

/**
 * Full appearance panel — mode (light/dark/system) + accent color.
 * Lives on the Settings page.
 */
export function AppearancePanel(): JSX.Element {
  const { theme, setTheme } = useTheme();
  const { accent, setAccent } = useAccent();
  const { pref: motionPref, setPref: setMotionPref } = useMotionPref();
  const { t } = useT();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <div className="space-y-6">
      <div>
        <h3 className="font-medium mb-3">{t("settings.theme.mode")}</h3>
        <div className="grid grid-cols-3 gap-3 max-w-xl">
          <ModeTile
            active={mounted && theme === "light"}
            onClick={() => setTheme("light")}
            icon={<Sun size={16} />}
            label={t("theme.light")}
          />
          <ModeTile
            active={mounted && theme === "dark"}
            onClick={() => setTheme("dark")}
            icon={<Moon size={16} />}
            label={t("theme.dark")}
          />
          <ModeTile
            active={mounted && theme === "system"}
            onClick={() => setTheme("system")}
            icon={<Monitor size={16} />}
            label={t("theme.system")}
          />
        </div>
      </div>

      <div>
        <h3 className="font-medium mb-3">{t("settings.theme.accent")}</h3>
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
                  className="w-5 h-5 shrink-0 rounded-full ring-2 ring-surface-1 shadow"
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

      <div>
        <h3 className="font-medium mb-1">{t("motion.title")}</h3>
        <p className="text-sm text-ink-muted mb-3 max-w-xl">
          {t("motion.subtitle")}
        </p>
        <div className="grid grid-cols-3 gap-3 max-w-xl">
          {(
            [
              { v: "auto", labelKey: "motion.auto" },
              { v: "on", labelKey: "motion.on" },
              { v: "off", labelKey: "motion.off" },
            ] as const
          ).map(({ v, labelKey }) => (
            <button
              key={v}
              type="button"
              onClick={() => setMotionPref(v as MotionPref)}
              className={cn(
                "relative px-4 py-3 rounded-lg border text-sm font-medium transition-colors",
                motionPref === v
                  ? "border-accent/60 bg-surface-2 text-ink"
                  : "border-line text-ink-secondary hover:bg-surface-2"
              )}
            >
              {t(labelKey)}
            </button>
          ))}
        </div>
      </div>

      <MusicSection />
    </div>
  );
}

function MusicSection(): JSX.Element {
  const { t } = useT();
  const { pref, setPref, volume, setVolume } = useMusicPref();
  const { tracks, current, playing, next } = useBackdropBeat();
  const hasTracks = tracks.length > 0;

  return (
    <div>
      <h3 className="font-medium mb-1">{t("music.title")}</h3>
      <p className="text-sm text-ink-muted mb-3 max-w-xl">
        {t("music.subtitle")}
      </p>
      <div className="grid grid-cols-2 gap-3 max-w-xl">
        {(
          [
            { v: "off", labelKey: "music.off" },
            { v: "on", labelKey: "music.on" },
          ] as const
        ).map(({ v, labelKey }) => (
          <button
            key={v}
            type="button"
            onClick={() => setPref(v as MusicPref)}
            className={cn(
              "relative px-4 py-3 rounded-lg border text-sm font-medium transition-colors",
              pref === v
                ? "border-accent/60 bg-surface-2 text-ink"
                : "border-line text-ink-secondary hover:bg-surface-2"
            )}
          >
            {t(labelKey)}
          </button>
        ))}
      </div>

      {/* Volume + transport row. Disabled when music is off so the user
          isn't fiddling with controls that have no effect. */}
      <div
        className={cn(
          "mt-4 max-w-xl flex items-center gap-3",
          pref !== "on" && "opacity-50 pointer-events-none"
        )}
      >
        <Music size={14} className="text-ink-secondary shrink-0" />
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={volume}
          onChange={(e) => setVolume(Number(e.target.value))}
          className="flex-1 accent-[rgb(var(--accent))]"
          aria-label={t("music.volume")}
        />
        <span className="text-xs text-ink-muted tabular-nums w-9 text-right">
          {Math.round(volume * 100)}%
        </span>
        {hasTracks && (
          <button
            type="button"
            onClick={next}
            className="btn btn-ghost !py-1.5 !px-2"
            aria-label={t("music.next")}
            title={t("music.next")}
          >
            <SkipForward size={14} />
          </button>
        )}
      </div>

      {/* Now-playing / setup hint. */}
      <div className="mt-3 text-xs max-w-xl">
        {!hasTracks ? (
          <p className="text-ink-muted leading-relaxed whitespace-pre-line">
            {t("music.noTracksHint")}
          </p>
        ) : pref === "on" && current ? (
          <p className="text-ink-secondary">
            {playing ? t("music.nowPlaying") : t("music.loading")}{" "}
            <span className="text-ink font-medium">{current.title}</span>{" "}
            <span className="text-ink-muted">· {current.bpm} BPM</span>
          </p>
        ) : (
          <p className="text-ink-muted">
            {t("music.tracksAvailable", { n: tracks.length })}
          </p>
        )}
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

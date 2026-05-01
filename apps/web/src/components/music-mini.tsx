"use client";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Check,
  ChevronDown,
  Music2,
  Pause,
  Play,
  SkipForward,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useBackdropBeat } from "@/lib/backdrop-beat";
import { useMusicPref } from "@/lib/music-pref";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n";

/**
 * Compact music transport for the top nav: play/pause toggle, skip
 * button, current track title, and a popover with track list + volume
 * slider. Hidden when the manifest has no tracks.
 *
 * Click handlers call play() / pause() / next() / selectTrack()
 * directly so the user-gesture activation reaches <audio>.play() —
 * that's how we dodge browser autoplay blocks on prod.
 */
export function MusicMini(): JSX.Element | null {
  const { t } = useT();
  const {
    current,
    currentIndex,
    tracks,
    playing,
    play,
    pause,
    next,
    selectTrack,
    needsGesture,
  } = useBackdropBeat();
  const { pref, setPref, volume, setVolume } = useMusicPref();

  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Close popover on outside click + Escape.
  useEffect(() => {
    if (!open) return;
    function onClickAway(e: MouseEvent): void {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClickAway);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClickAway);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (tracks.length === 0) return null;

  const isOn = pref === "on";
  const showPlayIcon = !playing || !isOn || needsGesture;

  function toggle(): void {
    if (isOn && playing) {
      pause();
      return;
    }
    if (!isOn) setPref("on");
    void play();
  }

  function pickTrack(idx: number): void {
    if (!isOn) setPref("on");
    selectTrack(idx);
    // play() runs from this onClick handler so the gesture chain
    // carries through to <audio>.play(). selectTrack changes the
    // index which triggers the src-update useEffect inside the
    // provider; that effect itself calls play() if pref is "on", so
    // an explicit play() here would be redundant — but harmless.
    void play();
    setOpen(false);
  }

  return (
    <div ref={wrapRef} className="hidden md:flex items-center gap-1.5 mr-1 relative">
      <button
        type="button"
        onClick={toggle}
        className={cn(
          "btn-icon btn-ghost !h-9 !w-9",
          isOn && playing && "text-[rgb(var(--accent))]"
        )}
        aria-label={
          showPlayIcon ? t("music.transport.play") : t("music.transport.pause")
        }
        title={
          showPlayIcon ? t("music.transport.play") : t("music.transport.pause")
        }
      >
        {showPlayIcon ? <Play size={15} /> : <Pause size={15} />}
      </button>
      <button
        type="button"
        onClick={() => next()}
        className="btn-icon btn-ghost !h-9 !w-9"
        aria-label={t("music.next")}
        title={t("music.next")}
      >
        <SkipForward size={15} />
      </button>

      {/* Now-playing trigger — clicking opens the picker popover. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "hidden lg:flex items-center gap-1.5 max-w-[200px] pl-2 pr-1.5 py-1.5 rounded-md text-xs transition-colors",
          open
            ? "bg-surface-2 text-ink"
            : "text-ink-muted hover:bg-surface-2 hover:text-ink"
        )}
        aria-label={t("music.picker.open")}
        title={t("music.picker.open")}
      >
        <Music2 size={12} className="shrink-0" />
        <span className="truncate">
          {isOn && playing
            ? current?.title
            : isOn
              ? t("music.transport.paused")
              : t("music.transport.muted")}
        </span>
        <ChevronDown
          size={12}
          className={cn(
            "shrink-0 transition-transform",
            open && "rotate-180"
          )}
        />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.14, ease: "easeOut" }}
            role="dialog"
            aria-label={t("music.picker.title")}
            className="absolute top-full right-0 mt-2 w-[300px] surface-raised shadow-[var(--shadow-popover)] z-50 overflow-hidden"
          >
            <header className="px-4 pt-3 pb-2 flex items-baseline justify-between border-b border-line">
              <h3 className="text-sm font-medium">{t("music.picker.title")}</h3>
              <span className="text-[10px] text-ink-muted">
                {tracks.length}
              </span>
            </header>

            {/* Track list. Scrollable when long. */}
            <ul className="max-h-[260px] overflow-y-auto py-1">
              {tracks.map((track, idx) => {
                const active = idx === currentIndex;
                return (
                  <li key={track.url}>
                    <button
                      type="button"
                      onClick={() => pickTrack(idx)}
                      className={cn(
                        "w-full flex items-center gap-2 px-4 py-2 text-left text-sm transition-colors",
                        active
                          ? "bg-[rgb(var(--accent-soft))] text-[rgb(var(--accent))]"
                          : "text-ink-secondary hover:bg-surface-2 hover:text-ink"
                      )}
                    >
                      <span
                        className={cn(
                          "w-4 shrink-0",
                          !active && "opacity-0"
                        )}
                      >
                        {active && <Check size={14} />}
                      </span>
                      <span className="flex-1 truncate">{track.title}</span>
                      <span className="text-[10px] text-ink-muted tabular-nums shrink-0">
                        {track.bpm} BPM
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>

            {/* Volume row. */}
            <div className="border-t border-line px-4 py-3 flex items-center gap-3">
              <button
                type="button"
                onClick={() => setVolume(volume > 0 ? 0 : 0.4)}
                className="text-ink-secondary hover:text-ink shrink-0"
                aria-label={
                  volume > 0
                    ? t("music.volume.mute")
                    : t("music.volume.unmute")
                }
                title={
                  volume > 0
                    ? t("music.volume.mute")
                    : t("music.volume.unmute")
                }
              >
                {volume > 0 ? <Volume2 size={14} /> : <VolumeX size={14} />}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.02}
                value={volume}
                onChange={(e) => setVolume(Number(e.target.value))}
                className="flex-1 accent-[rgb(var(--accent))]"
                aria-label={t("music.volume")}
              />
              <span className="text-[10px] text-ink-muted tabular-nums w-8 text-right">
                {Math.round(volume * 100)}%
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

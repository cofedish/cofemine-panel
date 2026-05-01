"use client";
import { Music2, Pause, Play, SkipForward } from "lucide-react";
import { useBackdropBeat } from "@/lib/backdrop-beat";
import { useMusicPref } from "@/lib/music-pref";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n";

/**
 * Compact music transport for the top nav: play/pause toggle, skip
 * button, and the current track title. Hidden when the manifest has
 * no tracks (otherwise there's nothing to control).
 *
 * Click handlers call play() / pause() / next() directly so the
 * user-gesture activation reaches <audio>.play() — that's the same
 * trick the Settings panel uses to dodge browser autoplay blocks.
 */
export function MusicMini(): JSX.Element | null {
  const { t } = useT();
  const { current, tracks, playing, play, pause, next, needsGesture } =
    useBackdropBeat();
  const { pref, setPref } = useMusicPref();

  if (tracks.length === 0) return null;

  const isOn = pref === "on";
  const showPlayIcon = !playing || !isOn || needsGesture;

  function toggle(): void {
    if (isOn && playing) {
      pause();
      // Leave pref as-is so flipping play again resumes without
      // re-engaging the toggle.
      return;
    }
    if (!isOn) setPref("on");
    void play();
  }

  return (
    <div className="hidden md:flex items-center gap-1.5 mr-1">
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
      {/* Now-playing label — hidden on narrow viewports where the
          track title would push the nav over. */}
      <div className="hidden lg:flex items-center gap-1.5 max-w-[180px] pl-1 text-xs text-ink-muted">
        <Music2 size={12} className="shrink-0" />
        <span className="truncate">
          {isOn && playing
            ? current?.title
            : isOn
              ? t("music.transport.paused")
              : t("music.transport.muted")}
        </span>
      </div>
    </div>
  );
}

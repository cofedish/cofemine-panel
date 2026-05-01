"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useMusicPref } from "./music-pref";
import { useMotionEnabled } from "./motion-pref";

/**
 * Beat clock for the decorative backdrop.
 *
 * Two modes:
 *   1. Music on, manifest has tracks → the clock derives BPM from the
 *      currently-playing track (manifest entry) and the playback head
 *      of a hidden HTMLAudioElement. Each call to `useBeat()` returns
 *      a beat counter that increments exactly when audio crosses the
 *      next quarter-note boundary, so visuals are perfectly synced to
 *      the soundtrack.
 *   2. Music off OR no manifest tracks → an internal rAF loop drives
 *      the counter at a fixed fallback BPM (90), so the equalizer
 *      still pulses subtly without sound.
 *
 * Manifest format (loaded from /audio/manifest.json):
 *   {
 *     "tracks": [
 *       { "url": "/audio/sweden.ogg", "title": "Sweden", "bpm": 88 },
 *       …
 *     ]
 *   }
 *
 * No tracks ship with the panel (Mojang owns the soundtracks). Drop
 * your own ogg/mp3 files into apps/web/public/audio/ and list them in
 * manifest.json with their tempo. Tools like https://tunebat.com or
 * `aubiotrack` can extract BPM if you don't know it.
 */

export type Track = {
  url: string;
  title: string;
  bpm: number;
};

type Manifest = { tracks: Track[] };

type Ctx = {
  /** Monotonic beat counter — increments each quarter note. */
  beat: number;
  /** True while audio is actually playing. */
  playing: boolean;
  /** Currently-playing track, or null if nothing loaded. */
  current: Track | null;
  /** All tracks in the manifest. */
  tracks: Track[];
  /** Force-skip to next track. */
  next: () => void;
};

const BeatContext = createContext<Ctx | null>(null);
const FALLBACK_BPM = 90;
const MANIFEST_URL = "/audio/manifest.json";

export function BackdropBeatProvider({
  children,
}: {
  children: React.ReactNode;
}): JSX.Element {
  const { pref, volume } = useMusicPref();
  const motionOn = useMotionEnabled();
  const [tracks, setTracks] = useState<Track[]>([]);
  const [trackIdx, setTrackIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [beat, setBeat] = useState(0);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Last beat number we *emitted* so rAF doesn't double-count.
  const emittedRef = useRef(0);
  // Time origin for the fallback (silent) beat clock.
  const fallbackStartRef = useRef(0);

  // Load manifest once on mount. Failures are silent — the fallback
  // clock still runs, the user just doesn't hear anything.
  useEffect(() => {
    let cancelled = false;
    fetch(MANIFEST_URL, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((m: Manifest | null) => {
        if (cancelled || !m?.tracks) return;
        const valid = m.tracks.filter(
          (t) => t.url && typeof t.bpm === "number" && t.bpm > 0
        );
        setTracks(valid);
      })
      .catch(() => {
        /* no manifest, fallback clock only */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const current = tracks[trackIdx] ?? null;
  const wantPlay = pref === "on" && motionOn && current !== null;

  // Audio element lifecycle. Created lazily on first play to dodge
  // browser autoplay policies (audio.play() must be inside a user
  // gesture; we still attempt it — if blocked the user can re-toggle
  // the pref to retry).
  useEffect(() => {
    const a = audioRef.current ?? new Audio();
    audioRef.current = a;
    a.preload = "auto";
    a.volume = volume;
    a.loop = false;

    if (!current || !wantPlay) {
      a.pause();
      setPlaying(false);
      return;
    }

    if (a.src !== absoluteUrl(current.url)) {
      a.src = current.url;
      a.currentTime = 0;
    }
    const onPlay = (): void => setPlaying(true);
    const onPause = (): void => setPlaying(false);
    const onEnded = (): void => {
      // Advance to the next track in the manifest. Wraps at the end.
      setTrackIdx((i) => (i + 1) % Math.max(1, tracks.length));
    };
    const onError = (): void => {
      setPlaying(false);
      setTrackIdx((i) => (i + 1) % Math.max(1, tracks.length));
    };
    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onPause);
    a.addEventListener("ended", onEnded);
    a.addEventListener("error", onError);

    a.play().catch(() => {
      /* autoplay blocked — settings toggle is a user gesture, so
         flipping On there will succeed even if first mount didn't. */
    });

    return () => {
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onPause);
      a.removeEventListener("ended", onEnded);
      a.removeEventListener("error", onError);
    };
  }, [current, wantPlay, tracks.length, volume]);

  // Volume tracking — separate effect so flipping the slider doesn't
  // re-trigger src reload.
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  // Beat ticker. While audio is playing we sample currentTime each
  // animation frame and emit a beat each time it crosses a quarter-
  // note boundary. While silent, we use a wall-clock fallback at 90
  // BPM so the backdrop still has a pulse for users without music.
  useEffect(() => {
    if (!motionOn) {
      setBeat(0);
      return;
    }
    let raf = 0;
    fallbackStartRef.current = performance.now();
    emittedRef.current = 0;
    setBeat(0);

    const tick = (): void => {
      const a = audioRef.current;
      const useAudio = playing && a && current && a.duration > 0;
      let nextBeat: number;
      if (useAudio) {
        const secsPerBeat = 60 / current.bpm;
        nextBeat = Math.floor(a.currentTime / secsPerBeat);
      } else {
        const elapsed = (performance.now() - fallbackStartRef.current) / 1000;
        const secsPerBeat = 60 / FALLBACK_BPM;
        nextBeat = Math.floor(elapsed / secsPerBeat);
      }
      if (nextBeat !== emittedRef.current) {
        emittedRef.current = nextBeat;
        setBeat(nextBeat);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, current, motionOn]);

  const next = useCallback(() => {
    setTrackIdx((i) => (tracks.length > 0 ? (i + 1) % tracks.length : 0));
  }, [tracks.length]);

  const value = useMemo<Ctx>(
    () => ({ beat, playing, current, tracks, next }),
    [beat, playing, current, tracks, next]
  );

  return <BeatContext.Provider value={value}>{children}</BeatContext.Provider>;
}

export function useBackdropBeat(): Ctx {
  const ctx = useContext(BeatContext);
  if (!ctx) {
    throw new Error(
      "useBackdropBeat must be used inside <BackdropBeatProvider>"
    );
  }
  return ctx;
}

function absoluteUrl(url: string): string {
  if (typeof window === "undefined") return url;
  try {
    return new URL(url, window.location.origin).href;
  } catch {
    return url;
  }
}

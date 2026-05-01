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

/**
 * Music plumbing for the panel.
 *
 * Owns:
 *   • A lazy <audio> element for playback control (play/pause/skip).
 *   • The track list (loaded from /audio/manifest.json).
 *
 * Does NOT own:
 *   • Web Audio context / analyser / source. The visualiser
 *     (`audiomotion-analyzer`) creates its own internal graph from
 *     the audio element we expose, and re-using a media-element
 *     source is fiddly. Letting the visualiser library own that side
 *     is what eventually got us a working pro-grade EQ display
 *     instead of the hand-rolled mess.
 *
 * Autoplay: play() / pause() / next() are exposed as actions and the
 * Settings UI calls them directly inside its onClick so the user
 * gesture activation reaches `audio.play()`. If the browser still
 * blocks (e.g. cold reload with pref already "on"), `needsGesture`
 * flips and a retry button surfaces.
 */

export type Track = {
  url: string;
  title: string;
  bpm: number;
};

type Manifest = { tracks: Track[] };

type Ctx = {
  playing: boolean;
  current: Track | null;
  tracks: Track[];
  needsGesture: boolean;
  play: () => Promise<void>;
  pause: () => void;
  next: () => void;
  /** The HTMLAudioElement, lazily created on first call. The
   *  visualiser uses this as its `source`. */
  getAudioElement: () => HTMLAudioElement;
};

const BeatContext = createContext<Ctx | null>(null);
const MANIFEST_URL = "/audio/manifest.json";

export function BackdropBeatProvider({
  children,
}: {
  children: React.ReactNode;
}): JSX.Element {
  const { pref, volume } = useMusicPref();
  const [tracks, setTracks] = useState<Track[]>([]);
  const [trackIdx, setTrackIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [needsGesture, setNeedsGesture] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);

  const current = tracks[trackIdx] ?? null;

  // Manifest fetch on mount.
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
        /* no manifest — silent */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const getAudioElement = useCallback((): HTMLAudioElement => {
    if (!audioRef.current) {
      const a = new Audio();
      a.preload = "auto";
      // Same-origin /audio/* doesn't require crossOrigin, but setting
      // it here keeps the Web Audio path working if the user ever
      // points the manifest at an external URL.
      a.crossOrigin = "anonymous";
      audioRef.current = a;
    }
    return audioRef.current;
  }, []);

  // Persistent <audio> event listeners. Bound once on mount.
  useEffect(() => {
    const a = getAudioElement();
    const onPlay = (): void => {
      setPlaying(true);
      setNeedsGesture(false);
    };
    const onPause = (): void => setPlaying(false);
    const onEnded = (): void =>
      setTrackIdx((i) =>
        tracks.length > 0 ? (i + 1) % tracks.length : 0
      );
    const onError = (): void => {
      setPlaying(false);
      setTrackIdx((i) =>
        tracks.length > 0 ? (i + 1) % tracks.length : 0
      );
    };
    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onPause);
    a.addEventListener("ended", onEnded);
    a.addEventListener("error", onError);
    return () => {
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onPause);
      a.removeEventListener("ended", onEnded);
      a.removeEventListener("error", onError);
    };
  }, [getAudioElement, tracks.length]);

  // Sync src to current track. Auto-resume if pref is on (handles
  // both first load and auto-advance after `ended`).
  useEffect(() => {
    const a = audioRef.current;
    if (!a || !current) return;
    const targetSrc = absoluteUrl(current.url);
    if (a.src !== targetSrc) {
      a.src = current.url;
      if (pref === "on") {
        void a.play().catch(() => setNeedsGesture(true));
      }
    }
    a.volume = volume;
  }, [current, volume, pref]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  useEffect(() => {
    if (pref === "off") {
      audioRef.current?.pause();
    }
  }, [pref]);

  const play = useCallback(async (): Promise<void> => {
    if (!current) return;
    const a = getAudioElement();
    if (!a.src && current) a.src = current.url;
    try {
      await a.play();
      setNeedsGesture(false);
    } catch {
      setNeedsGesture(true);
    }
  }, [current, getAudioElement]);

  const pause = useCallback((): void => {
    audioRef.current?.pause();
  }, []);

  const next = useCallback((): void => {
    setTrackIdx((i) => (tracks.length > 0 ? (i + 1) % tracks.length : 0));
  }, [tracks.length]);

  // First-load auto-play attempt when pref is already "on" from
  // localStorage. Works as long as the page got any user interaction
  // by the time the manifest loaded; otherwise needsGesture flips.
  useEffect(() => {
    if (pref === "on" && current && !playing) {
      void play();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks.length, pref]);

  const value = useMemo<Ctx>(
    () => ({
      playing,
      current,
      tracks,
      needsGesture,
      play,
      pause,
      next,
      getAudioElement,
    }),
    [playing, current, tracks, needsGesture, play, pause, next, getAudioElement]
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

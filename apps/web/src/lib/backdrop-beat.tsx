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
 * Audio + visualiser plumbing for the decorative backdrop.
 *
 * Architecture:
 *   • Lazy HTMLAudioElement (created on first user gesture so browser
 *     autoplay policies don't block our first play() call).
 *   • Web Audio graph: createMediaElementSource(audio) → AnalyserNode
 *     → destination. The AnalyserNode is exposed via getAnalyser() so
 *     <MinecraftBackdrop> can run its own rAF loop, sample frequency
 *     data, and turn it into column heights — proper FFT visualiser
 *     instead of the previous BPM-step pulse.
 *   • Manifest at /audio/manifest.json drives the playlist. No tracks
 *     ship with the panel (Mojang/C418/Lena Raine retain rights);
 *     drop your own files in /audio and list them with their BPM.
 *
 * Autoplay strategy:
 *   • play() / pause() / next() are exposed as actions. The Settings
 *     toggle calls play() directly inside its onClick — that keeps the
 *     user-gesture activation, so the browser allows it.
 *   • If play() is rejected anyway (e.g. user reloads the page with
 *     pref already "on" and no fresh gesture), `needsGesture` flips
 *     true and the UI surfaces a "click to enable" button.
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
  /** Returns the AnalyserNode if the audio graph is built, else null.
   *  Stable across renders (consumers call it inside their own rAF). */
  getAnalyser: () => AnalyserNode | null;
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
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);

  const current = tracks[trackIdx] ?? null;

  // Manifest fetch on mount. Failures stay silent — backdrop still
  // animates from its procedural fallback, just without sound.
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
        /* no manifest available */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Lazily create the <audio> element. Done outside any effect so
  // play()/pause() actions can use it before the first effect runs.
  const getAudio = useCallback((): HTMLAudioElement => {
    if (!audioRef.current) {
      const a = new Audio();
      a.preload = "auto";
      // crossOrigin is required for createMediaElementSource on
      // cross-origin sources. Same-origin (our /audio path) tolerates
      // either; setting "anonymous" keeps it consistent.
      a.crossOrigin = "anonymous";
      audioRef.current = a;
    }
    return audioRef.current;
  }, []);

  // Audio graph (AudioContext + AnalyserNode + MediaElementSource).
  // Must be built *inside* a user gesture or AudioContext starts
  // suspended on Chrome. We call this from play().
  const ensureAudioGraph = useCallback((): void => {
    const a = getAudio();
    if (!audioCtxRef.current) {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) return;
      audioCtxRef.current = new Ctor();
    }
    if (!sourceNodeRef.current) {
      try {
        sourceNodeRef.current =
          audioCtxRef.current.createMediaElementSource(a);
        const an = audioCtxRef.current.createAnalyser();
        an.fftSize = 512; // → 256 frequency bins
        // Moderate in-thread smoothing. The consumer (the visualiser)
        // does its own peak-hold + decay smoothing in float space, so
        // we don't need the AnalyserNode's smoothing to be heavy too —
        // 0.7 leaves the spectrum responsive while killing single-
        // frame jitter. 0.85 was washing out actual peaks.
        an.smoothingTimeConstant = 0.7;
        sourceNodeRef.current.connect(an);
        an.connect(audioCtxRef.current.destination);
        analyserRef.current = an;
      } catch {
        /* createMediaElementSource throws if already connected — fine. */
      }
    }
    if (audioCtxRef.current.state === "suspended") {
      void audioCtxRef.current.resume();
    }
  }, [getAudio]);

  // Wire up persistent <audio> event listeners once on mount. We don't
  // re-bind on track change because the same element is reused.
  useEffect(() => {
    const a = getAudio();
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
      // If the current src 404s or the codec is unsupported, advance
      // so a single bad track doesn't kill the whole playlist.
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
  }, [getAudio, tracks.length]);

  // Sync the audio src whenever the current track changes (e.g. after
  // ended/skip). Doesn't auto-play — that's gated on user gesture +
  // pref. If pref is "on" we kick play() once src is set.
  useEffect(() => {
    const a = audioRef.current;
    if (!a || !current) return;
    const targetSrc = absoluteUrl(current.url);
    if (a.src !== targetSrc) {
      a.src = current.url;
    }
    a.volume = volume;
  }, [current, volume]);

  // Volume slider tracking, separate so changing it doesn't reload src.
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  // pref → "off" should pause immediately. Turning "on" alone doesn't
  // start playback — that's done explicitly by play() so it always
  // happens within a user gesture.
  useEffect(() => {
    if (pref === "off") {
      audioRef.current?.pause();
    }
  }, [pref]);

  const play = useCallback(async (): Promise<void> => {
    if (!current) return;
    ensureAudioGraph();
    const a = getAudio();
    if (!a.src && current) a.src = current.url;
    try {
      await a.play();
      setNeedsGesture(false);
    } catch {
      // Browser blocked autoplay (no fresh gesture, or context lock).
      // The settings UI shows a "click to enable music" prompt off
      // this flag — clicking it retries from a fresh gesture.
      setNeedsGesture(true);
    }
  }, [current, ensureAudioGraph, getAudio]);

  const pause = useCallback((): void => {
    audioRef.current?.pause();
  }, []);

  const next = useCallback((): void => {
    setTrackIdx((i) => (tracks.length > 0 ? (i + 1) % tracks.length : 0));
  }, [tracks.length]);

  const getAnalyser = useCallback(() => analyserRef.current, []);

  // When manifest finishes loading and pref is already "on" (e.g.
  // saved from a prior session), attempt play once. This will succeed
  // if the page got any user gesture by now (clicking the page,
  // etc.); otherwise needsGesture flips and the UI prompts.
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
      getAnalyser,
    }),
    [playing, current, tracks, needsGesture, play, pause, next, getAnalyser]
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

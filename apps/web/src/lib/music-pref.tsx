"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

/**
 * Background-music preference + volume, persisted in localStorage.
 *
 * - "off" (default): no audio, beat clock falls back to a free-running
 *   internal tempo so the backdrop still pulses subtly.
 * - "on": audio plays. The beat clock derives its tempo from the
 *   currently-playing track's BPM (read from the audio manifest).
 *
 * We keep this separate from `motion-pref` because some users want
 * decorative motion on the page but no sound, and vice versa.
 */
export type MusicPref = "on" | "off";

type Ctx = {
  pref: MusicPref;
  setPref: (p: MusicPref) => void;
  /** 0–1 master volume for the music layer. */
  volume: number;
  setVolume: (v: number) => void;
};

const MusicContext = createContext<Ctx | null>(null);
const STORAGE_KEY = "cofemine-music";
const VOLUME_KEY = "cofemine-music-volume";

export function MusicPrefProvider({
  children,
}: {
  children: React.ReactNode;
}): JSX.Element {
  const [pref, setPrefState] = useState<MusicPref>("off");
  const [volume, setVolumeState] = useState<number>(0.4);

  // Hydrate from storage. SSR-safe.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === "on" || raw === "off") setPrefState(raw);
      const v = Number(localStorage.getItem(VOLUME_KEY));
      if (Number.isFinite(v) && v >= 0 && v <= 1) setVolumeState(v);
    } catch {
      /* ignore */
    }
  }, []);

  const setPref = useCallback((p: MusicPref) => {
    setPrefState(p);
    try {
      localStorage.setItem(STORAGE_KEY, p);
    } catch {
      /* ignore */
    }
  }, []);

  const setVolume = useCallback((v: number) => {
    const clamped = Math.max(0, Math.min(1, v));
    setVolumeState(clamped);
    try {
      localStorage.setItem(VOLUME_KEY, String(clamped));
    } catch {
      /* ignore */
    }
  }, []);

  const value = useMemo<Ctx>(
    () => ({ pref, setPref, volume, setVolume }),
    [pref, setPref, volume, setVolume]
  );

  return (
    <MusicContext.Provider value={value}>{children}</MusicContext.Provider>
  );
}

export function useMusicPref(): Ctx {
  const ctx = useContext(MusicContext);
  if (!ctx) {
    throw new Error("useMusicPref must be used inside <MusicPrefProvider>");
  }
  return ctx;
}

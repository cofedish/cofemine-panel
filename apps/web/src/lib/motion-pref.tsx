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
 * Three-state motion preference:
 *   - "auto" (default): respect the OS-level prefers-reduced-motion.
 *     If the user has reduced motion turned on, animations are off;
 *     otherwise they're on. This is the right default — accessibility
 *     hints take precedence unless explicitly overridden.
 *   - "on" / "off": explicit user override stored in localStorage.
 *
 * Components consume this via `useMotionEnabled()` to decide whether
 * to render decorative motion (drifting backgrounds, breathing logos,
 * stagger entries). Functional motion — modal open/close, lifecycle
 * transitions on action — stays unconditional because it carries
 * meaning, not flair.
 */
export type MotionPref = "auto" | "on" | "off";

type Ctx = {
  pref: MotionPref;
  setPref: (p: MotionPref) => void;
  /** Resolved boolean: does the user actually want decorative motion? */
  enabled: boolean;
};

const MotionContext = createContext<Ctx | null>(null);
const STORAGE_KEY = "cofemine-motion";

export function MotionPrefProvider({
  children,
}: {
  children: React.ReactNode;
}): JSX.Element {
  const [pref, setPrefState] = useState<MotionPref>("auto");
  const [systemReduced, setSystemReduced] = useState(false);

  // Hydrate from storage. SSR-safe.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === "on" || raw === "off" || raw === "auto") {
        setPrefState(raw);
      }
    } catch {
      /* ignore */
    }
  }, []);

  // Watch the OS reduce-motion media query so flipping it system-wide
  // takes effect without a reload.
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setSystemReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent): void =>
      setSystemReduced(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const setPref = useCallback((p: MotionPref) => {
    setPrefState(p);
    try {
      localStorage.setItem(STORAGE_KEY, p);
    } catch {
      /* ignore */
    }
  }, []);

  const enabled =
    pref === "on" ? true : pref === "off" ? false : !systemReduced;

  const value = useMemo<Ctx>(
    () => ({ pref, setPref, enabled }),
    [pref, setPref, enabled]
  );

  return (
    <MotionContext.Provider value={value}>{children}</MotionContext.Provider>
  );
}

export function useMotionPref(): Ctx {
  const ctx = useContext(MotionContext);
  if (!ctx) {
    throw new Error(
      "useMotionPref must be used inside <MotionPrefProvider>"
    );
  }
  return ctx;
}

/** Convenience: just the boolean for components that don't care about
 *  the underlying tri-state. */
export function useMotionEnabled(): boolean {
  return useMotionPref().enabled;
}

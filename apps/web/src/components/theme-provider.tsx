"use client";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

export const ACCENTS = [
  "emerald",
  "sky",
  "violet",
  "ruby",
  "lucifer",
  "caramel",
] as const;
export type Accent = (typeof ACCENTS)[number];
const ACCENT_STORAGE = "cofemine-accent";

interface AccentContextValue {
  accent: Accent;
  setAccent: (a: Accent) => void;
}

const AccentContext = createContext<AccentContextValue | null>(null);

function AccentProvider({ children }: { children: ReactNode }): JSX.Element {
  const [accent, setAccentState] = useState<Accent>("emerald");

  // Hydrate from localStorage on mount
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(ACCENT_STORAGE) as Accent | null;
      if (saved && ACCENTS.includes(saved)) {
        setAccentState(saved);
      }
    } catch {}
  }, []);

  // Sync class on <html> whenever accent changes.
  useEffect(() => {
    const root = document.documentElement;
    for (const a of ACCENTS) root.classList.remove(`accent-${a}`);
    root.classList.add(`accent-${accent}`);
  }, [accent]);

  const setAccent = (a: Accent): void => {
    setAccentState(a);
    try {
      window.localStorage.setItem(ACCENT_STORAGE, a);
    } catch {}
  };

  return (
    <AccentContext.Provider value={{ accent, setAccent }}>
      {children}
    </AccentContext.Provider>
  );
}

export function useAccent(): AccentContextValue {
  const ctx = useContext(AccentContext);
  if (!ctx) throw new Error("useAccent must be used inside <ThemeProvider>");
  return ctx;
}

export function ThemeProvider({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      storageKey="cofemine-theme"
      disableTransitionOnChange
    >
      <AccentProvider>{children}</AccentProvider>
    </NextThemesProvider>
  );
}

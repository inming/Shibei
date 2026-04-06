import { useState, useEffect, useCallback } from "react";

export type ThemeMode = "light" | "dark" | "system";

const STORAGE_KEY = "shibei-theme";
const VALID_MODES: ThemeMode[] = ["light", "dark", "system"];
const DARK_MQ = "(prefers-color-scheme: dark)";

function getSavedMode(): ThemeMode {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved && VALID_MODES.includes(saved as ThemeMode)) {
    return saved as ThemeMode;
  }
  return "system";
}

function applyTheme(mode: ThemeMode, systemDark: boolean) {
  const resolved = mode === "system" ? (systemDark ? "dark" : "light") : mode;
  document.documentElement.setAttribute("data-theme", resolved);
}

export function useTheme() {
  const [mode, setModeState] = useState<ThemeMode>(getSavedMode);
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia(DARK_MQ).matches
  );

  const setMode = useCallback((m: ThemeMode) => {
    setModeState(m);
    localStorage.setItem(STORAGE_KEY, m);
  }, []);

  // Listen to system theme changes
  useEffect(() => {
    const mq = window.matchMedia(DARK_MQ);
    const handler = (e: MediaQueryListEvent | { matches: boolean }) => {
      setSystemDark(e.matches);
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler as EventListener);
  }, []);

  // Apply theme whenever mode or system preference changes
  useEffect(() => {
    applyTheme(mode, systemDark);
  }, [mode, systemDark]);

  return { mode, setMode } as const;
}

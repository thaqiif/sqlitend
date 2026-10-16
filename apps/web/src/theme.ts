import { useCallback, useEffect, useState } from "react";

export type ThemeMode = "dark" | "light";

const STORAGE_KEY = "sqlitend:theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

function readStored(): ThemeMode | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // storage blocked: fall back to the OS preference
  }
  return null;
}

function systemTheme(): ThemeMode {
  return window.matchMedia?.(DARK_QUERY).matches ? "dark" : "light";
}

/** HeroUI themes via the `dark`/`light` class or `data-theme` on <html>; set both. */
export function applyTheme(mode: ThemeMode): void {
  const el = document.documentElement;
  el.classList.remove("light", "dark");
  el.classList.add(mode);
  el.setAttribute("data-theme", mode);
}

/** Call once before first render so there is no flash of the wrong theme. */
export function initTheme(): void {
  applyTheme(readStored() ?? systemTheme());
}

/** Current theme + toggle. Follows the OS until the user toggles; the choice is then persisted. */
export function useTheme(): { theme: ThemeMode; toggle: () => void } {
  const [theme, setTheme] = useState<ThemeMode>(() => readStored() ?? systemTheme());

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    const mq = window.matchMedia?.(DARK_QUERY);
    if (!mq) return;
    const onChange = () => {
      if (readStored() === null) setTheme(systemTheme());
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const toggle = useCallback(() => {
    const next: ThemeMode = theme === "dark" ? "light" : "dark";
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // not persisted; still applied for this session
    }
    setTheme(next);
  }, [theme]);

  return { theme, toggle };
}

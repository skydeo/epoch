// Theme context. `preference` is what the user picked — "system" (the default),
// "light" or "dark". `theme` is what's actually painted: the preference, or the
// OS setting when the preference is "system". Only an explicit light/dark
// choice is persisted to localStorage['epoch-theme']; "system" removes the key
// so the app keeps tracking the OS (including live changes, e.g. an automatic
// sunset switch) instead of freezing whatever it resolved to on first visit.
//
// The initial data-theme attribute is set pre-paint by the inline script in
// index.html, which applies the same rules.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type Theme = "light" | "dark";
export type ThemePreference = "system" | Theme;

const STORAGE_KEY = "epoch-theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

interface ThemeContextValue {
  /** The resolved, painted theme. */
  theme: Theme;
  /** What the user chose. */
  preference: ThemePreference;
  setPreference: (p: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    /* storage disabled — fall through to system */
  }
  return "system";
}

function systemTheme(): Theme {
  if (typeof window === "undefined" || !window.matchMedia) return "light";
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readPreference);
  const [system, setSystem] = useState<Theme>(systemTheme);

  // Track the OS setting live.
  useEffect(() => {
    if (!window.matchMedia) return;
    const mql = window.matchMedia(DARK_QUERY);
    const onChange = () => setSystem(mql.matches ? "dark" : "light");
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  const theme: Theme = preference === "system" ? system : preference;

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    // Keep the browser chrome (mobile status/tab bar) matched to what's
    // painted, even when an explicit choice overrides the OS.
    document
      .querySelectorAll('meta[name="theme-color"]')
      .forEach((m) => m.setAttribute("content", theme === "dark" ? "#0c1728" : "#ffffff"));
  }, [theme]);

  const setPreference = useCallback((p: ThemePreference) => {
    setPreferenceState(p);
    try {
      if (p === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, p);
    } catch {
      /* private mode / storage disabled — non-fatal */
    }
  }, []);

  const value = useMemo(
    () => ({ theme, preference, setPreference }),
    [theme, preference, setPreference],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}

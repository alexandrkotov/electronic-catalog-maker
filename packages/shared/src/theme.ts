/**
 * Light/dark theme toggle shared by the editor and viewer. Both apps render
 * everything through explicit CSS custom properties (see their style.css —
 * `:root` for light, `:root[data-theme="dark"]` for dark) rather than
 * `color-scheme: light dark`, which previously caused a real bug: browser
 * dark-mode heuristics repainted unstyled form controls/panels
 * unpredictably (white text on white buttons). This module only ever sets
 * an explicit `data-theme` attribute, never leaves it to guesswork.
 */

export type Theme = "light" | "dark";

const STORAGE_KEY = "ecm-theme";

/** An explicit choice from a previous visit wins; otherwise fall back to
 * the OS/browser preference. */
export function resolveInitialTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // localStorage unavailable (privacy mode, etc.) — fall through to system preference.
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Applies a theme to the document root and remembers it as an explicit choice. */
export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Theme still applies for this page load, just won't persist.
  }
}

export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

export function toggleTheme(): Theme {
  const next: Theme = currentTheme() === "dark" ? "light" : "dark";
  applyTheme(next);
  return next;
}

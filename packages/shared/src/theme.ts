/**
 * Light/dark theme toggle shared by the editor, viewer, and the embeddable
 * viewer component. All render through explicit CSS custom properties (see
 * style.css — `:root`/`:host` for light, `[data-theme="dark"]` for dark)
 * rather than `color-scheme: light dark`, which previously caused a real
 * bug: browser dark-mode heuristics repainted unstyled form controls/panels
 * unpredictably (white text on white buttons). This module only ever sets
 * an explicit `data-theme` attribute, never leaves it to guesswork.
 */

export type Theme = "light" | "dark";

const STORAGE_KEY = "ecm-theme";

/** An explicit choice from a previous visit wins (unless `useStored` is false); otherwise fall back to
 * the OS/browser preference. */
export function resolveInitialTheme(useStored = true): Theme {
  try {
    const stored = useStored ? localStorage.getItem(STORAGE_KEY) : null;
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // localStorage unavailable (privacy mode, etc.) — fall through to system preference.
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * Applies a theme and remembers it as an explicit choice (shared across
 * every app/component on the origin, standalone or embedded — one user's
 * light/dark preference, applied everywhere).
 *
 * `target` defaults to `document.documentElement`, right for the editor
 * and viewer's own full pages. The embeddable viewer passes its own shadow
 * host instead — it must never reach out and set an attribute on the
 * *embedding* page's `<html>`, only on itself.
 */
export function applyTheme(theme: Theme, target: HTMLElement = document.documentElement, persist = true) {
  target.dataset.theme = theme;
  if (!persist) return;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Theme still applies for this page load, just won't persist.
  }
}

export function currentTheme(target: HTMLElement = document.documentElement): Theme {
  return target.dataset.theme === "dark" ? "dark" : "light";
}

export function toggleTheme(target: HTMLElement = document.documentElement, persist = true): Theme {
  const next: Theme = currentTheme(target) === "dark" ? "light" : "dark";
  applyTheme(next, target, persist);
  return next;
}

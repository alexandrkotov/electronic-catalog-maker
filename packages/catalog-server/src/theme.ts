/**
 * Same light/dark pattern the editor and viewer use (packages/shared/src/theme.ts):
 * an explicit `data-theme="light"|"dark"` attribute on <html>, not the
 * `color-scheme` media-query heuristic this file's pages used to rely on —
 * that approach was deliberately dropped elsewhere in the project because it
 * repaints form controls unpredictably. Reimplemented here in plain
 * inline script/CSS (no shared import) since catalog-server ships as a
 * dependency-free compiled binary with its own template-literal pages, not
 * a bundled app that could import packages/shared.
 *
 * Storage key `ecm-theme` matches editor/viewer's own localStorage key, so a
 * choice made in one ECM surface (if ever opened from the same browser
 * profile) is picked up by this one too — a nice-to-have, not a guarantee.
 */

/** Must run before anything paints — placed first in <head>, ahead of <style>. */
export const THEME_INIT_SCRIPT = `<script>
(function () {
  var stored = null;
  try { stored = localStorage.getItem("ecm-theme"); } catch (e) {}
  var theme = stored === "light" || stored === "dark"
    ? stored
    : (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.setAttribute("data-theme", theme);
})();
</script>`;

/** Color tokens copied from editor/viewer's :root / :root[data-theme="dark"] — same palette across the project. */
export const THEME_VARS_CSS = `
  :root {
    --border: #d0d5dd;
    --bg-panel: #f8f9fb;
    --bg-page: #ffffff;
    --bg-elevated: #ffffff;
    --text: #1a1a1a;
    --muted: #666666;
    --accent: #2563eb;
    --accent-soft: #dbeafe;
    --danger: #b91c1c;
    /* Not one of editor/viewer's tokens — this file's own filled buttons
       (Copy, Stop, Preview) need readable text on --accent/--danger, and the
       light accent blue used in dark mode is too pale for white text. */
    --on-accent: #ffffff;
  }
  :root[data-theme="dark"] {
    --border: #3a3f4b;
    --bg-panel: #1c1f26;
    --bg-page: #14161b;
    --bg-elevated: #22252d;
    --text: #e5e7eb;
    --muted: #9aa1ac;
    --accent: #60a5fa;
    --accent-soft: #1e3a5f;
    --danger: #f87171;
    --on-accent: #0b1220;
  }
  .theme-toggle { min-width: 4.5rem; }
`;

export const THEME_TOGGLE_BUTTON_HTML = `<button type="button" id="theme-toggle" class="secondary theme-toggle"></button>`;

/** Appended into each page's own <script> block — expects #theme-toggle to exist. */
export const THEME_TOGGLE_SCRIPT = `
  var themeToggleBtn = document.getElementById("theme-toggle");
  function updateThemeToggleLabel() {
    themeToggleBtn.textContent = document.documentElement.getAttribute("data-theme") === "dark" ? "Light" : "Dark";
  }
  updateThemeToggleLabel();
  themeToggleBtn.addEventListener("click", function () {
    var next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("ecm-theme", next); } catch (e) {}
    updateThemeToggleLabel();
  });
`;

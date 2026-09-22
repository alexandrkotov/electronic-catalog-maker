import type { CatalogEntry } from "./catalogListing";
import { THEME_INIT_SCRIPT, THEME_TOGGLE_BUTTON_HTML, THEME_TOGGLE_SCRIPT, THEME_VARS_CSS } from "./theme";

/** Never shown until a real fetch to it succeeds — see the client script below, and the conversation that settled on "check by fetching, not navigator.onLine" for exactly this kind of "is the outside world reachable" question. */
const PROJECT_URL = "https://tapalog.com/";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * The catalog list a visitor sees at /browse. Two buttons per catalog, and
 * only two — see the project's design notes for why a third "Open in
 * Editor/Viewer" link (pointed at the hosted apps) was deliberately left
 * out: it only works from the same machine as this server or when this
 * server is in Internet mode, and would otherwise look clickable while
 * silently doing nothing — exactly the kind of broken-looking button this
 * app's non-technical audience shouldn't have to puzzle over.
 *
 * - "Copy URL" — the catalog file's own address, for pasting into an
 *   already-installed Editor/Viewer's "Open remote catalog…", or anywhere
 *   else.
 * - "Preview" — opens /preview/<relPath> in a new tab: a page this same
 *   server renders, with the catalog viewer embedded inline. Same origin as
 *   the file itself, so it always works — LAN or Internet, online or
 *   fully offline, no app installed required.
 */
/**
 * `baseUrl` is the shareable address this session's status page is
 * currently showing (LAN address, or the tunnel's public URL in Internet
 * mode) — NOT necessarily the host this /browse request itself arrived on.
 * Building an absolute URL from it (rather than a page-relative one resolved
 * against location.href) is what keeps "Copy URL" correct even when this
 * page is viewed via http://localhost:<port> on the server's own machine:
 * a relative link would resolve to that same "localhost" address, which
 * means nothing to anyone else it gets shared with.
 */
export function renderListingPage(entries: CatalogEntry[], baseUrl: string): string {
  // listCatalogs() already sorts by full relPath, which happens to put
  // same-folder entries next to each other — a Map built in that order
  // groups them correctly without needing to re-sort.
  const groups = new Map<string, CatalogEntry[]>();
  for (const entry of entries) {
    const lastSlash = entry.relPath.lastIndexOf("/");
    const dir = lastSlash === -1 ? "" : entry.relPath.slice(0, lastSlash);
    let group = groups.get(dir);
    if (!group) {
      group = [];
      groups.set(dir, group);
    }
    group.push(entry);
  }

  const sections = [...groups.entries()]
    .map(([dir, items]) => {
      const rowsHtml = items
        .map((entry) => {
          const href = `${baseUrl}/files/${entry.relPath.split("/").map(encodeURIComponent).join("/")}`;
          const previewHref = `${baseUrl}/preview/${entry.relPath.split("/").map(encodeURIComponent).join("/")}`;
          return `<div class="catalog-row">
            <span class="name" title="${escapeHtml(entry.relPath)}">${escapeHtml(entry.name)}</span>
            <span class="actions">
              <button type="button" class="copy-btn" data-href="${escapeHtml(href)}">Copy URL</button>
              <a class="preview-btn" href="${escapeHtml(previewHref)}" target="_blank" rel="noopener">Preview</a>
            </span>
          </div>`;
        })
        .join("\n");

      // Files sitting directly in the shared folder (dir === "") aren't
      // "in" a subfolder at all — a folder tab there would be pretending a
      // folder exists where there isn't one, so those get a plain card.
      if (!dir) return `<div class="folder-card no-tab"><div class="folder-body">${rowsHtml}</div></div>`;
      return `<div class="folder-card">
        <div class="folder-tab" title="${escapeHtml(dir)}">${escapeHtml(dir)}</div>
        <div class="folder-body">${rowsHtml}</div>
      </div>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
${THEME_INIT_SCRIPT}
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" type="image/png" href="/favicon.png" />
<title>Catalogs</title>
<style>
${THEME_VARS_CSS}
  body {
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    /* Shrink-wraps to the widest row instead of a fixed 40rem — a long
       filename used to hit that cap and wrap onto its own line, pushing
       Copy URL/Preview below it instead of staying on one row (confirmed
       live, 2026-09-22). min() caps it so it can't overflow a narrow
       viewport; below that width, rows are still free to wrap normally. */
    width: fit-content;
    max-width: 94vw;
    margin: 2.5rem auto;
    padding: 0 1.5rem;
    line-height: 1.5;
    background: var(--bg-page);
    color: var(--text);
  }
  .page-header { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
  h1 { font-size: 1.3rem; margin: 0; }
  .catalog-list { margin: 1.75rem 0 0; }
  /* A folder-tab shape: a small label sitting flush on top of a card,
     rounded everywhere except the corner where the two meet — the same
     silhouette as a standard OS folder icon, just built from two boxes. */
  .folder-card { margin: 0 0 1.5rem; }
  .folder-tab {
    display: inline-block;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    position: relative;
    top: 1px;
    background: var(--accent-soft);
    border: 1px solid var(--border);
    border-bottom: none;
    border-radius: 10px 10px 0 0;
    padding: 0.4rem 1rem;
    font-weight: 700;
    font-size: 0.85rem;
  }
  .folder-body {
    border: 1px solid var(--border);
    border-radius: 0 12px 12px 12px;
    background: var(--bg-panel);
    padding: 0.25rem 1.25rem;
  }
  .folder-card.no-tab .folder-body { border-radius: 12px; }
  .catalog-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.9rem 0;
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
  }
  .catalog-row:last-child { border-bottom: none; }
  .name { font-weight: 600; overflow-wrap: anywhere; }
  .actions { display: flex; gap: 0.5rem; flex-shrink: 0; }
  button, a.preview-btn {
    font-size: 0.95rem;
    padding: 0.5rem 0.9rem;
    border-radius: 8px;
    border: 1px solid var(--border);
    cursor: pointer;
    background: transparent;
    color: var(--text);
    text-decoration: none;
  }
  .preview-btn { background: var(--accent); color: var(--on-accent); border-color: transparent; }
  .empty { opacity: 0.75; margin-top: 1.5rem; }
  #app-links { display: none; margin-top: 2rem; font-size: 0.92rem; opacity: 0.85; }
  #app-links a { color: var(--accent); }
</style>
</head>
<body>
  <div class="page-header">
    <h1>Catalogs</h1>
    ${THEME_TOGGLE_BUTTON_HTML}
  </div>
  ${entries.length === 0 ? '<p class="empty">No catalogs found in this folder yet.</p>' : `<div class="catalog-list">${sections}</div>`}
  <p id="app-links">Don't have a catalog app installed yet? <a href="${escapeHtml(PROJECT_URL)}" target="_blank" rel="noopener">Get Editor/Viewer</a></p>
<script>
  for (const btn of document.querySelectorAll(".copy-btn")) {
    btn.addEventListener("click", async () => {
      const url = new URL(btn.dataset.href, location.href).href;
      try {
        await navigator.clipboard.writeText(url);
        btn.textContent = "Copied!";
      } catch {
        btn.textContent = "Couldn't copy";
      }
      setTimeout(() => { btn.textContent = "Copy URL"; }, 1500);
    });
  }

  // Only shown once a real request to the project site succeeds — not
  // navigator.onLine, which only reflects "some network exists", not "this
  // particular site is actually reachable" (settled during design: this
  // server can be running fully offline on a LAN with no route out at all).
  fetch(${JSON.stringify(PROJECT_URL)}, { mode: "no-cors", signal: AbortSignal.timeout(2500) })
    .then(() => { document.getElementById("app-links").style.display = "block"; })
    .catch(() => {});
${THEME_TOGGLE_SCRIPT}
</script>
</body>
</html>`;
}

import type { CatalogEntry } from "./catalogListing";

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
export function renderListingPage(entries: CatalogEntry[]): string {
  // listCatalogs() already sorts by full relPath, which happens to put
  // same-folder entries next to each other — this just adds a heading each
  // time the folder part changes, rather than re-sorting or re-grouping.
  let lastDir: string | null = null;
  const rows = entries
    .map((entry) => {
      const lastSlash = entry.relPath.lastIndexOf("/");
      const dir = lastSlash === -1 ? "" : entry.relPath.slice(0, lastSlash);
      const href = `/files/${entry.relPath.split("/").map(encodeURIComponent).join("/")}`;
      const previewHref = `/preview/${entry.relPath.split("/").map(encodeURIComponent).join("/")}`;
      let heading = "";
      if (dir !== lastDir) {
        lastDir = dir;
        heading = `<h2 class="folder-heading">${dir ? escapeHtml(dir) : "(root)"}</h2>`;
      }
      return `${heading}<div class="catalog-row">
        <span class="name" title="${escapeHtml(entry.relPath)}">${escapeHtml(entry.name)}</span>
        <span class="actions">
          <button type="button" class="copy-btn" data-href="${escapeHtml(href)}">Copy URL</button>
          <a class="preview-btn" href="${escapeHtml(previewHref)}" target="_blank" rel="noopener">Preview</a>
        </span>
      </div>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" type="image/png" href="/favicon.png" />
<title>Catalogs</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    max-width: 40rem;
    margin: 2.5rem auto;
    padding: 0 1.5rem;
    line-height: 1.5;
  }
  h1 { font-size: 1.3rem; }
  .catalog-list { margin: 1.5rem 0 0; }
  .folder-heading {
    font-size: 0.85rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    opacity: 0.65;
    margin: 1.5rem 0 0.25rem;
  }
  .folder-heading:first-child { margin-top: 0; }
  .catalog-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.9rem 0;
    border-bottom: 1px solid #8884;
    flex-wrap: wrap;
  }
  .name { font-weight: 600; overflow-wrap: anywhere; }
  .actions { display: flex; gap: 0.5rem; flex-shrink: 0; }
  button, a.preview-btn {
    font-size: 0.95rem;
    padding: 0.5rem 0.9rem;
    border-radius: 8px;
    border: 1px solid #8884;
    cursor: pointer;
    background: transparent;
    color: inherit;
    text-decoration: none;
  }
  .preview-btn { background: #0969da; color: white; border-color: transparent; }
  .empty { opacity: 0.75; margin-top: 1.5rem; }
  #app-links { display: none; margin-top: 2rem; font-size: 0.92rem; opacity: 0.85; }
  #app-links a { color: inherit; }
</style>
</head>
<body>
  <h1>🗂️ Catalogs</h1>
  ${entries.length === 0 ? '<p class="empty">No catalogs found in this folder yet.</p>' : `<div class="catalog-list">${rows}</div>`}
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
</script>
</body>
</html>`;
}

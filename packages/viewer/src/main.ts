import "./style.css";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import {
  CATALOG_FILE_EXTENSION,
  findRowByUrl,
  initSqlite,
  listImages,
  listLinksForImage,
  listRowsForImage,
  openCatalog,
  readMeta,
  resolveInitialTheme,
  applyTheme,
  currentTheme,
  toggleTheme,
  type CatalogLink,
  type CatalogRow,
  type Database,
  type SqlJsStatic,
} from "@ecm/shared";

// Applied before the first render so there's no flash of the wrong theme.
applyTheme(resolveInitialTheme());

const app = document.getElementById("app")!;

let SQL: SqlJsStatic;
let db: Database | null = null;
let activeImageId: number | null = null;
// The hotspot's own id, not its url — several hotspots can share one url
// (the same part drawn at multiple positions on one diagram), so centering
// on "whichever hotspot happens to match this url" would jump to the wrong
// one. The url derived from this link is still what highlights the row.
let selectedLinkId: number | null = null;
let zoom = 1;
let statusMessage = "";
// render() replaces #app's innerHTML wholesale, which recreates #stage-scroll
// from scratch (a fresh element always starts scrolled to 0,0) — tracked so
// render() can restore the pan position instead of losing it on every
// unrelated update (selecting a link/row, zooming, ...).
let lastRenderedImageId: number | null = null;

function actionSetZoom(next: number) {
  zoom = Math.min(4, Math.max(0.25, next));
  render();
}

async function boot() {
  app.innerHTML = `<p style="padding:1rem">Loading SQLite (sql.js)…</p>`;
  SQL = await initSqlite(wasmUrl);

  const params = new URLSearchParams(location.search);
  const src = params.get("src");
  if (src) {
    await loadFromUrl(src);
  } else {
    render();
  }
}

async function loadFromUrl(url: string) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    openBytes(bytes);
  } catch (err) {
    statusMessage = `Could not load "${url}": ${(err as Error).message}`;
    render();
  }
}

function openBytes(bytes: Uint8Array) {
  db = openCatalog(SQL, bytes);
  const meta = readMeta(db);
  activeImageId = listImages(db)[0]?.id ?? null;
  selectedLinkId = null;
  zoom = 1;
  statusMessage = `Opened catalog "${meta.catalogName}".`;
  render();
}

async function actionOpenFile(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    openBytes(bytes);
  } catch (err) {
    statusMessage = `Could not open file: ${(err as Error).message}`;
    render();
  }
}

function actionSelectImage(id: number) {
  activeImageId = id;
  selectedLinkId = null;
  zoom = 1;
  render();
}

/** Clicking a hotspot directly: we know exactly which physical instance was clicked. */
function actionSelectHotspot(linkId: number) {
  selectedLinkId = linkId;
  render();
  centerSelection();
}

/**
 * Clicking a table row: several hotspots may share this row's url (same part,
 * drawn several times), so pick the first one on this image to center on —
 * all of them still get highlighted together on the image either way. The
 * instance-nav control (see renderInstanceNav) lets the user step through
 * the rest of them from there.
 */
function actionSelectRowByUrl(url: string) {
  if (!db || activeImageId === null) return;
  const link = listLinksForImage(db, activeImageId).find((l) => l.url === url);
  if (link) actionSelectHotspot(link.id);
}

/** Steps to the next/previous hotspot sharing the current selection's url, wrapping around. */
function actionCycleInstance(delta: number) {
  if (!db || activeImageId === null || selectedLinkId === null) return;
  const links = listLinksForImage(db, activeImageId);
  const current = links.find((l) => l.id === selectedLinkId);
  if (!current) return;
  const siblings = links.filter((l) => l.url === current.url).sort((a, b) => a.id - b.id);
  const index = siblings.findIndex((l) => l.id === selectedLinkId);
  if (index === -1) return;
  const next = siblings[(index + delta + siblings.length) % siblings.length];
  if (next) actionSelectHotspot(next.id);
}

function centerSelection() {
  const hotspotEl = document.querySelector(`.hotspot[data-id="${selectedLinkId}"]`);
  hotspotEl?.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
  const url = hotspotEl?.getAttribute("data-url");
  if (url) document.querySelector(`tr[data-url="${cssEscape(url)}"]`)?.scrollIntoView({ block: "nearest" });
}

/** Press-and-drag anywhere on the image to pan it (cursor turns into a grabbing hand). */
function startImagePan(evt: MouseEvent, scrollEl: HTMLElement) {
  evt.preventDefault();
  const startX = evt.clientX;
  const startY = evt.clientY;
  const startScrollLeft = scrollEl.scrollLeft;
  const startScrollTop = scrollEl.scrollTop;
  scrollEl.classList.add("panning");

  function onMove(moveEvt: MouseEvent) {
    scrollEl.scrollLeft = startScrollLeft - (moveEvt.clientX - startX);
    scrollEl.scrollTop = startScrollTop - (moveEvt.clientY - startY);
  }

  function onUp() {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    scrollEl.classList.remove("panning");
  }

  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

function cssEscape(s: string): string {
  return s.replace(/["\\]/g, "\\$&");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function render() {
  const images = db ? listImages(db) : [];
  const activeImage = images.find((i) => i.id === activeImageId) ?? null;
  const links = db && activeImage ? listLinksForImage(db, activeImage.id) : [];
  const rows = db && activeImage ? listRowsForImage(db, activeImage.id) : [];
  // Every hotspot sharing this url is highlighted together (they're the same
  // part), while centering (see actionSelectHotspot) targets the one actually
  // clicked.
  const selectedUrl = links.find((l) => l.id === selectedLinkId)?.url ?? null;
  const instances = selectedUrl
    ? links.filter((l) => l.url === selectedUrl).sort((a, b) => a.id - b.id)
    : [];
  const instanceIndex = instances.findIndex((l) => l.id === selectedLinkId);

  // Preserve the current pan position across a re-render of the *same*
  // image (rebuilding #app.innerHTML recreates #stage-scroll from scratch,
  // which would otherwise silently snap back to scrollLeft/Top = 0).
  const prevStageScroll = document.getElementById("stage-scroll");
  const savedScroll =
    prevStageScroll && activeImageId === lastRenderedImageId
      ? { left: prevStageScroll.scrollLeft, top: prevStageScroll.scrollTop }
      : null;
  lastRenderedImageId = activeImageId;

  app.innerHTML = `
    <div class="toolbar">
      <h1>Electronic Catalog — Viewer</h1>
      <button id="btn-open">Open catalog…</button>
      <input type="file" id="file-open" accept=".${CATALOG_FILE_EXTENSION}" style="display:none" />
      <span class="spacer"></span>
      <button id="btn-theme" title="Toggle light/dark theme">${currentTheme() === "dark" ? "☀️ Light" : "🌙 Dark"}</button>
      <span class="hint">${escapeHtml(statusMessage)}</span>
    </div>

    <div class="panel-images">
      ${
        images.length === 0
          ? `<p class="hint">Open a .${CATALOG_FILE_EXTENSION} catalog file.</p>`
          : `<ul>${images
              .map(
                (img) =>
                  `<li data-id="${img.id}" class="${img.id === activeImageId ? "active" : ""}">${escapeHtml(img.name)}</li>`,
              )
              .join("")}</ul>`
      }
    </div>

    <div class="stage">
      <div class="stage-scroll" id="stage-scroll">
        ${
          activeImage
            ? `<div class="stage-inner" style="transform: scale(${zoom})">
                 <img id="stage-img" src="data:${activeImage.mimeType};base64,${activeImage.imageData}" width="${activeImage.width}" height="${activeImage.height}" />
                 ${links.map((l) => hotspotHtml(l, selectedUrl, selectedLinkId)).join("")}
               </div>`
            : `<p class="hint" style="padding:2rem">No image selected.</p>`
        }
      </div>
      ${activeImage ? renderZoomControls() : ""}
      ${instances.length > 1 ? renderInstanceNav(instanceIndex, instances.length) : ""}
    </div>

    <div class="table-panel">
      ${
        activeImage
          ? `<table>
               <thead><tr><th>Name</th><th>SKU</th><th>Description</th><th>Extra</th></tr></thead>
               <tbody>${rows.map((r) => rowHtml(r, selectedUrl)).join("")}</tbody>
             </table>`
          : ""
      }
    </div>
  `;

  if (savedScroll) {
    const stageScroll = document.getElementById("stage-scroll");
    if (stageScroll) {
      stageScroll.scrollLeft = savedScroll.left;
      stageScroll.scrollTop = savedScroll.top;
    }
  }

  wireEvents();
}

function renderZoomControls(): string {
  return `
    <div class="zoom-controls">
      <button id="btn-zoom-out" title="Zoom out">−</button>
      <span class="zoom-pct">${Math.round(zoom * 100)}%</span>
      <button id="btn-zoom-in" title="Zoom in">+</button>
      <button id="btn-zoom-reset" title="Reset zoom">Reset</button>
    </div>
  `;
}

function renderInstanceNav(index: number, total: number): string {
  return `
    <div class="instance-nav">
      <button id="btn-instance-prev" title="Previous occurrence of this part">‹</button>
      <span>${index + 1} of ${total}</span>
      <button id="btn-instance-next" title="Next occurrence of this part">›</button>
    </div>
  `;
}

function hotspotHtml(l: CatalogLink, selectedUrl: string | null, selectedLinkId: number | null): string {
  // .selected: this hotspot's part is the one showing in the table (may be several).
  // .current: this is the *specific* instance centering targets — distinct so
  // stepping through duplicates with the instance-nav is visually obvious.
  const classes = ["hotspot"];
  if (l.url === selectedUrl) classes.push("selected");
  if (l.id === selectedLinkId) classes.push("current");
  return `<div class="${classes.join(" ")}" data-id="${l.id}" data-url="${escapeHtml(l.url)}" style="top:${l.top}px;left:${l.left}px;font-size:${l.fontSize}px" title="${escapeHtml(l.url)}">${escapeHtml(l.name)}</div>`;
}

function rowHtml(r: CatalogRow, selectedUrl: string | null): string {
  const selected = r.url === selectedUrl ? "selected" : "";
  const extra = Object.entries(r.extra)
    .map(([k, v]) => `${escapeHtml(k)}: ${escapeHtml(v)}`)
    .join(", ");
  return `<tr data-url="${escapeHtml(r.url)}" class="${selected}"><td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.sku)}</td><td>${escapeHtml(r.description)}</td><td>${extra}</td></tr>`;
}

function wireEvents() {
  const fileOpen = document.getElementById("file-open") as HTMLInputElement;
  document.getElementById("btn-theme")?.addEventListener("click", () => {
    toggleTheme();
    render();
  });

  document.getElementById("btn-open")?.addEventListener("click", () => fileOpen.click());
  fileOpen.addEventListener("change", () => {
    const file = fileOpen.files?.[0];
    if (file) void actionOpenFile(file);
  });

  document.querySelectorAll<HTMLLIElement>(".panel-images li[data-id]").forEach((li) => {
    li.addEventListener("click", () => actionSelectImage(Number(li.dataset.id)));
  });

  document.getElementById("btn-zoom-in")?.addEventListener("click", () => actionSetZoom(zoom * 1.25));
  document.getElementById("btn-zoom-out")?.addEventListener("click", () => actionSetZoom(zoom / 1.25));
  document.getElementById("btn-zoom-reset")?.addEventListener("click", () => actionSetZoom(1));

  document.getElementById("btn-instance-prev")?.addEventListener("click", () => actionCycleInstance(-1));
  document.getElementById("btn-instance-next")?.addEventListener("click", () => actionCycleInstance(1));

  document.getElementById("stage-scroll")?.addEventListener(
    "wheel",
    (evt) => {
      if (!evt.ctrlKey && !evt.metaKey) return;
      evt.preventDefault();
      actionSetZoom(zoom * Math.exp(-evt.deltaY * 0.001));
    },
    { passive: false },
  );

  const stageImg = document.getElementById("stage-img") as HTMLImageElement | null;
  const stageScroll = document.getElementById("stage-scroll") as HTMLElement | null;
  if (stageImg && stageScroll) {
    stageImg.addEventListener("mousedown", (evt) => startImagePan(evt, stageScroll));
  }

  document.querySelectorAll<HTMLDivElement>(".hotspot[data-id]").forEach((el) => {
    el.addEventListener("click", () => actionSelectHotspot(Number(el.dataset.id)));
  });

  document.querySelectorAll<HTMLTableRowElement>("tr[data-url]").forEach((tr) => {
    tr.addEventListener("click", () => actionSelectRowByUrl(tr.dataset.url!));
  });

  void findRowByUrl; // used indirectly via listRowsForImage today; kept for future direct-lookup use
}

void boot();

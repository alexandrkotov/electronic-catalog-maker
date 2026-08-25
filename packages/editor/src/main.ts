import "./style.css";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import {
  addImage,
  addLink,
  addRow,
  CATALOG_FILE_EXTENSION,
  createEmptyCatalog,
  deleteLink,
  exportCatalog,
  findLinkConflicts,
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
  updateLink,
  updateLinkPosition,
  type CatalogImage,
  type CatalogLink,
  type Database,
  type LinkConflict,
  type SqlJsStatic,
} from "@ecm/shared";
import { slugify } from "./slugify";

// Applied before the first render so there's no flash of the wrong theme.
applyTheme(resolveInitialTheme());

const app = document.getElementById("app")!;

const CATALOG_PICKER_TYPE: FilePickerAcceptType = {
  description: "Electronic catalog",
  accept: { "application/x-sqlite3": [`.${CATALOG_FILE_EXTENSION}`] },
};

let SQL: SqlJsStatic;
let db: Database | null = null;
let activeImageId: number | null = null;
let pendingHotspot: { top: number; left: number } | null = null;
let editingLinkId: number | null = null;
let zoom = 1;
let statusMessage = "";
// Set when the catalog was opened (or first saved) via the File System
// Access API, so subsequent Save calls can overwrite it in place.
let openedFileHandle: FileSystemFileHandle | null = null;
// render() replaces #app's innerHTML wholesale, which recreates #stage-scroll
// from scratch (a fresh element always starts scrolled to 0,0) — tracked so
// render() can restore the pan position instead of losing it on every
// unrelated update (adding a hotspot, editing a link, zooming, ...).
let lastRenderedImageId: number | null = null;
// In-app replacement for window.confirm(): browsers can silently auto-deny
// confirm()/alert() after a page has shown several of them without a fresh
// user gesture in between (Chrome's dialog-spam guard), which made "Save
// anyway?" fail silently with no visible error. This never touches the
// browser's native dialog API, so it can't be suppressed that way.
let pendingConfirmation: { message: string; onConfirm: () => void } | null = null;

function askConfirm(message: string, onConfirm: () => void) {
  pendingConfirmation = { message, onConfirm };
  render();
}

async function boot() {
  app.innerHTML = `<p style="padding:1rem">Loading SQLite (sql.js)…</p>`;
  SQL = await initSqlite(wasmUrl);
  render();
}

function currentImages(): CatalogImage[] {
  return db ? listImages(db) : [];
}

function setStatus(message: string) {
  statusMessage = message;
  render();
}

function resetTransientEditState() {
  pendingHotspot = null;
  editingLinkId = null;
  zoom = 1;
}

function actionSetZoom(next: number) {
  zoom = Math.min(4, Math.max(0.25, next));
  render();
}

// ---------- actions: catalog lifecycle ----------

function actionNewCatalog() {
  const name = prompt("New catalog name:", "Untitled catalog");
  if (name === null) return;
  db = createEmptyCatalog(SQL, name || "Untitled catalog");
  activeImageId = null;
  openedFileHandle = null;
  resetTransientEditState();
  setStatus(`Created new catalog "${name}".`);
}

async function openCatalogFromBytes(bytes: Uint8Array, handle: FileSystemFileHandle | null) {
  try {
    db = openCatalog(SQL, bytes);
    const meta = readMeta(db);
    activeImageId = currentImages()[0]?.id ?? null;
    openedFileHandle = handle;
    resetTransientEditState();
    setStatus(`Opened catalog "${meta.catalogName}".`);
  } catch (err) {
    setStatus(`Could not open file: ${(err as Error).message}`);
  }
}

async function actionOpenCatalogClicked(fallbackInput: HTMLInputElement) {
  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({ types: [CATALOG_PICKER_TYPE] });
      if (!handle) return;
      const file = await handle.getFile();
      await openCatalogFromBytes(new Uint8Array(await file.arrayBuffer()), handle);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setStatus(`Could not open file: ${(err as Error).message}`);
      }
    }
    return;
  }
  // Browsers without the File System Access API (Firefox, Safari): fall
  // back to a plain <input type=file>. We won't get a writable handle, so
  // Save will prompt like Save As the first time.
  fallbackInput.click();
}

function suggestedFileName(): string {
  const meta = db ? readMeta(db) : null;
  const base = meta?.catalogName.replace(/[^\w\-]+/g, "_") || "catalog";
  return `${base}.${CATALOG_FILE_EXTENSION}`;
}

function downloadBytes(bytes: Uint8Array) {
  const blob = new Blob([bytes as BlobPart], { type: "application/x-sqlite3" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = suggestedFileName();
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Always downloads a fresh copy — never touches whatever file was opened. */
function actionExportCatalog() {
  if (!db) return;
  downloadBytes(exportCatalog(db));
}

/**
 * Saves in place: overwrites the previously opened/saved file if the browser
 * supports the File System Access API (prompting for a location the first
 * time, like a native app's Save/Save As). Falls back to a plain download in
 * browsers that don't support it (Firefox, Safari).
 */
async function actionSave() {
  if (!db) return;
  const bytes = exportCatalog(db);

  if (!openedFileHandle && window.showSaveFilePicker) {
    try {
      openedFileHandle = await window.showSaveFilePicker({
        suggestedName: suggestedFileName(),
        types: [CATALOG_PICKER_TYPE],
      });
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setStatus(`Could not choose a save location: ${(err as Error).message}`);
      }
      return;
    }
  }

  if (openedFileHandle) {
    try {
      const writable = await openedFileHandle.createWritable();
      await writable.write(bytes as BufferSource);
      await writable.close();
      setStatus(`Saved "${openedFileHandle.name}".`);
    } catch (err) {
      setStatus(`Could not save: ${(err as Error).message}`);
    }
    return;
  }

  downloadBytes(bytes);
  setStatus('Downloaded a copy (this browser can\'t save in place — "Open catalog…" it again next time).');
}

// ---------- actions: images ----------

async function actionAddImage(file: File) {
  if (!db) return;
  const dataUrl = await fileToDataUrl(file);
  const [, mimeType, base64] = dataUrl.match(/^data:([^;]+);base64,(.*)$/s) ?? [];
  if (!base64) {
    setStatus("Could not read the image.");
    return;
  }
  const { width, height } = await imageDimensions(dataUrl);
  const id = addImage(db, {
    name: file.name,
    mimeType: mimeType ?? file.type,
    imageData: base64,
    width,
    height,
    sortOrder: currentImages().length,
  });
  activeImageId = id;
  resetTransientEditState();
  setStatus(`Added image "${file.name}".`);
}

function actionSelectImage(id: number) {
  activeImageId = id;
  resetTransientEditState();
  render();
}

// ---------- actions: hotspots (links) ----------

/**
 * One gesture, two outcomes: click the bare image (no real movement) to
 * place a new hotspot there, or press-and-drag to pan the image around
 * instead (cursor turns into a grabbing hand).
 */
function startStageInteraction(evt: MouseEvent, img: HTMLImageElement, scrollEl: HTMLElement) {
  evt.preventDefault();
  const rect = img.getBoundingClientRect();
  const startX = evt.clientX;
  const startY = evt.clientY;
  const startScrollLeft = scrollEl.scrollLeft;
  const startScrollTop = scrollEl.scrollTop;
  let moved = false;

  function onMove(moveEvt: MouseEvent) {
    const dx = moveEvt.clientX - startX;
    const dy = moveEvt.clientY - startY;
    if (!moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
      moved = true;
      scrollEl.classList.add("panning");
    }
    if (moved) {
      scrollEl.scrollLeft = startScrollLeft - dx;
      scrollEl.scrollTop = startScrollTop - dy;
    }
  }

  function onUp(upEvt: MouseEvent) {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    scrollEl.classList.remove("panning");
    if (!moved) {
      const left = Math.round((upEvt.clientX - rect.left) / zoom);
      const top = Math.round((upEvt.clientY - rect.top) / zoom);
      pendingHotspot = { top, left };
      editingLinkId = null;
      render();
    }
  }

  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

/**
 * One gesture, two outcomes: drag an existing hotspot to reposition it, or
 * click it (no real movement) to open it for editing.
 */
function startDragHotspot(evt: MouseEvent, link: CatalogLink, el: HTMLElement, img: HTMLImageElement) {
  evt.preventDefault();
  evt.stopPropagation();
  const rect = img.getBoundingClientRect();
  const startX = evt.clientX;
  const startY = evt.clientY;
  let top = link.top;
  let left = link.left;
  let moved = false;
  el.classList.add("dragging");

  function onMove(moveEvt: MouseEvent) {
    if (Math.abs(moveEvt.clientX - startX) > 3 || Math.abs(moveEvt.clientY - startY) > 3) moved = true;
    top = Math.round((moveEvt.clientY - rect.top) / zoom);
    left = Math.round((moveEvt.clientX - rect.left) / zoom);
    el.style.top = `${top}px`;
    el.style.left = `${left}px`;
  }

  function onUp() {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    if (moved) {
      if (db) updateLinkPosition(db, link.id, top, left);
      render();
    } else {
      editingLinkId = link.id;
      pendingHotspot = null;
      render();
      centerOnHotspot(link.id);
    }
  }

  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

function actionEditLink(linkId: number) {
  editingLinkId = linkId;
  pendingHotspot = null;
  render();
  centerOnHotspot(linkId);
}

/** Scrolls the stage so the given hotspot is centered in view. */
function centerOnHotspot(linkId: number) {
  document
    .querySelector(`.hotspot[data-id="${linkId}"]`)
    ?.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
}

/** A repeated name/url is legitimate (the same part drawn at several positions on one diagram). */
function conflictMessage(conflicts: LinkConflict[]): string {
  const lines = conflicts.map(
    (c) => `${c.field === "name" ? "Name" : "URL"} "${c.value}" is already used by another hotspot in this catalog.`,
  );
  return `${lines.join("\n")}\n\nThis is fine if it's the same part drawn again elsewhere. Save anyway?`;
}

function actionAddLink(name: string, url: string) {
  if (!db || activeImageId === null || !pendingHotspot) return;
  const imageId = activeImageId;
  const top = pendingHotspot.top;
  const left = pendingHotspot.left;
  const conflicts = findLinkConflicts(db, name, url);

  const doAdd = () => {
    if (!db) return;
    try {
      addLink(db, { imageId, name, url, top, left });
      pendingHotspot = null;
      setStatus(`Link "${name}" added.`);
    } catch (err) {
      setStatus(`Could not add link: ${(err as Error).message}`);
    }
  };

  if (conflicts.length > 0) {
    askConfirm(conflictMessage(conflicts), doAdd);
  } else {
    doAdd();
  }
}

function actionUpdateLink(name: string, url: string) {
  if (!db || editingLinkId === null) return;
  const linkId = editingLinkId;
  const conflicts = findLinkConflicts(db, name, url, linkId);

  const doUpdate = () => {
    if (!db) return;
    try {
      updateLink(db, linkId, { name, url });
      editingLinkId = null;
      setStatus(`Link "${name}" updated.`);
    } catch (err) {
      setStatus(`Could not update link: ${(err as Error).message}`);
    }
  };

  if (conflicts.length > 0) {
    askConfirm(conflictMessage(conflicts), doUpdate);
  } else {
    doUpdate();
  }
}

function actionDeleteLink() {
  if (!db || editingLinkId === null) return;
  const linkId = editingLinkId;
  askConfirm(
    "Delete this hotspot? Its data row is deleted too, unless another hotspot still shares it. This can't be undone.",
    () => {
      if (!db) return;
      try {
        deleteLink(db, linkId);
        editingLinkId = null;
        setStatus("Link deleted.");
      } catch (err) {
        setStatus(`Could not delete link: ${(err as Error).message}`);
      }
    },
  );
}

function actionCancelEditLink() {
  editingLinkId = null;
  render();
}

function actionAddRow(url: string, name: string, sku: string, description: string, extraText: string) {
  if (!db || activeImageId === null) return;
  let extra: Record<string, string> = {};
  if (extraText.trim()) {
    try {
      extra = JSON.parse(extraText);
    } catch {
      setStatus('The "extra characteristics" field must be a valid JSON object.');
      return;
    }
  }
  addRow(db, { imageId: activeImageId, url, name, sku, description, extra });
  setStatus(`Row for "${url}" added.`);
}

// ---------- helpers ----------

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function imageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = reject;
    img.src = dataUrl;
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// ---------- render ----------

function render() {
  const images = currentImages();
  const activeImage = images.find((i) => i.id === activeImageId) ?? null;
  const links = db && activeImage ? listLinksForImage(db, activeImage.id) : [];
  const rows = db && activeImage ? listRowsForImage(db, activeImage.id) : [];
  const usedUrls = new Set(rows.map((r) => r.url));
  const availableLinks = links.filter((l) => !usedUrls.has(l.url));
  const editingLink = links.find((l) => l.id === editingLinkId) ?? null;

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
      <h1>Electronic Catalog — Editor</h1>
      <button id="btn-new">New catalog</button>
      <button id="btn-open">Open catalog…</button>
      <input type="file" id="file-open" accept=".${CATALOG_FILE_EXTENSION}" style="display:none" />
      <button id="btn-add-image" ${db ? "" : "disabled"}>Add image…</button>
      <input type="file" id="file-image" accept="image/*" style="display:none" />
      <button id="btn-save" ${db ? "" : "disabled"} title="Save in place (overwrites the opened file where your browser supports it)">Save</button>
      <button id="btn-export" ${db ? "" : "disabled"} title="Always downloads a new copy">Export .${CATALOG_FILE_EXTENSION}</button>
      <span class="spacer"></span>
      <button id="btn-theme" title="Toggle light/dark theme">${currentTheme() === "dark" ? "☀️ Light" : "🌙 Dark"}</button>
      <span class="hint">${escapeHtml(statusMessage)}</span>
    </div>

    <div class="panel-images">
      ${
        images.length === 0
          ? `<p class="hint">${db ? "No images in this catalog yet." : "Create or open a catalog."}</p>`
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
            ? `<div class="stage-inner" id="stage-inner" style="transform: scale(${zoom})">
                 <img id="stage-img" src="data:${activeImage.mimeType};base64,${activeImage.imageData}" width="${activeImage.width}" height="${activeImage.height}" />
                 ${links.map((l) => hotspotHtml(l)).join("")}
                 ${pendingHotspot ? `<div class="hotspot pending" style="top:${pendingHotspot.top}px;left:${pendingHotspot.left}px">new…</div>` : ""}
               </div>`
            : `<p class="hint" style="padding:2rem">Select an image on the left, or add a new one.</p>`
        }
      </div>
      ${activeImage ? renderZoomControls() : ""}
    </div>

    <div class="inspector">
      ${activeImage ? renderLinkForm(links) : ""}
      ${activeImage ? renderEditLinkForm(editingLink) : ""}
      ${activeImage ? renderLinksSection(links, editingLinkId) : ""}
      ${activeImage ? renderRowForm(availableLinks) : ""}
      ${activeImage ? renderRowsSection(rows) : ""}
    </div>

    ${renderConfirmOverlay()}
  `;

  if (savedScroll) {
    const stageScroll = document.getElementById("stage-scroll");
    if (stageScroll) {
      stageScroll.scrollLeft = savedScroll.left;
      stageScroll.scrollTop = savedScroll.top;
    }
  }

  wireEvents(links);
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

function renderConfirmOverlay(): string {
  if (!pendingConfirmation) return "";
  return `
    <div class="confirm-overlay">
      <div class="confirm-box">
        <p>${escapeHtml(pendingConfirmation.message)}</p>
        <div class="confirm-actions">
          <button id="btn-confirm-no">Cancel</button>
          <button id="btn-confirm-yes">OK</button>
        </div>
      </div>
    </div>
  `;
}

function hotspotHtml(l: CatalogLink): string {
  const editing = l.id === editingLinkId ? " editing" : "";
  return `<div class="hotspot${editing}" data-id="${l.id}" style="top:${l.top}px;left:${l.left}px" title="${escapeHtml(l.url)} — drag to reposition, click to edit">${escapeHtml(l.name)}</div>`;
}

function renderLinkForm(links: CatalogLink[]): string {
  // One option per distinct url already on this image — for pointing a new
  // hotspot at a part that's already drawn elsewhere (same bolt, another spot).
  const reusable = Array.from(new Map(links.map((l) => [l.url, l])).values());
  return `
    <section>
      <h2>New link (hotspot)</h2>
      ${
        pendingHotspot
          ? `<p class="hint">Position: top=${pendingHotspot.top}, left=${pendingHotspot.left}</p>
             <form id="form-link">
               ${
                 reusable.length > 0
                   ? `<div class="field"><label>Same part as an existing hotspot? (optional)</label>
                        <select id="reuse-link-select">
                          <option value="">— new part —</option>
                          ${reusable.map((l) => `<option value="${escapeHtml(l.url)}" data-name="${escapeHtml(l.name)}">${escapeHtml(l.name)} (${escapeHtml(l.url)})</option>`).join("")}
                        </select>
                      </div>`
                   : ""
               }
               <div class="field"><label>Link name</label><input name="name" required /></div>
               <div class="field"><label>Address (url)</label><input name="url" required /></div>
               <button type="submit">Add link</button>
             </form>`
          : `<p class="hint">Click on the image to place a hotspot.</p>`
      }
    </section>
  `;
}

function renderEditLinkForm(link: CatalogLink | null): string {
  if (!link) return "";
  return `
    <section>
      <h2>Edit link</h2>
      <p class="hint">Position: top=${link.top}, left=${link.left} (drag the hotspot on the image to move it)</p>
      <form id="form-edit-link">
        <div class="field"><label>Link name</label><input name="name" value="${escapeHtml(link.name)}" required /></div>
        <div class="field"><label>Address (url), unique across the whole catalog</label><input name="url" value="${escapeHtml(link.url)}" required /></div>
        <div style="display:flex; gap:0.5rem; align-items:center">
          <button type="submit">Save changes</button>
          <button type="button" id="btn-cancel-edit">Cancel</button>
          <button type="button" id="btn-delete-link" style="margin-left:auto; color:#b91c1c; border-color:#b91c1c">Delete</button>
        </div>
      </form>
    </section>
  `;
}

function renderLinksSection(links: CatalogLink[], editingLinkId: number | null): string {
  return `
    <section>
      <h2>Links on this image (${links.length})</h2>
      <table>
        <thead><tr><th>Name</th><th>URL</th></tr></thead>
        <tbody>
          ${links
            .map(
              (l) =>
                `<tr data-link-id="${l.id}" class="clickable-row${l.id === editingLinkId ? " editing" : ""}"><td>${escapeHtml(l.name)}</td><td>${escapeHtml(l.url)}</td></tr>`,
            )
            .join("")}
        </tbody>
      </table>
      <p class="hint">Click a row (or its hotspot on the image) to edit or delete it.</p>
    </section>
  `;
}

function renderRowForm(availableLinks: CatalogLink[]): string {
  return `
    <section>
      <h2>New table row</h2>
      ${
        availableLinks.length === 0
          ? `<p class="hint">Add a link with no data row first.</p>`
          : `<form id="form-row">
               <div class="field"><label>URL (matches a link)</label>
                 <select name="url">${availableLinks.map((l) => `<option value="${escapeHtml(l.url)}">${escapeHtml(l.url)} (${escapeHtml(l.name)})</option>`).join("")}</select>
               </div>
               <div class="field"><label>Name</label><input name="name" /></div>
               <div class="field"><label>SKU</label><input name="sku" /></div>
               <div class="field"><label>Description</label><input name="description" /></div>
               <div class="field"><label>Extra characteristics (JSON)</label><textarea name="extra" rows="3" placeholder='{"weight": "2.3 kg"}'></textarea></div>
               <button type="submit">Add row</button>
             </form>`
      }
    </section>
  `;
}

function renderRowsSection(rows: ReturnType<typeof listRowsForImage>): string {
  return `
    <section>
      <h2>Table (${rows.length} rows)</h2>
      <table>
        <thead><tr><th>URL</th><th>Name</th><th>SKU</th></tr></thead>
        <tbody>
          ${rows.map((r) => `<tr><td>${escapeHtml(r.url)}</td><td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.sku)}</td></tr>`).join("")}
        </tbody>
      </table>
    </section>
  `;
}

function wireEvents(links: CatalogLink[]) {
  document.getElementById("btn-confirm-yes")?.addEventListener("click", () => {
    const cb = pendingConfirmation?.onConfirm;
    pendingConfirmation = null;
    cb?.();
  });
  document.getElementById("btn-confirm-no")?.addEventListener("click", () => {
    pendingConfirmation = null;
    render();
  });

  document.getElementById("btn-theme")?.addEventListener("click", () => {
    toggleTheme();
    render();
  });

  document.getElementById("btn-new")?.addEventListener("click", actionNewCatalog);

  const fileOpen = document.getElementById("file-open") as HTMLInputElement;
  document.getElementById("btn-open")?.addEventListener("click", () => void actionOpenCatalogClicked(fileOpen));
  fileOpen.addEventListener("change", () => {
    const file = fileOpen.files?.[0];
    if (file) void file.arrayBuffer().then((buf) => openCatalogFromBytes(new Uint8Array(buf), null));
  });

  document.getElementById("btn-save")?.addEventListener("click", () => void actionSave());
  document.getElementById("btn-export")?.addEventListener("click", actionExportCatalog);

  const fileImage = document.getElementById("file-image") as HTMLInputElement;
  document.getElementById("btn-add-image")?.addEventListener("click", () => fileImage.click());
  fileImage.addEventListener("change", () => {
    const file = fileImage.files?.[0];
    if (file) void actionAddImage(file);
  });

  document.querySelectorAll<HTMLLIElement>(".panel-images li[data-id]").forEach((li) => {
    li.addEventListener("click", () => actionSelectImage(Number(li.dataset.id)));
  });

  document.getElementById("btn-zoom-in")?.addEventListener("click", () => actionSetZoom(zoom * 1.25));
  document.getElementById("btn-zoom-out")?.addEventListener("click", () => actionSetZoom(zoom / 1.25));
  document.getElementById("btn-zoom-reset")?.addEventListener("click", () => actionSetZoom(1));

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
    stageImg.addEventListener("mousedown", (evt) => startStageInteraction(evt, stageImg, stageScroll));
  }

  if (stageImg) {
    document.querySelectorAll<HTMLDivElement>(".hotspot[data-id]").forEach((el) => {
      const link = links.find((l) => l.id === Number(el.dataset.id));
      if (link) el.addEventListener("mousedown", (evt) => startDragHotspot(evt, link, el, stageImg));
    });
  }

  document.querySelectorAll<HTMLTableRowElement>("tr[data-link-id]").forEach((tr) => {
    tr.addEventListener("click", () => actionEditLink(Number(tr.dataset.linkId)));
  });

  const linkForm = document.getElementById("form-link");
  if (linkForm) {
    const nameInput = linkForm.querySelector<HTMLInputElement>('input[name="name"]');
    const urlInput = linkForm.querySelector<HTMLInputElement>('input[name="url"]');
    const reuseSelect = document.getElementById("reuse-link-select") as HTMLSelectElement | null;
    let urlEditedByHand = false;
    urlInput?.addEventListener("input", () => {
      urlEditedByHand = true;
    });
    nameInput?.addEventListener("input", () => {
      if (urlInput && !urlEditedByHand) urlInput.value = `#${slugify(nameInput.value)}`;
    });
    reuseSelect?.addEventListener("change", () => {
      const option = reuseSelect.selectedOptions[0];
      if (!option || !option.value) return; // "— new part —"
      if (nameInput) nameInput.value = option.dataset.name ?? "";
      if (urlInput) {
        urlInput.value = option.value;
        urlEditedByHand = true; // stop the auto-slug from overwriting the reused url
      }
    });
  }
  linkForm?.addEventListener("submit", (evt) => {
    evt.preventDefault();
    const fd = new FormData(evt.target as HTMLFormElement);
    actionAddLink(String(fd.get("name") ?? ""), String(fd.get("url") ?? ""));
  });

  document.getElementById("form-edit-link")?.addEventListener("submit", (evt) => {
    evt.preventDefault();
    const fd = new FormData(evt.target as HTMLFormElement);
    actionUpdateLink(String(fd.get("name") ?? ""), String(fd.get("url") ?? ""));
  });
  document.getElementById("btn-cancel-edit")?.addEventListener("click", actionCancelEditLink);
  document.getElementById("btn-delete-link")?.addEventListener("click", actionDeleteLink);

  document.getElementById("form-row")?.addEventListener("submit", (evt) => {
    evt.preventDefault();
    const fd = new FormData(evt.target as HTMLFormElement);
    actionAddRow(
      String(fd.get("url") ?? ""),
      String(fd.get("name") ?? ""),
      String(fd.get("sku") ?? ""),
      String(fd.get("description") ?? ""),
      String(fd.get("extra") ?? ""),
    );
  });
}

void boot();

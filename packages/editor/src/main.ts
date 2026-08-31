import "./style.css";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import {
  addImage,
  addLink,
  addRow,
  CATALOG_FILE_EXTENSION,
  collectExtraKeys,
  collectFolders,
  createEmptyCatalog,
  DEFAULT_CART_CHECKOUT_BASE_URL,
  DEFAULT_CART_ID_PATTERN,
  DEFAULT_CART_ITEM_PARAM,
  deleteImage,
  deleteLink,
  deleteRow,
  detectFileKind,
  exportCatalog,
  findLinkConflicts,
  groupImagesByFolder,
  importSchCatalog,
  initSqlite,
  listAllRows,
  listImages,
  listLinksForImage,
  listRowsForImage,
  openCatalog,
  readMeta,
  resolveInitialTheme,
  applyTheme,
  currentTheme,
  toggleTheme,
  findRowByUrl,
  rowExistsForUrl,
  searchRows,
  setUpPwa,
  updateImage,
  updateLink,
  updateLinkPosition,
  updateRow,
  updateStoreSettings,
  type CatalogImage,
  type CatalogLink,
  type CatalogRow,
  type Database,
  type LinkConflict,
  type SearchField,
  type SqlJsStatic,
} from "@ecm/shared";
import { slugify } from "./slugify";
import { CollabConnection, createRoom, downloadSnapshot, listOpsSince, type CollabStatus, type Op } from "./collab";
import { clearOutbox, loadOutbox, saveOutbox, type QueuedOp } from "./collabStore";

// Applied before the first render so there's no flash of the wrong theme.
applyTheme(resolveInitialTheme());

// Service Worker registration + the standalone-aware GoatCounter gate —
// see packages/shared/src/pwa.ts.
setUpPwa();

const app = document.getElementById("app")!;

const CATALOG_PICKER_TYPE: FilePickerAcceptType = {
  description: "Electronic catalog",
  // .sch: the previous-generation desktop app's format — opened read-write
  // here too, but always as an unattached copy (see openCatalogFromBytes).
  accept: { "application/x-sqlite3": [`.${CATALOG_FILE_EXTENSION}`, ".sch"] },
};

// There's no maintainer-hosted default collab server — self-hosting is the
// only model (see the project's collaboration-hosting design notes). This
// defaults to the standalone @ecm/collab-server app's own default local
// port, so a fresh install of both just works together with nothing to
// configure; "Server settings…" lets a person point at a different address
// (their own machine's tunnel, or someone else's, from a shared link's
// `server=` param — see below).
const DEFAULT_COLLAB_SERVER_URL = "http://127.0.0.1:8787";
let collabServerUrl = loadCollabServerUrl();

function loadCollabServerUrl(): string {
  try {
    return localStorage.getItem("ecm-editor-collab-server-url") || DEFAULT_COLLAB_SERVER_URL;
  } catch {
    return DEFAULT_COLLAB_SERVER_URL; // localStorage unavailable (privacy mode, etc.)
  }
}

function saveCollabServerUrl(url: string) {
  collabServerUrl = url;
  try {
    localStorage.setItem("ecm-editor-collab-server-url", url);
  } catch {
    // Still applies for this session, just won't persist across a reload.
  }
}

let SQL: SqlJsStatic;
let db: Database | null = null;
let activeImageId: number | null = null;
let pendingHotspot: { top: number; left: number } | null = null;
let editingLinkId: number | null = null;
let editingRowId: number | null = null;
let zoom = 1;
let statusMessage = "";
// Set when the catalog was opened (or first saved) via the File System
// Access API, so subsequent Save calls can overwrite it in place.
let openedFileHandle: FileSystemFileHandle | null = null;
// Size + last-modified time of openedFileHandle's contents as of the last
// time *we* read or wrote it — cheap metadata, not a hash, so it stays fast
// even on a multi-hundred-MB catalog. Save compares this against the file's
// current stamp right before overwriting, so a second editor's save (or
// anyone else touching the same file) gets caught instead of silently lost.
// Null whenever there's nothing on disk yet to compare against.
let openedFileStamp: { size: number; lastModified: number } | null = null;
// ---------- live collaboration (Phase 2) ----------
// Non-null exactly while this tab is connected to a shared session. While
// it's set, this tab's own edits are sent to the room (see
// applyAndBroadcast below) instead of only ever landing in this tab.
let collab: CollabConnection | null = null;
let collabRoomId: string | null = null;
let collabStatus: CollabStatus = "disconnected";
// Only meaningful right after actionStartCollaboration() — shown once so
// it can be copied, not persisted or shown again after a reload (deleting
// a room isn't built yet — that's Phase 5 — so there's nowhere to use it
// again this early anyway).
let collabOwnerToken: string | null = null;
// The highest op seq applied so far — lets a fresh join or reconnect ask
// the room for only what it's missing (see connectAndSync).
let lastAppliedSeq = 0;
// ---------- reconnect / offline outbox (Phase 3) ----------
// Edits made while collabStatus isn't "connected" — applied locally right
// away like any edit (see applyAndBroadcast), but held here instead of
// sent, until a (re)connection is caught up enough to check each one for a
// real conflict before resending it (see drainOutbox). Persisted to
// IndexedDB (collabStore.ts) so it survives a reload, not just a blip.
let outbox: QueuedOp[] = [];
// Set only on an *unexpected* drop (never on an explicit Leave — see
// actionLeaveCollaboration), so a retry doesn't fight a deliberate exit.
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
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
// Same idea as pendingConfirmation above, but for a plain "this isn't
// allowed, here's why" notice with nothing to confirm — see notify().
let pendingNotice: string | null = null;
// "Copy remote catalog…" dialog state — fetches a catalog hosted at a URL
// and opens it with no file handle attached (openCatalogFromBytes(bytes,
// null)), so it behaves exactly like a freshly-imported copy: editable
// right away, but Save prompts for a location the first time, same as it
// would for any catalog that didn't come from a local file.
let remoteDialogOpen = false;
let remoteUrlValue = "";
let remoteLoading = false;
let remoteError: string | null = null;
// Reverse search — a catalog-wide dropdown (not scoped to the active image),
// see packages/shared/src/search.ts. Results are refreshed by directly
// patching #search-results on every keystroke rather than a full render(),
// so the search input never loses focus mid-type.
let searchOpen = false;
let searchQuery = "";
let searchField: SearchField = "all";
// "Store settings" dialog state — edits the catalog's store_url/cart_mode
// meta (see db.ts updateStoreSettings), which the viewer reads to decide how
// its Buy button behaves. Opened fresh from the catalog's current meta each
// time (not kept live in sync with it), same lifecycle as the remote dialog.
let storeSettingsOpen = false;
let storeSettingsUrlValue = "";
let storeSettingsCartMode: "accumulate" | "instant" = "accumulate";
// "Advanced" cart-URL recipe fields — how a combined checkout URL is built
// from several rows' buy_url values (see schema.ts DEFAULT_CART_ID_PATTERN).
// Default to Payhip's own scheme, same as an unset catalog falls back to.
let storeSettingsCartIdPattern = DEFAULT_CART_ID_PATTERN;
let storeSettingsCartItemParam = DEFAULT_CART_ITEM_PARAM;
let storeSettingsCartCheckoutBaseUrl = DEFAULT_CART_CHECKOUT_BASE_URL;

// "Server settings" dialog state — which self-hosted @ecm/collab-server
// address this tab uses for Start/Join collaboration (see collabServerUrl
// above). An app-level preference, not catalog-scoped, so unlike Store
// settings it isn't reloaded from anything each time it's opened — it just
// edits the same persisted value directly.
let serverSettingsOpen = false;
let serverSettingsUrlValue = "";

// Which single panel is shown below the mobile breakpoint (see .mobile-tabs
// / #app[data-mobile-tab] in style.css) — irrelevant above it, where all
// three panels sit side by side per the desktop grid regardless of this
// value. Starts on "images" so a freshly opened catalog shows its image
// list first, same as the desktop layout's left panel. Same pattern as the
// viewer's mobileTab (packages/viewer/src/viewerEngine.ts).
let mobileTab: "images" | "stage" | "inspector" = "images";

// ---------- resizable layout (side panels + table columns) ----------
// User-adjustable, remembered per-browser via localStorage (same pattern as
// theme.ts) — these are editor-local UI preferences, not part of the
// catalog file itself, so they don't round-trip through Save/Export.

const PANEL_WIDTH_LIMITS = { min: 160, max: 640 };
let imagesPanelWidth = loadPanelWidth("ecm-editor-images-width", 220);
let inspectorPanelWidth = loadPanelWidth("ecm-editor-inspector-width", 320);
applyPanelWidths(); // before the first render — avoids a flash of the default width, same reasoning as applyTheme() above

function loadPanelWidth(key: string, fallback: number): number {
  try {
    const raw = Number(localStorage.getItem(key));
    if (Number.isFinite(raw) && raw >= PANEL_WIDTH_LIMITS.min && raw <= PANEL_WIDTH_LIMITS.max) return raw;
  } catch {
    // localStorage unavailable (privacy mode, etc.) — fall back to the default.
  }
  return fallback;
}

// Applied as CSS custom properties directly on #app (not #app.innerHTML, so
// it survives render()'s wholesale innerHTML rebuild without re-running).
function applyPanelWidths() {
  app.style.setProperty("--images-w", `${imagesPanelWidth}px`);
  app.style.setProperty("--inspector-w", `${inspectorPanelWidth}px`);
}

type ColTableKey = "links" | "rows";
const COL_WIDTH_LIMITS = { min: 40, max: 400 };
const DEFAULT_COL_WIDTHS: Record<ColTableKey, number[]> = {
  links: [110, 130], // Name, URL
  rows: [60, 150, 80], // URL, Name, SKU
};
const colWidths: Record<ColTableKey, number[]> = {
  links: loadColWidths("links"),
  rows: loadColWidths("rows"),
};

function loadColWidths(key: ColTableKey): number[] {
  const fallback = DEFAULT_COL_WIDTHS[key];
  try {
    const raw = localStorage.getItem(`ecm-editor-${key}-col-widths`);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length === fallback.length && parsed.every((n) => typeof n === "number" && n > 0)) {
        return parsed;
      }
    }
  } catch {
    // malformed or unavailable storage — use the default widths instead.
  }
  return [...fallback];
}

function saveColWidths(key: ColTableKey) {
  try {
    localStorage.setItem(`ecm-editor-${key}-col-widths`, JSON.stringify(colWidths[key]));
  } catch {
    // Width still applies for this session, just won't persist.
  }
}

function colTableTotalWidth(key: ColTableKey): number {
  return colWidths[key].reduce((a, b) => a + b, 0);
}

/**
 * Drags one of the two panel dividers (images↔stage, stage↔inspector).
 * Follows the same "poke style properties directly on mousemove, skip
 * render()" pattern as hotspot dragging and the placement crosshair — a
 * full re-render on every mousemove would be wasteful and can lose focus.
 */
function startPanelResize(evt: MouseEvent, side: "images" | "inspector") {
  evt.preventDefault();
  const divider = evt.currentTarget as HTMLElement;
  const startX = evt.clientX;
  const startWidth = side === "images" ? imagesPanelWidth : inspectorPanelWidth;
  divider.classList.add("dragging");

  function onMove(moveEvt: MouseEvent) {
    const dx = moveEvt.clientX - startX;
    // The inspector sits on the right, so dragging its divider left (dx < 0) should grow it.
    const raw = side === "images" ? startWidth + dx : startWidth - dx;
    const width = Math.min(PANEL_WIDTH_LIMITS.max, Math.max(PANEL_WIDTH_LIMITS.min, raw));
    if (side === "images") imagesPanelWidth = width;
    else inspectorPanelWidth = width;
    applyPanelWidths();
  }
  function onUp() {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    divider.classList.remove("dragging");
    try {
      localStorage.setItem(side === "images" ? "ecm-editor-images-width" : "ecm-editor-inspector-width", String(side === "images" ? imagesPanelWidth : inspectorPanelWidth));
    } catch {
      // Width still applies for this session, just won't persist.
    }
  }
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

/** Drags a column-resize handle in the "Links on this image" or "Table (N rows)" list. */
function startColumnResize(evt: MouseEvent, tableKey: ColTableKey, colIndex: number) {
  evt.preventDefault();
  evt.stopPropagation();
  const handle = evt.currentTarget as HTMLElement;
  const startX = evt.clientX;
  const startWidth = colWidths[tableKey][colIndex] ?? COL_WIDTH_LIMITS.min;
  handle.classList.add("dragging");

  function onMove(moveEvt: MouseEvent) {
    const width = Math.min(COL_WIDTH_LIMITS.max, Math.max(COL_WIDTH_LIMITS.min, startWidth + (moveEvt.clientX - startX)));
    colWidths[tableKey][colIndex] = width;
    const table = document.querySelector<HTMLTableElement>(`table[data-col-key="${tableKey}"]`);
    const col = table?.querySelectorAll("col")[colIndex] as HTMLElement | undefined;
    if (col) col.style.width = `${width}px`;
    if (table) table.style.width = `${colTableTotalWidth(tableKey)}px`;
  }
  function onUp() {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    handle.classList.remove("dragging");
    saveColWidths(tableKey);
  }
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

function askConfirm(message: string, onConfirm: () => void) {
  pendingConfirmation = { message, onConfirm };
  render();
}

function notify(message: string) {
  pendingNotice = message;
  render();
}

// `?src=<url>` opens that catalog automatically on load, same idea as the
// viewer's own `?src=` (see packages/shared/src/viewerEngine.ts) — used by
// the landing page's demo links to jump straight into editing a demo, not
// just viewing it. Unlike the viewer, the editor never syncs this back into
// the address bar: matches "Copy remote catalog…"'s existing semantics
// (an unattached copy to edit, not a live link back to the source).
const initialSrcParam = new URLSearchParams(location.search).get("src");
// `?collab=<roomId>` joins a shared session automatically on load — the
// link actionStartCollaboration() hands the initiator to pass along.
const initialCollabParam = new URLSearchParams(location.search).get("collab");
// `&server=<url>` rides along with it — the self-hosted server that room
// actually lives on isn't a fixed address the way a maintainer-hosted
// default would be, so the link has to carry it. Adopted as this tab's own
// Server settings too (not just used for this one join) so a later
// reconnect or reload of this same tab still knows where to look.
const initialCollabServerParam = new URLSearchParams(location.search).get("server");

async function boot() {
  app.innerHTML = `<p style="padding:1rem">Loading SQLite (sql.js)…</p>`;
  SQL = await initSqlite(wasmUrl);
  if (initialCollabParam) {
    if (initialCollabServerParam) saveCollabServerUrl(initialCollabServerParam);
    await actionJoinCollaboration(initialCollabParam);
  } else if (initialSrcParam) {
    await loadInitialFromUrl(initialSrcParam);
  } else {
    render();
  }
}

async function loadInitialFromUrl(url: string) {
  app.innerHTML = `<p style="padding:1rem">Loading catalog…</p>`;
  let bytes: Uint8Array;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    statusMessage = `Could not load "${url}": ${(err as Error).message}`;
    render();
    return;
  }
  await openCatalogFromBytes(bytes, null, baseName(new URL(url, location.href).pathname));
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
  editingRowId = null;
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
  mobileTab = "images"; // fresh catalog — start from the image list, same as opening one
  setStatus(`Created new catalog "${name}".`);
}

/**
 * Opens either format transparently — sniffed from the file's actual tables,
 * not its extension (see detectFileKind), matching the viewer. A legacy
 * `.sch` file is converted in-memory into a fresh catalog in *our* schema
 * (importSchCatalog) and always treated as an unattached copy: even if the
 * caller has a real writable handle to the .sch file (picked via the File
 * System Access API), it's discarded — Save must never write our schema
 * back into the user's original legacy file. It behaves exactly like "Copy
 * remote catalog…": editable right away, first Save prompts for a location.
 */
async function openCatalogFromBytes(
  bytes: Uint8Array,
  handle: FileSystemFileHandle | null,
  sourceName = "Legacy catalog",
  fileStamp: { size: number; lastModified: number } | null = null,
) {
  // Opening a different local file while still connected to a shared
  // session for a *different* catalog would silently keep sending that
  // session edits meant for this new one — leave it instead of guessing.
  if (collab) actionLeaveCollaboration();
  try {
    const kind = detectFileKind(SQL, bytes);
    if (kind === "legacy-sch") {
      setStatus("Converting legacy .sch catalog… this can take a moment for large files.");
      await new Promise((resolve) => setTimeout(resolve, 0));
      const result = await importSchCatalog(SQL, bytes, sourceName);
      db = result.db;
      activeImageId = currentImages()[0]?.id ?? null;
      openedFileHandle = null;
      openedFileStamp = null;
      resetTransientEditState();
      mobileTab = "images"; // fresh catalog — start from the image list
      setStatus(
        `Converted legacy catalog "${sourceName}" (${result.imageCount} image${result.imageCount === 1 ? "" : "s"}${result.skippedDiagrams ? `, ${result.skippedDiagrams} skipped` : ""}). Save to keep it as a .${CATALOG_FILE_EXTENSION} file.`,
      );
    } else {
      db = openCatalog(SQL, bytes);
      const meta = readMeta(db);
      activeImageId = currentImages()[0]?.id ?? null;
      openedFileHandle = handle;
      openedFileStamp = handle ? fileStamp : null;
      resetTransientEditState();
      mobileTab = "images"; // fresh catalog — start from the image list
      setStatus(`Opened catalog "${meta.catalogName}".`);
    }
  } catch (err) {
    setStatus(`Could not open file: ${(err as Error).message}`);
  }
}

function baseName(nameOrPath: string): string {
  const last = nameOrPath.split(/[\\/]/).pop() || nameOrPath;
  return last.replace(/\.[^./]+$/, "") || last;
}

async function actionOpenCatalogClicked(fallbackInput: HTMLInputElement) {
  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({ types: [CATALOG_PICKER_TYPE] });
      if (!handle) return;
      const file = await handle.getFile();
      await openCatalogFromBytes(new Uint8Array(await file.arrayBuffer()), handle, baseName(file.name), {
        size: file.size,
        lastModified: file.lastModified,
      });
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

function actionOpenRemoteDialog() {
  remoteDialogOpen = true;
  remoteUrlValue = "";
  remoteError = null;
  render();
}

function actionCancelRemoteDialog() {
  if (remoteLoading) return; // let an in-flight fetch settle rather than leaving stale state
  remoteDialogOpen = false;
  render();
}

async function actionSubmitRemoteDialog() {
  if (remoteLoading) return;
  const url = remoteUrlValue.trim();
  if (!url) return;
  remoteLoading = true;
  remoteError = null;
  render();

  let bytes: Uint8Array;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    // Keep the dialog open and show the error right by the field — closing
    // it and leaving only a small status hint in the toolbar corner reads
    // as "nothing happened" (see viewer's identical fix for the same issue).
    remoteLoading = false;
    remoteError = (err as Error).message;
    render();
    return;
  }
  remoteLoading = false;
  remoteDialogOpen = false;
  // No file handle — a "copy", not opened in place — same as any .sch import.
  await openCatalogFromBytes(bytes, null, baseName(new URL(url, location.href).pathname));
}

function actionOpenStoreSettings() {
  if (!db) return;
  const meta = readMeta(db);
  storeSettingsUrlValue = meta.storeUrl;
  storeSettingsCartMode = meta.cartMode;
  storeSettingsCartIdPattern = meta.cartIdPattern;
  storeSettingsCartItemParam = meta.cartItemParam;
  storeSettingsCartCheckoutBaseUrl = meta.cartCheckoutBaseUrl;
  storeSettingsOpen = true;
  render();
}

function actionCancelStoreSettings() {
  storeSettingsOpen = false;
  render();
}

function actionSubmitStoreSettings() {
  if (!db) return;
  applyAndBroadcast("updateStoreSettings", updateStoreSettings, {
    storeUrl: storeSettingsUrlValue.trim(),
    cartMode: storeSettingsCartMode,
    cartIdPattern: storeSettingsCartIdPattern.trim() || DEFAULT_CART_ID_PATTERN,
    cartItemParam: storeSettingsCartItemParam.trim() || DEFAULT_CART_ITEM_PARAM,
    cartCheckoutBaseUrl: storeSettingsCartCheckoutBaseUrl.trim() || DEFAULT_CART_CHECKOUT_BASE_URL,
  });
  storeSettingsOpen = false;
  setStatus("Updated store settings.");
}

function actionOpenServerSettings() {
  serverSettingsUrlValue = collabServerUrl;
  serverSettingsOpen = true;
  render();
}

function actionCancelServerSettings() {
  serverSettingsOpen = false;
  render();
}

function actionSubmitServerSettings() {
  saveCollabServerUrl(serverSettingsUrlValue.trim() || DEFAULT_COLLAB_SERVER_URL);
  serverSettingsOpen = false;
  setStatus(`Collaboration server set to ${collabServerUrl}.`);
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
      openedFileStamp = null; // nothing of ours on disk yet to compare against
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setStatus(`Could not choose a save location: ${(err as Error).message}`);
      }
      return;
    }
  }

  if (openedFileHandle) {
    if (openedFileStamp && (await fileChangedOnDisk(openedFileHandle, openedFileStamp))) {
      askConfirm(
        `"${openedFileHandle.name}" changed since you opened it — probably saved by someone else in the meantime. Overwrite it with your changes anyway? ("Export a copy…" keeps both instead of choosing.)`,
        () => void writeToOpenedHandle(bytes),
      );
      return;
    }
    await writeToOpenedHandle(bytes);
    return;
  }

  downloadBytes(bytes);
  setStatus('Downloaded a copy (this browser can\'t save in place — "Open catalog…" it again next time).');
}

/**
 * True if the file's size or modification time no longer match what we last
 * read or wrote — cheap metadata only (File System Access API gives this
 * without touching content), so it stays fast even on a multi-hundred-MB
 * catalog. Not a byte-for-byte guarantee, but enough to catch the case that
 * actually happens: someone else's Save landing while we were still editing.
 */
async function fileChangedOnDisk(
  handle: FileSystemFileHandle,
  stamp: { size: number; lastModified: number },
): Promise<boolean> {
  try {
    const current = await handle.getFile();
    return current.size !== stamp.size || current.lastModified !== stamp.lastModified;
  } catch {
    return false; // can't check right now — proceed rather than block Save entirely
  }
}

/** Writes to openedFileHandle and refreshes openedFileStamp to match what's now on disk. */
async function writeToOpenedHandle(bytes: Uint8Array) {
  if (!openedFileHandle) return;
  try {
    const writable = await openedFileHandle.createWritable();
    await writable.write(bytes as BufferSource);
    await writable.close();
    const saved = await openedFileHandle.getFile();
    openedFileStamp = { size: saved.size, lastModified: saved.lastModified };
    setStatus(`Saved "${openedFileHandle.name}".`);
  } catch (err) {
    setStatus(`Could not save: ${(err as Error).message}`);
  }
}

// ---------- actions: live collaboration ----------

/**
 * Every @ecm/shared mutation an operation is allowed to name — deliberately
 * a fixed allowlist keyed by name, not "call whatever function string
 * arrives", since the room relays whatever any connected tab sends.
 * Each one is the *exact* function already used for local edits elsewhere
 * in this file (see the "actions: images"/"hotspots"/etc. sections below)
 * — that reuse is the whole point (see room.ts's class doc on the server).
 */
const OP_HANDLERS: Record<string, (db: Database, ...args: never[]) => unknown> = {
  addImage,
  updateImage,
  deleteImage,
  addLink,
  updateLink,
  deleteLink,
  updateLinkPosition,
  addRow,
  updateRow,
  deleteRow,
  updateStoreSettings,
};

/**
 * Calls one of the functions above and shares the same call with the room
 * — sent immediately if connected, queued in the outbox otherwise (see
 * shareOp). `db` is deliberately not part of what's shared — every tab
 * (including the one that receives this later) supplies its own local one.
 */
function applyAndBroadcast<Args extends unknown[], R>(fnName: string, fn: (db: Database, ...args: Args) => R, ...args: Args): R {
  const result = fn(db as Database, ...args);
  shareOp(fnName, args);
  return result;
}

/**
 * Same idea, for addImage/addLink/addRow specifically: they hand back a
 * new row's id (assigned by SQLite's autoincrement locally), and a later
 * op might target that exact row (an edit, a delete) — so every other tab
 * has to land it at the *same* id, not its own independently-assigned one.
 * The broadcast args carry the id explicitly; addImage/addLink/addRow all
 * accept it as `input.id` to insert at a specific id instead of a fresh one.
 *
 * While in a shared session, that id is a large random number, not this
 * tab's own next autoincrement value — a real bug found by actually
 * testing the offline case: two tabs both offline, each adding a record
 * around the same time, independently compute the *same* next id from
 * their own copy of the database (same starting point, same "next free
 * id" arithmetic) — a real primary-key collision once they reconnect and
 * try to apply each other's add. Outside a shared session this is unused
 * and plain autoincrement applies, same as ever.
 */
function applyAddAndBroadcast<Input extends { id?: number }>(
  fnName: string,
  fn: (db: Database, input: Input) => number,
  input: Input,
): number {
  if (collabRoomId && input.id === undefined) {
    input = { ...input, id: Math.floor(Math.random() * 0x7fffffff) + 1 };
  }
  const id = fn(db as Database, input);
  shareOp(fnName, [{ ...input, id }]);
  return id;
}

/**
 * Sends this tab's own edit to the room right away if connected; otherwise
 * queues it in the outbox to resend (or flag as a conflict) once a
 * connection is caught up enough to check it — see drainOutbox(). A no-op
 * outside any shared session at all (collabRoomId null): plain local
 * editing was never touched by any of this.
 */
function shareOp(fn: string, args: unknown[]) {
  if (!collabRoomId) return;
  if (collab?.status === "connected") {
    collab.sendOp(fn, args);
  } else {
    outbox.push({ fn, args });
    void saveOutbox(collabRoomId, outbox);
    updateCollabStatusDisplay(); // reflects the new pending count without disturbing whatever else is on screen
  }
}

/**
 * The record one op targets, for drainOutbox()'s conflict check. Null for
 * most adds — a brand-new record generally can't collide with one that
 * already existed. addRow is the one exception: rows.url is unique, and
 * two people offline at once, each filling in the *same* still-bare
 * hotspot's data, both call addRow for that same url — a real conflict a
 * blind resend doesn't survive (rows.url's uniqueness rejects the second
 * insert). Keyed by url, not id, since that's the field the constraint —
 * and the actual collision — is on.
 */
function opTarget(fn: string, args: unknown[]): string | null {
  switch (fn) {
    case "updateRow":
    case "deleteRow":
      return `rows:${args[0]}`;
    case "updateLink":
    case "deleteLink":
    case "updateLinkPosition":
      return `links:${args[0]}`;
    case "updateImage":
    case "deleteImage":
      return `images:${args[0]}`;
    case "updateStoreSettings":
      return "storeSettings"; // catalog-wide, not keyed by id
    case "addRow":
      return `rows:url:${(args[0] as { url: string }).url}`;
    default:
      return null;
  }
}

/**
 * Applies one op relayed from someone else (or replayed from the log) —
 * never re-sent, that would echo it right back out.
 *
 * addRow gets special handling: rows.url is unique, and this tab may have
 * *its own* not-yet-sent local row for the same url (both offline at once,
 * both filling in the same still-bare hotspot — the mirror image of what
 * applyQueuedOpAsOverwrite handles for the outbox side). Inserting theirs
 * straight would crash on that uniqueness.
 *
 * A first version of this fix just updated the existing local row's
 * *values* in place, keeping this tab's own id — which is exactly wrong:
 * this tab's row and the other tab's row were independently created with
 * *different* ids, and a later op (an edit, a delete) targets a row by id.
 * Updating in place left every peer privately disagreeing about what id
 * that row actually has — an op that resolved a conflict correctly on the
 * sender's own copy then silently matched nothing on everyone else's,
 * since their `rows` table has no row at that id at all. The fix is to
 * drop this tab's own row and insert theirs — same id everywhere, not
 * just same values — so a later reference to it by id resolves the same
 * way on every connected tab, this tab's own included.
 */
function applyRemoteOp(op: Op) {
  if (op.seq <= lastAppliedSeq) return; // already applied — the join replay and the live buffer can overlap, see connectAndSync
  if (!db) {
    lastAppliedSeq = op.seq;
    return;
  }
  try {
    if (op.fn === "addRow") {
      const input = op.args[0] as Parameters<typeof addRow>[1];
      const existing = findRowByUrl(db, input.url);
      if (existing && existing.id !== input.id) {
        deleteRow(db, existing.id);
        addRow(db, input);
      } else if (!existing) {
        addRow(db, input);
      }
      // existing && existing.id === input.id: already there under the same id — nothing to do.
    } else {
      const handler = OP_HANDLERS[op.fn];
      if (!handler) {
        lastAppliedSeq = op.seq; // unrecognized fn — nothing to apply, but still move past it
        return;
      }
      handler(db, ...(op.args as never[]));
    }
  } catch (err) {
    // A relayed op should never fail against a caught-up copy — surfacing
    // it beats a silently half-applied change, without taking the whole
    // tab down over one bad op. Still counted as "applied" (see below) so
    // a permanently-failing op can't wedge every future op behind it.
    setStatus(`Couldn't apply a change from the shared session: ${(err as Error).message}`);
    lastAppliedSeq = op.seq;
    return;
  }
  lastAppliedSeq = op.seq;
  render();
}

/**
 * Applies one conflicting outbox entry after the person chose "overwrite
 * with mine". Ordinarily that just means reapplying the same op and
 * resending it — but a conflicting addRow can't be reapplied as another
 * addRow: rows.url is unique, and the row that already exists there (the
 * one that "won" the conflict) is *their* row, not the local optimistic
 * one this tab had before the replay overwrote it. So this rewrites it
 * into an updateRow against their row's actual id instead of trying to
 * insert a second row for the same url.
 */
function applyQueuedOpAsOverwrite(queued: QueuedOp) {
  if (!db) return;
  if (queued.fn === "addRow") {
    const input = queued.args[0] as Parameters<typeof addRow>[1];
    const existing = findRowByUrl(db, input.url);
    if (existing) {
      const update = { name: input.name ?? "", sku: input.sku ?? "", description: input.description ?? "", extra: input.extra ?? {} };
      applyAndBroadcast("updateRow", updateRow, existing.id, update);
      return;
    }
    // Their row isn't actually there after all (e.g. it was since deleted) — a normal add is safe again.
  }
  OP_HANDLERS[queued.fn]?.(db, ...(queued.args as never[]));
  shareOp(queued.fn, queued.args); // not collab?.sendOp directly — see drainOutbox's note on why that's unsafe here
}

/**
 * A short, human-readable summary of what one op actually sets — shown
 * side by side ("yours" vs. "current") in the conflict dialog below, since
 * a bare "something conflicts" with no values to compare left no way to
 * tell what's actually different, or judge which one to keep.
 */
function describeOp(fn: string, args: unknown[]): string {
  switch (fn) {
    case "addRow":
    case "updateRow": {
      const input = (fn === "addRow" ? args[0] : args[1]) as { name?: string; sku?: string };
      return `row — name "${input.name || "(empty)"}", SKU "${input.sku || "(empty)"}"`;
    }
    case "deleteRow":
      return "row — deleted";
    case "updateLink": {
      const input = args[1] as { name: string; url: string };
      return `hotspot — name "${input.name}", address "${input.url}"`;
    }
    case "deleteLink":
      return "hotspot — deleted";
    case "updateLinkPosition":
      return `hotspot position — top ${args[1]}, left ${args[2]}`;
    case "updateImage": {
      const input = args[1] as { name: string; folder: string };
      return `image — name "${input.name}"${input.folder ? `, folder "${input.folder}"` : ""}`;
    }
    case "deleteImage":
      return "image — deleted";
    case "updateStoreSettings": {
      const input = args[0] as { storeUrl: string };
      return `store settings — URL "${input.storeUrl}"`;
    }
    default:
      return fn;
  }
}

/**
 * Resends (or flags as a conflict) everything queued while disconnected,
 * now that `elseDidWhileAway` — every op this tab just learned about, from
 * a connect/reconnect's replay — is known. An outbox entry conflicts when
 * something in that list targets the exact same record (see opTarget()):
 * since ops are whole-value sets, not merges, the replay above already
 * landed *their* value in `db` by the time this runs — so the choice is
 * really just "leave their version standing" (Cancel) vs. "put mine back
 * and share it" (OK), not a blind resend that would silently clobber it.
 *
 * All conflicts are batched into one confirm dialog, not one per entry —
 * pendingConfirmation is a single slot (see askConfirm), so firing several
 * in a row would silently overwrite all but the last one shown. Each one
 * lists both values (see describeOp) — a real gap the first version of
 * this had: "something conflicts, overwrite it?" with no way to tell what
 * actually differs isn't a real choice.
 *
 * Non-conflicting entries go back through shareOp(), *not* a direct
 * collab.sendOp() — a real bug this surfaced: connectAndSync's REST catch-up
 * call and the WebSocket's own handshake race each other with no ordering
 * guarantee, so the socket can still be mid-handshake (not yet OPEN) right
 * here even though a reconnect is clearly underway. sendOp() alone just
 * drops a message it can't send; shareOp() falls back to re-queuing it
 * instead, so a same-round-trip resend attempt can't silently vanish.
 */
function drainOutbox(elseDidWhileAway: Op[]) {
  if (outbox.length === 0 || !collabRoomId) return;
  const roomId = collabRoomId;
  const toProcess = outbox;
  outbox = []; // shareOp() below re-populates this with anything that couldn't actually be sent this round
  const theirsByTarget = new Map<string, Op>();
  for (const op of elseDidWhileAway) {
    const target = opTarget(op.fn, op.args);
    if (target !== null) theirsByTarget.set(target, op); // last one logged is what's actually showing after the replay above
  }
  const conflicting: { queued: QueuedOp; theirs: Op }[] = [];
  for (const queued of toProcess) {
    const target = opTarget(queued.fn, queued.args);
    const theirs = target !== null ? theirsByTarget.get(target) : undefined;
    if (theirs) {
      conflicting.push({ queued, theirs });
    } else {
      shareOp(queued.fn, queued.args);
    }
  }
  if (conflicting.length > 0) {
    const n = conflicting.length;
    const details = conflicting
      .map(({ queued, theirs }) => `Yours: ${describeOp(queued.fn, queued.args)}\nCurrent: ${describeOp(theirs.fn, theirs.args)}`)
      .join("\n\n");
    askConfirm(
      `While you were disconnected, someone else also changed ${n === 1 ? "something" : `${n} things`} you also edited:\n\n${details}\n\nOverwrite ${n === 1 ? "it" : "them"} with your offline change${n === 1 ? "" : "s"}?`,
      () => {
        for (const { queued } of conflicting) applyQueuedOpAsOverwrite(queued);
        render();
      },
    );
    // Cancel needs no handling — their versions already stand, nothing more to do.
  }
  void saveOutbox(roomId, outbox); // reflects whatever's actually left — empty in the common case
  updateCollabStatusDisplay();
}

/**
 * Opens the live connection and brings this tab's copy fully up to date —
 * used right after creating a room, right after joining one, and again on
 * every reconnect after an unexpected drop.
 *
 * Ordering note: CollabConnection starts delivering messages the moment
 * it's constructed, so buffering from construction (not from some later
 * "connected" event) is what makes this gap-free — anything logged before
 * this tab even connects is necessarily covered by the listOpsSince() call
 * below (which runs after construction), and anything logged after this
 * tab connects arrives live into `pending` either way. There's no ordering
 * requirement between the two calls for that to hold.
 */
async function connectAndSync(roomId: string) {
  const pending: Op[] = [];
  let syncing = true;

  collab = new CollabConnection(
    collabServerUrl,
    roomId,
    (op) => {
      if (syncing) pending.push(op);
      else applyRemoteOp(op);
    },
    (status) => {
      collabStatus = status;
      updateCollabStatusDisplay();
      if (status === "disconnected") scheduleReconnect(roomId);
    },
  );
  collabRoomId = roomId;

  // The socket's own handshake and this REST call have no ordering
  // guarantee otherwise — waiting here is what makes drainOutbox() below
  // safe to assume "connected really means connected", not just "the
  // status flag says so a few milliseconds ahead of the socket itself".
  await collab.waitUntilOpen();

  const missed = await listOpsSince(collabServerUrl, roomId, lastAppliedSeq);
  for (const op of missed) applyRemoteOp(op);
  syncing = false;
  for (const op of pending) applyRemoteOp(op);

  drainOutbox([...missed, ...pending]);
}

/**
 * Retries a dropped connection after a short flat delay — no backoff, kept
 * simple for this phase. Only ever one retry pending at a time, and only
 * while this tab is still supposed to be in `roomId` (actionLeaveCollaboration
 * clears collabRoomId first specifically so this becomes a no-op instead of
 * fighting a deliberate exit).
 */
function scheduleReconnect(roomId: string) {
  if (reconnectTimer !== null) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (collabRoomId === roomId && collabStatus !== "connected") {
      // A retry failing (the server's still down) is the routine, expected
      // case here, not an exceptional one — connectAndSync's REST calls
      // rejecting shouldn't become an unhandled rejection every ~3s while
      // genuinely offline. The next retry is already scheduled by the
      // status callback's own "disconnected" transition either way.
      connectAndSync(roomId).catch(() => {});
    }
  }, 3000);
}

/** Uploads the current catalog as a brand-new shared session and connects to it. */
async function actionStartCollaboration() {
  if (!db) return;
  setStatus("Starting a shared session…");
  try {
    const bytes = exportCatalog(db);
    const room = await createRoom(collabServerUrl, bytes);
    collabOwnerToken = room.ownerToken;
    lastAppliedSeq = 0;
    // So reloading *this* tab re-joins the same room via the same
    // ?collab= boot path a shared link uses, instead of losing it. Carries
    // the server address too — collabShareLink() below is what a colleague
    // actually gets, but this tab's own address bar needs it just as much
    // for its own reload/reconnect to know where to look.
    history.replaceState(null, "", `?collab=${room.roomId}&server=${encodeURIComponent(collabServerUrl)}`);
    await connectAndSync(room.roomId);
    setStatus("Started a shared session — share the link shown below with a colleague.");
  } catch (err) {
    setStatus(collabErrorMessage("start a shared session", err));
  }
}

/** Joins an existing shared session by id — downloads its original snapshot, replays the full history, then catches up via connectAndSync. */
async function actionJoinCollaboration(roomId: string) {
  setStatus("Joining the shared session…");
  try {
    const bytes = await downloadSnapshot(collabServerUrl, roomId);
    db = openCatalog(SQL, bytes);
    activeImageId = currentImages()[0]?.id ?? null;
    openedFileHandle = null;
    openedFileStamp = null;
    collabOwnerToken = null; // only create() hands this out — a joiner never has it
    lastAppliedSeq = 0;
    resetTransientEditState();
    // A previous visit to this same room may have left offline edits
    // queued (e.g. the tab reloaded, or was closed, before reconnecting) —
    // restore them so connectAndSync's drainOutbox() gets a chance to
    // resend (or flag as a conflict) rather than silently losing them.
    outbox = await loadOutbox(roomId);
    await connectAndSync(roomId);
    setStatus("Joined the shared session.");
  } catch (err) {
    setStatus(collabErrorMessage("join that shared session", err));
  }
}

/**
 * A failed create/join is very often just "nothing's listening at
 * collabServerUrl" (the collaboration-server app isn't running, or Server
 * settings still points at the wrong address) rather than an actual server-
 * side rejection — the raw fetch error alone ("Failed to fetch") doesn't
 * tell a non-technical person that. Points them at Server settings instead
 * of just surfacing whatever the underlying error happened to say.
 */
function collabErrorMessage(action: string, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return `Could not ${action} — is the collaboration server running at ${collabServerUrl}? Check ⚙️ Server settings…. (${detail})`;
}

/** Disconnects this tab only — the room itself and everyone else in it are unaffected (deleting a room outright is Phase 5). */
function actionLeaveCollaboration() {
  const roomId = collabRoomId;
  collabRoomId = null; // first, so a reconnect already in flight becomes a no-op
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  collab?.close();
  collab = null;
  collabOwnerToken = null;
  collabStatus = "disconnected";
  outbox = [];
  if (roomId) void clearOutbox(roomId);
  setStatus("Left the shared session — you're back to working locally.");
}

async function actionCopyCollabLink() {
  if (!collabRoomId) return;
  try {
    await navigator.clipboard.writeText(collabShareLink());
    setStatus("Copied the link — share it with whoever you want editing alongside you.");
  } catch {
    setStatus(`Couldn't copy automatically — here's the link: ${collabShareLink()}`);
  }
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
  // Inherit the active image's folder — adding another page while working
  // inside a folder should keep it there, not drop it back to ungrouped.
  const activeFolder = currentImages().find((i) => i.id === activeImageId)?.folder ?? "";
  const id = applyAddAndBroadcast("addImage", addImage, {
    name: file.name,
    mimeType: mimeType ?? file.type,
    imageData: base64,
    width,
    height,
    sortOrder: currentImages().length,
    folder: activeFolder,
  });
  activeImageId = id;
  resetTransientEditState();
  setStatus(`Added image "${file.name}".`);
}

/** Renames the active image and/or moves it into a different (or no) folder. */
function actionUpdateImageMeta() {
  if (!db || activeImageId === null) return;
  const nameInput = document.getElementById("image-name-input") as HTMLInputElement | null;
  const folderInput = document.getElementById("image-folder-input") as HTMLInputElement | null;
  const name = nameInput?.value.trim() || "Untitled image";
  const folder = folderInput?.value.trim() ?? "";
  applyAndBroadcast("updateImage", updateImage, activeImageId, { name, folder });
  setStatus(`Updated "${name}".`);
}

/**
 * Deletes an image — blocked entirely while it still has any hotspot on it
 * (the list's × is disabled for exactly that reason, this is just the
 * defense-in-depth backstop). By the time this runs there's normally
 * nothing else attached, but a row can in rare cases still reference this
 * image without a hotspot of its own (see deleteImage()'s doc comment), so
 * that's called out too when it applies.
 */
function actionDeleteImage(imageId: number) {
  if (!db) return;
  const image = currentImages().find((i) => i.id === imageId);
  const linkCount = listLinksForImage(db, imageId).length;
  if (linkCount > 0) {
    notify(`Can't delete "${image?.name ?? "this image"}" — it still has ${linkCount} hotspot${linkCount === 1 ? "" : "s"} on it.`);
    return;
  }
  const rowCount = listRowsForImage(db, imageId).length;
  const consequence = rowCount ? ` It still has ${rowCount} data row${rowCount === 1 ? "" : "s"} with no hotspot, which go with it.` : "";
  askConfirm(`Delete "${image?.name ?? "this image"}"?${consequence} This can't be undone.`, () => {
    if (!db) return;
    applyAndBroadcast("deleteImage", deleteImage, imageId);
    if (activeImageId === imageId) {
      activeImageId = currentImages()[0]?.id ?? null;
      resetTransientEditState();
    }
    setStatus(`Deleted "${image?.name ?? "image"}".`);
  });
}

function actionSelectImage(id: number) {
  activeImageId = id;
  resetTransientEditState();
  mobileTab = "stage"; // no-op above the mobile breakpoint — see mobileTab's declaration
  render();
}

function actionSetMobileTab(tab: "images" | "stage" | "inspector") {
  mobileTab = tab;
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
      editingRowId = null;
      // Jump to the "New link" form — no-op above the mobile breakpoint,
      // see mobileTab's declaration.
      mobileTab = "inspector";
      render();
    }
  }

  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

/**
 * Precision crosshair for placing a new hotspot — full-height/width guide
 * lines through the exact click point (their intersection already marks it
 * unambiguously, so no separate ring/dot on top), plus a dashed box
 * approximating the label's footprint (see crosshairBoxSize). Inspired by
 * the previous-generation desktop editor's own cursor, found unused in its
 * source tree: E:\_showcase_1\3.LinkMapEditor\...\image\64-left-top-
 * corner-7.png — that one draws a ring at the intersection too, dropped
 * here as redundant once actually tried. Positioned in unscaled image
 * pixels as a child of #stage-inner, same as hotspots themselves, so the
 * zoom transform scales it identically — no separate math needed. Updated
 * by directly poking style properties on mousemove rather than calling
 * render(), since that fires far too often for a full re-render.
 */
function showCrosshair(x: number, y: number) {
  const h = document.getElementById("crosshair-h");
  const v = document.getElementById("crosshair-v");
  const b = document.getElementById("crosshair-box");
  if (h) {
    h.style.display = "block";
    h.style.top = `${y}px`;
  }
  if (v) {
    v.style.display = "block";
    v.style.left = `${x}px`;
  }
  if (b) {
    // Just a point doesn't say how much room the label itself will take —
    // approximate its footprint from an existing hotspot on this image
    // (badge width follows its text, so this is usually a good guess for
    // "another one like it"), falling back to a generic size on an image
    // that doesn't have one yet.
    const { width, height } = crosshairBoxSize();
    b.style.display = "block";
    b.style.width = `${width}px`;
    b.style.height = `${height}px`;
    b.style.top = `${y - height / 2}px`;
    b.style.left = `${x - width / 2}px`;
  }
}

function crosshairBoxSize(): { width: number; height: number } {
  const sample = document.querySelector<HTMLElement>(".hotspot:not(.pending)");
  if (sample) return { width: sample.offsetWidth, height: sample.offsetHeight };
  return { width: 40, height: 20 }; // no hotspot on this image yet — a generic guess
}

function hideCrosshair() {
  for (const id of ["crosshair-h", "crosshair-v", "crosshair-box"]) {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  }
}

/**
 * One gesture, two outcomes: drag an existing hotspot to reposition it, or
 * click it (no real movement) to open it for editing.
 */
function startDragHotspot(evt: MouseEvent, link: CatalogLink, el: HTMLElement, img: HTMLImageElement) {
  evt.preventDefault();
  evt.stopPropagation();
  hideCrosshair(); // dragging an existing hotspot, not placing a new one
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
      if (db) applyAndBroadcast("updateLinkPosition", updateLinkPosition, link.id, top, left);
      render();
    } else {
      editingLinkId = link.id;
      editingRowId = null;
      pendingHotspot = null;
      // Jump to the "Edit link" form — no-op above the mobile breakpoint,
      // see mobileTab's declaration.
      mobileTab = "inspector";
      render();
      centerOnHotspot(link.id);
      scrollInspectorToEditLink();
    }
  }

  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

/**
 * Triggered by clicking a row in "Links on this image". Always scrolls the
 * "Edit link" form into view — it renders *above* the links list in the DOM
 * (see renderEditLinkForm/renderLinksSection order in render()), so on an
 * image with many hotspots (real .sch imports can have 70+), a preserved
 * scroll position can leave the form off-screen above the clicked row, same
 * as the "Edit table row" case below.
 */
function actionEditLink(linkId: number) {
  editingLinkId = linkId;
  editingRowId = null;
  pendingHotspot = null;
  render();
  centerOnHotspot(linkId);
  scrollInspectorToEditLink();
}

/** Scrolls the stage so the given hotspot is centered in view. */
function centerOnHotspot(linkId: number) {
  document
    .querySelector(`.hotspot[data-id="${linkId}"]`)
    ?.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
}

/**
 * Scrolls the inspector panel so the just-opened "Edit link" form is
 * visible. Runs on every path that opens it — clicking a hotspot directly
 * on the image (where the inspector's current scroll position has nothing
 * to do with where the form ends up) and clicking a row in "Links on this
 * image" (whose form renders *above* the list in the DOM, so on an image
 * with many hotspots a preserved scroll position can leave it off-screen).
 */
function scrollInspectorToEditLink() {
  document.getElementById("form-edit-link")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/**
 * Scrolls the inspector panel so the just-opened "Edit table row" form is
 * visible. Always runs — the form renders *above* the table in the DOM
 * (see renderEditRowForm/renderRowsSection order in render()), so a long
 * table's preserved scroll position can leave it off-screen above the
 * clicked row, same reasoning as "Edit link" above.
 */
function scrollInspectorToEditRow() {
  document.getElementById("form-edit-row")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/** Clicking a search result: switches image (if needed) and opens the matching hotspot for editing. */
function actionGoToSearchResult(imageId: number, url: string) {
  if (!db) return;
  searchOpen = false;
  activeImageId = imageId;
  pendingHotspot = null;
  zoom = 1;
  const link = listLinksForImage(db, imageId).find((l) => l.url === url);
  editingLinkId = link ? link.id : null;
  editingRowId = null;
  // Found a hotspot to edit → jump to its form; otherwise just show the
  // image. No-op above the mobile breakpoint — see mobileTab's declaration.
  mobileTab = link ? "inspector" : "stage";
  render();
  if (link) {
    centerOnHotspot(link.id);
    scrollInspectorToEditLink();
  }
}

function actionToggleSearch() {
  searchOpen = !searchOpen;
  if (searchOpen) {
    searchQuery = "";
    searchField = "all";
  }
  render();
}

/** A repeated name/url is legitimate (the same part drawn at several positions on one diagram). */
function conflictMessage(conflicts: LinkConflict[]): string {
  const lines = conflicts.map(
    (c) => `${c.field === "name" ? "Name" : "Address"} "${c.value}" is already used by another hotspot in this catalog.`,
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
      applyAddAndBroadcast("addLink", addLink, { imageId, name, url, top, left });
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
      applyAndBroadcast("updateLink", updateLink, linkId, { name, url });
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

/**
 * Deleting a hotspot is blocked outright while a data row still uses its
 * url — otherwise the row would silently disappear along with it. Delete
 * the table row first (it's a separate, deliberate action — see
 * actionDeleteRow()); the hotspot is then a bare, unassigned one and this
 * can delete it.
 */
function actionDeleteLink() {
  if (!db || editingLinkId === null || activeImageId === null) return;
  const linkId = editingLinkId;
  const link = listLinksForImage(db, activeImageId).find((l) => l.id === linkId);
  if (!link) return;
  if (rowExistsForUrl(db, link.url)) {
    notify(`Can't delete this hotspot — its table row ("${link.url}") is still there. Delete the row first.`);
    return;
  }
  askConfirm("Delete this hotspot? This can't be undone.", () => {
    if (!db) return;
    try {
      applyAndBroadcast("deleteLink", deleteLink, linkId);
      editingLinkId = null;
      setStatus("Link deleted.");
    } catch (err) {
      setStatus(`Could not delete link: ${(err as Error).message}`);
    }
  });
}

function actionCancelEditLink() {
  editingLinkId = null;
  render();
}

/** Parses the "Extra characteristics (JSON)" textarea; returns null (and sets a status message) if invalid. */
function parseExtraField(extraText: string): Record<string, string> | null {
  if (!extraText.trim()) return {};
  try {
    return JSON.parse(extraText);
  } catch {
    setStatus('The "extra characteristics" field must be a valid JSON object.');
    return null;
  }
}

function actionAddRow(url: string, name: string, sku: string, description: string, extraText: string) {
  if (!db || activeImageId === null) return;
  const extra = parseExtraField(extraText);
  if (extra === null) return;
  applyAddAndBroadcast("addRow", addRow, { imageId: activeImageId, url, name, sku, description, extra });
  setStatus(`Row for "${url}" added.`);
}

function actionEditRow(rowId: number) {
  editingRowId = rowId;
  editingLinkId = null;
  pendingHotspot = null;
  render();
  scrollInspectorToEditRow();
}

function actionCancelEditRow() {
  editingRowId = null;
  render();
}

function actionSaveRowEdit(name: string, sku: string, description: string, extraText: string) {
  if (!db || editingRowId === null) return;
  const extra = parseExtraField(extraText);
  if (extra === null) return;
  applyAndBroadcast("updateRow", updateRow, editingRowId, { name, sku, description, extra });
  editingRowId = null;
  setStatus(`Row "${name}" updated.`);
}

function actionDeleteRow() {
  if (!db || editingRowId === null) return;
  const rowId = editingRowId;
  askConfirm("Delete this table row? Its hotspot stays on the image, just unassigned from any data. This can't be undone.", () => {
    if (!db) return;
    applyAndBroadcast("deleteRow", deleteRow, rowId);
    editingRowId = null;
    setStatus("Row deleted.");
  });
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
  const editingRow = rows.find((r) => r.id === editingRowId) ?? null;

  // Preserve the current pan position across a re-render of the *same*
  // image (rebuilding #app.innerHTML recreates #stage-scroll from scratch,
  // which would otherwise silently snap back to scrollLeft/Top = 0).
  const prevStageScroll = document.getElementById("stage-scroll");
  const savedScroll =
    prevStageScroll && activeImageId === lastRenderedImageId
      ? { left: prevStageScroll.scrollLeft, top: prevStageScroll.scrollTop }
      : null;
  // Same problem for the right-hand inspector panel: clicking a link or a
  // table row re-renders #app to open its edit form, which recreates
  // #inspector from scratch and would otherwise snap it back to the top —
  // jarring when you're editing several rows down a long list.
  const prevInspector = document.getElementById("inspector");
  const savedInspectorScrollTop =
    prevInspector && activeImageId === lastRenderedImageId ? prevInspector.scrollTop : null;
  lastRenderedImageId = activeImageId;

  // Read by the mobile breakpoint's CSS (#app[data-mobile-tab=...]) to
  // decide which single panel to show — see mobileTab's declaration. Set on
  // #app itself (not inside innerHTML below) so it survives the wholesale
  // rebuild, same reasoning as applyPanelWidths()'s CSS custom properties.
  app.setAttribute("data-mobile-tab", mobileTab);
  app.innerHTML = `
    <div class="toolbar">
      <h1>Electronic Catalog — Editor</h1>
      <button id="btn-new">New catalog</button>
      <button id="btn-open">Open catalog…</button>
      <input type="file" id="file-open" accept=".${CATALOG_FILE_EXTENSION},.sch" style="display:none" />
      <button id="btn-copy-remote" title="Fetch a copy of a catalog hosted at a URL to start editing">Copy remote catalog…</button>
      <button id="btn-add-image" ${db ? "" : "disabled"}>Add image…</button>
      <input type="file" id="file-image" accept="image/*" style="display:none" />
      <button id="btn-save" ${db ? "" : "disabled"} title="Save in place (overwrites the opened file where your browser supports it)">Save</button>
      <button id="btn-export" ${db ? "" : "disabled"} title="Always downloads a new copy">Export .${CATALOG_FILE_EXTENSION}</button>
      <button id="btn-search" ${db ? "" : "disabled"} title="Search every row in this catalog, not just the current image">Search…</button>
      <button id="btn-store-settings" ${db ? "" : "disabled"} title="Configure this catalog's store link and Buy-button behavior">⚙️ Store settings…</button>
      <button id="btn-server-settings" ${collabRoomId ? "disabled" : ""} title="Which self-hosted collaboration server to use for Start/Join collaboration">🖥️ Server settings…</button>
      ${db && !collabRoomId ? `<button id="btn-start-collab" title="Start a live session others can join to edit this catalog with you">🤝 Start collaboration</button>` : ""}
      ${collabRoomId ? renderCollabStatus() : ""}
      <span class="spacer"></span>
      <button id="btn-theme" title="Toggle light/dark theme">${currentTheme() === "dark" ? "☀️ Light" : "🌙 Dark"}</button>
      <span class="hint">${escapeHtml(statusMessage)}</span>
      ${searchOpen ? renderSearchPanel() : ""}
    </div>

    <div class="mobile-tabs">
      <button type="button" class="mobile-tab-btn ${mobileTab === "images" ? "active" : ""}" data-tab="images">Images</button>
      <button type="button" class="mobile-tab-btn ${mobileTab === "stage" ? "active" : ""}" data-tab="stage">Diagram</button>
      <button type="button" class="mobile-tab-btn ${mobileTab === "inspector" ? "active" : ""}" data-tab="inspector">Details</button>
    </div>

    <div class="panel-images">
      ${
        images.length === 0
          ? `<p class="hint">${db ? "No images in this catalog yet." : "Create or open a catalog."}</p>`
          : renderImageList(images)
      }
    </div>

    <div class="panel-divider" id="divider-images" title="Drag to resize"></div>

    <div class="stage">
      <div class="stage-scroll" id="stage-scroll">
        ${
          activeImage
            ? `<div class="stage-inner" id="stage-inner" style="transform: scale(${zoom})">
                 <img id="stage-img" src="data:${activeImage.mimeType};base64,${activeImage.imageData}" width="${activeImage.width}" height="${activeImage.height}" />
                 <div class="crosshair-box" id="crosshair-box"></div>
                 <div class="crosshair-h" id="crosshair-h"></div>
                 <div class="crosshair-v" id="crosshair-v"></div>
                 ${links.map((l) => hotspotHtml(l, editingRow?.url ?? null)).join("")}
                 ${pendingHotspot ? `<div class="hotspot pending" style="top:${pendingHotspot.top}px;left:${pendingHotspot.left}px">new…</div>` : ""}
               </div>`
            : `<p class="hint" style="padding:2rem">Select an image on the left, or add a new one.</p>`
        }
      </div>
      ${activeImage ? renderZoomControls() : ""}
    </div>

    <div class="panel-divider" id="divider-inspector" title="Drag to resize"></div>

    <div class="inspector" id="inspector">
      ${activeImage ? renderImageForm(activeImage, images) : ""}
      ${activeImage ? renderLinkForm(links) : ""}
      ${activeImage ? renderEditLinkForm(editingLink) : ""}
      ${activeImage ? renderLinksSection(links, editingLinkId) : ""}
      ${activeImage ? renderRowForm(availableLinks) : ""}
      ${activeImage ? renderEditRowForm(editingRow) : ""}
      ${activeImage ? renderRowsSection(rows, editingRowId) : ""}
    </div>

    ${renderConfirmOverlay()}
    ${renderNoticeOverlay()}
    ${renderRemoteDialog()}
    ${renderStoreSettingsDialog()}
    ${renderServerSettingsDialog()}
  `;

  if (savedScroll) {
    const stageScroll = document.getElementById("stage-scroll");
    if (stageScroll) {
      stageScroll.scrollLeft = savedScroll.left;
      stageScroll.scrollTop = savedScroll.top;
    }
  }
  if (savedInspectorScrollTop !== null) {
    const inspector = document.getElementById("inspector");
    if (inspector) inspector.scrollTop = savedInspectorScrollTop;
  }

  wireEvents(links);
}

/** Two-level list: ungrouped images first, then one heading per folder (see shared/images.ts). */
function renderImageList(images: CatalogImage[]): string {
  return groupImagesByFolder(images)
    .map((group) => {
      const items = group.images.map((img) => renderImageListItem(img)).join("");
      if (group.folder === "") return `<ul class="image-list">${items}</ul>`;
      return `<div class="image-folder"><div class="image-folder-name">${escapeHtml(group.folder)}</div><ul class="image-list">${items}</ul></div>`;
    })
    .join("");
}

/**
 * The × only deletes when the image has zero hotspots left — otherwise it's
 * disabled with a title listing exactly what's still attached, so there's
 * always somewhere else to look before deleting an image out from under
 * live data (see deleteImage()'s doc comment for why that matters).
 */
function renderImageListItem(img: CatalogImage): string {
  const links = db ? listLinksForImage(db, img.id) : [];
  const blocked = links.length > 0;
  const title = blocked
    ? `Can't delete — ${links.length} hotspot${links.length === 1 ? "" : "s"} still attached: ${links.map((l) => l.name).join(", ")}`
    : `Delete "${img.name}"`;
  return `
    <li data-id="${img.id}" class="${img.id === activeImageId ? "active" : ""}">
      <span class="image-list-name">${escapeHtml(img.name)}</span>
      <button
        type="button"
        class="image-list-delete"
        data-delete-id="${img.id}"
        title="${escapeHtml(title)}"
        ${blocked ? "disabled" : ""}
      >×</button>
    </li>
  `;
}

function renderImageForm(image: CatalogImage, allImages: CatalogImage[]): string {
  const folders = collectFolders(allImages);
  return `
    <section>
      <h2>Image</h2>
      <div class="field">
        <label for="image-name-input">Name</label>
        <input type="text" id="image-name-input" value="${escapeHtml(image.name)}" />
      </div>
      <div class="field">
        <label for="image-folder-input">Folder (leave empty for none)</label>
        <input type="text" id="image-folder-input" list="folder-options" value="${escapeHtml(image.folder)}" placeholder="e.g. Wardrobe" />
        <datalist id="folder-options">${folders.map((f) => `<option value="${escapeHtml(f)}"></option>`).join("")}</datalist>
      </div>
      <button id="btn-save-image">Save</button>
    </section>
  `;
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

function collabShareLink(): string {
  return `${location.origin}${location.pathname}?collab=${collabRoomId}&server=${encodeURIComponent(collabServerUrl)}`;
}

function collabStatusText(): { icon: string; label: string; title: string } {
  const icon = collabStatus === "connected" ? "🟢" : collabStatus === "connecting" ? "🟡" : "🔴";
  let label = collabStatus === "connected" ? "Live" : collabStatus === "connecting" ? "Connecting…" : "Disconnected";
  let title = `Share this link so a colleague can join: ${collabShareLink()}`;
  if (outbox.length > 0) {
    label += ` (${outbox.length} pending)`;
    title = `${outbox.length} edit${outbox.length === 1 ? "" : "s"} not sent yet — still editing locally, will send once reconnected. ${title}`;
  }
  return { icon, label, title };
}

function renderCollabStatus(): string {
  const { icon, label, title } = collabStatusText();
  return `
    <span class="collab-status" id="collab-status-text" title="${escapeHtml(title)}">${icon} ${label}</span>
    <button type="button" id="btn-copy-collab-link">Copy link to share</button>
    <button type="button" id="btn-leave-collab">Leave</button>
  `;
}

/**
 * Patches just the status text in place instead of calling render() — the
 * connection flickering between connecting/disconnected while genuinely
 * offline (each retry — see scheduleReconnect) would otherwise wholesale-
 * rebuild #app every few seconds and silently wipe whatever's mid-typing
 * in an open form (a real bug this surfaced: editing a row's SKU while
 * offline got reverted out from under the person a few seconds later).
 * Only status/pending-count changes go through here; an actual data change
 * (a local edit, an applied remote op) still goes through the normal
 * render() — this is purely for the parts of a status flicker that don't
 * change what's on the page besides this one label.
 */
function updateCollabStatusDisplay() {
  const el = document.getElementById("collab-status-text");
  if (!el) return; // no active session currently rendered — nothing to patch
  const { icon, label, title } = collabStatusText();
  el.textContent = `${icon} ${label}`;
  el.title = title;
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

/**
 * A single-button variant of the confirm overlay, for "this isn't allowed,
 * here's why" notices (e.g. deleting a hotspot whose row is still there) —
 * the status bar's corner text is too easy to miss for something that
 * blocked what the person just tried to do.
 */
function renderNoticeOverlay(): string {
  if (!pendingNotice) return "";
  return `
    <div class="confirm-overlay">
      <div class="confirm-box">
        <p>${escapeHtml(pendingNotice)}</p>
        <div class="confirm-actions">
          <button id="btn-notice-ok">OK</button>
        </div>
      </div>
    </div>
  `;
}

function renderRemoteDialog(): string {
  if (!remoteDialogOpen) return "";
  return `
    <div class="confirm-overlay">
      <div class="confirm-box">
        <h2>Copy remote catalog</h2>
        <div class="field">
          <label for="remote-url-input">URL to a .${CATALOG_FILE_EXTENSION} file</label>
          <input type="text" id="remote-url-input" value="${escapeHtml(remoteUrlValue)}" placeholder="https://example.com/catalog.${CATALOG_FILE_EXTENSION}" ${remoteLoading ? "disabled" : ""} />
        </div>
        ${
          remoteError
            ? `<p class="error">${escapeHtml(remoteError)}</p>`
            : `<p class="hint">Fetches a copy to edit locally — it won't stay linked to that URL, use Save/Export to keep your changes. The host must allow cross-origin requests (CORS).</p>`
        }
        <div class="confirm-actions">
          <button id="remote-cancel" ${remoteLoading ? "disabled" : ""}>Cancel</button>
          <button id="remote-submit" ${remoteLoading || !remoteUrlValue.trim() ? "disabled" : ""}>${remoteLoading ? "Copying…" : "Copy"}</button>
        </div>
      </div>
    </div>
  `;
}

function renderStoreSettingsDialog(): string {
  if (!storeSettingsOpen) return "";
  const usingDefaultRecipe =
    storeSettingsCartIdPattern === DEFAULT_CART_ID_PATTERN &&
    storeSettingsCartItemParam === DEFAULT_CART_ITEM_PARAM &&
    storeSettingsCartCheckoutBaseUrl === DEFAULT_CART_CHECKOUT_BASE_URL;
  return `
    <div class="confirm-overlay">
      <div class="confirm-box">
        <h2>Store settings</h2>
        <div class="field">
          <label for="store-url-input">Store URL (for your own reference)</label>
          <input type="text" id="store-url-input" value="${escapeHtml(storeSettingsUrlValue)}" placeholder="https://payhip.com/YourStore" />
        </div>
        <div class="field">
          <label>Buy button behavior</label>
          <label class="radio-option">
            <input type="radio" name="cart-mode" value="accumulate" ${storeSettingsCartMode === "accumulate" ? "checked" : ""} />
            Add to cart, checkout for everything at once
          </label>
          <label class="radio-option">
            <input type="radio" name="cart-mode" value="instant" ${storeSettingsCartMode === "instant" ? "checked" : ""} />
            Go straight to payment for each item
          </label>
        </div>
        <details class="cart-recipe" ${usingDefaultRecipe ? "" : "open"}>
          <summary>Advanced: how to combine items into one cart (defaults work for Payhip)</summary>
          <div class="field">
            <label for="cart-id-pattern-input">Item ID pattern (regex, one capture group)</label>
            <input type="text" id="cart-id-pattern-input" value="${escapeHtml(storeSettingsCartIdPattern)}" />
          </div>
          <div class="field">
            <label for="cart-item-param-input">Per-item cart parameter (use {id})</label>
            <input type="text" id="cart-item-param-input" value="${escapeHtml(storeSettingsCartItemParam)}" />
          </div>
          <div class="field">
            <label for="cart-base-url-input">Cart checkout base URL</label>
            <input type="text" id="cart-base-url-input" value="${escapeHtml(storeSettingsCartCheckoutBaseUrl)}" />
          </div>
          <p class="hint">A row's buy_url is only combinable if it matches the Item ID pattern above. Its captured id is substituted into the per-item parameter (once per item, joined with "&"), then appended to the base URL. Anything that doesn't match always opens individually, regardless of the Buy button behavior above.</p>
        </details>
        <div class="confirm-actions">
          <button id="store-settings-cancel">Cancel</button>
          <button id="store-settings-submit">Save</button>
        </div>
      </div>
    </div>
  `;
}

function renderServerSettingsDialog(): string {
  if (!serverSettingsOpen) return "";
  return `
    <div class="confirm-overlay">
      <div class="confirm-box">
        <h2>Server settings</h2>
        <div class="field">
          <label for="server-url-input">Collaboration server address</label>
          <input type="text" id="server-url-input" value="${escapeHtml(serverSettingsUrlValue)}" placeholder="${DEFAULT_COLLAB_SERVER_URL}" />
        </div>
        <p class="hint">Run the <strong>ECM Collaboration Server</strong> app on your own computer, then paste the address it shows you here before starting or joining a shared session. A colleague opening your shared link picks this up automatically — they don't need to set anything themselves.</p>
        <div class="confirm-actions">
          <button id="server-settings-cancel">Cancel</button>
          <button id="server-settings-submit">Save</button>
        </div>
      </div>
    </div>
  `;
}

function renderSearchPanel(): string {
  if (!db) return "";
  const extraKeys = collectExtraKeys(listAllRows(db));
  return `
    <div class="search-panel" id="search-panel">
      <div class="search-controls">
        <input type="text" id="search-input" value="${escapeHtml(searchQuery)}" placeholder="Search every row…" />
        <select id="search-field">
          <option value="all" ${searchField === "all" ? "selected" : ""}>All fields</option>
          <option value="name" ${searchField === "name" ? "selected" : ""}>Name</option>
          <option value="sku" ${searchField === "sku" ? "selected" : ""}>SKU</option>
          <option value="description" ${searchField === "description" ? "selected" : ""}>Description</option>
          ${extraKeys
            .map(
              (k) =>
                `<option value="extra:${escapeHtml(k)}" ${searchField === `extra:${k}` ? "selected" : ""}>Extra: ${escapeHtml(k)}</option>`,
            )
            .join("")}
        </select>
      </div>
      <div class="search-results" id="search-results">${renderSearchResultsList()}</div>
    </div>
  `;
}

function renderSearchResultsList(): string {
  if (!db) return "";
  if (!searchQuery.trim()) return `<p class="hint">Type to search across every image's table.</p>`;
  const results = searchRows(listAllRows(db), searchQuery, searchField).slice(0, 30);
  if (results.length === 0) return `<p class="hint">No matches.</p>`;
  const imageNameById = new Map(listImages(db).map((i) => [i.id, i.name]));
  return `<ul>${results
    .map(
      (r) =>
        `<li data-image-id="${r.imageId}" data-url="${escapeHtml(r.url)}">
           <strong>${escapeHtml(r.name || r.url)}</strong>${r.sku ? ` · ${escapeHtml(r.sku)}` : ""}<br>
           <span class="hint">${escapeHtml(imageNameById.get(r.imageId) ?? "")}${r.description ? ` — ${escapeHtml(r.description)}` : ""}</span>
         </li>`,
    )
    .join("")}</ul>`;
}

/** Re-renders just the results list (not the whole app) so the search input never loses focus mid-type. */
function refreshSearchResults() {
  const el = document.getElementById("search-results");
  if (!el) return;
  el.innerHTML = renderSearchResultsList();
  wireSearchResultClicks();
}

function wireSearchResultClicks() {
  document.querySelectorAll<HTMLLIElement>("#search-results li[data-url]").forEach((li) => {
    li.addEventListener("click", () => actionGoToSearchResult(Number(li.dataset.imageId), li.dataset.url!));
  });
}

function hotspotHtml(l: CatalogLink, editingRowUrl: string | null): string {
  const classes = ["hotspot"];
  if (l.id === editingLinkId) classes.push("editing");
  if (editingRowUrl !== null && l.url === editingRowUrl) classes.push("row-match");
  return `<div class="${classes.join(" ")}" data-id="${l.id}" style="top:${l.top}px;left:${l.left}px" title="${escapeHtml(l.url)} — drag to reposition, click to edit">${escapeHtml(l.name)}</div>`;
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
               <div class="field"><label>Address</label><input name="url" required /></div>
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
        <div class="field"><label>Address, unique across the whole catalog</label><input name="url" value="${escapeHtml(link.url)}" required /></div>
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
  const [nameW, urlW] = colWidths.links;
  return `
    <section>
      <h2>Links on this image (${links.length})</h2>
      <table data-col-key="links" style="table-layout:fixed; width:${colTableTotalWidth("links")}px">
        <colgroup><col style="width:${nameW}px"><col style="width:${urlW}px"></colgroup>
        <thead><tr>
          <th>Name<span class="col-resize-handle" data-table="links" data-col="0"></span></th>
          <th>Address<span class="col-resize-handle" data-table="links" data-col="1"></span></th>
        </tr></thead>
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
               <div class="field"><label>Address (matches a link)</label>
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

function renderEditRowForm(row: CatalogRow | null): string {
  if (!row) return "";
  return `
    <section>
      <h2>Edit table row</h2>
      <p class="hint">Address: ${escapeHtml(row.url)} (change the hotspot's address to repoint this row)</p>
      <form id="form-edit-row">
        <div class="field"><label>Name</label><input name="name" value="${escapeHtml(row.name)}" /></div>
        <div class="field"><label>SKU</label><input name="sku" value="${escapeHtml(row.sku)}" /></div>
        <div class="field"><label>Description</label><input name="description" value="${escapeHtml(row.description)}" /></div>
        <div class="field"><label>Extra characteristics (JSON)</label><textarea name="extra" rows="3" placeholder='{"weight": "2.3 kg"}'>${escapeHtml(Object.keys(row.extra).length ? JSON.stringify(row.extra, null, 2) : "")}</textarea></div>
        <div style="display:flex; gap:0.5rem; align-items:center">
          <button type="submit">Save changes</button>
          <button type="button" id="btn-cancel-edit-row">Cancel</button>
          <button type="button" id="btn-delete-row" style="margin-left:auto; color:#b91c1c; border-color:#b91c1c">Delete</button>
        </div>
      </form>
    </section>
  `;
}

function renderRowsSection(rows: ReturnType<typeof listRowsForImage>, editingRowId: number | null): string {
  const [urlW, nameW, skuW] = colWidths.rows;
  return `
    <section>
      <h2>Table (${rows.length} rows)</h2>
      <table data-col-key="rows" style="table-layout:fixed; width:${colTableTotalWidth("rows")}px">
        <colgroup><col style="width:${urlW}px"><col style="width:${nameW}px"><col style="width:${skuW}px"></colgroup>
        <thead><tr>
          <th>Address<span class="col-resize-handle" data-table="rows" data-col="0"></span></th>
          <th>Name<span class="col-resize-handle" data-table="rows" data-col="1"></span></th>
          <th>SKU<span class="col-resize-handle" data-table="rows" data-col="2"></span></th>
        </tr></thead>
        <tbody>
          ${rows
            .map(
              (r) =>
                `<tr data-row-id="${r.id}" class="clickable-row${r.id === editingRowId ? " editing" : ""}"><td>${escapeHtml(r.url)}</td><td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.sku)}</td></tr>`,
            )
            .join("")}
        </tbody>
      </table>
      <p class="hint">Click a row to edit its name, SKU, description or extra characteristics.</p>
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
  document.getElementById("btn-notice-ok")?.addEventListener("click", () => {
    pendingNotice = null;
    render();
  });

  document.getElementById("btn-theme")?.addEventListener("click", () => {
    toggleTheme();
    render();
  });

  document.getElementById("divider-images")?.addEventListener("mousedown", (evt) => startPanelResize(evt as MouseEvent, "images"));
  document.getElementById("divider-inspector")?.addEventListener("mousedown", (evt) => startPanelResize(evt as MouseEvent, "inspector"));

  document.querySelectorAll<HTMLElement>(".col-resize-handle").forEach((handle) => {
    handle.addEventListener("mousedown", (evt) => {
      const tableKey = handle.dataset.table as ColTableKey;
      const colIndex = Number(handle.dataset.col);
      startColumnResize(evt as MouseEvent, tableKey, colIndex);
    });
  });

  document.getElementById("btn-new")?.addEventListener("click", actionNewCatalog);

  const fileOpen = document.getElementById("file-open") as HTMLInputElement;
  document.getElementById("btn-open")?.addEventListener("click", () => void actionOpenCatalogClicked(fileOpen));
  fileOpen.addEventListener("change", () => {
    const file = fileOpen.files?.[0];
    if (file) void file.arrayBuffer().then((buf) => openCatalogFromBytes(new Uint8Array(buf), null, baseName(file.name)));
  });

  document.getElementById("btn-save")?.addEventListener("click", () => void actionSave());
  document.getElementById("btn-export")?.addEventListener("click", actionExportCatalog);

  document.getElementById("btn-copy-remote")?.addEventListener("click", actionOpenRemoteDialog);
  document.getElementById("remote-cancel")?.addEventListener("click", actionCancelRemoteDialog);
  document.getElementById("remote-submit")?.addEventListener("click", () => void actionSubmitRemoteDialog());
  const remoteUrlInput = document.getElementById("remote-url-input") as HTMLInputElement | null;
  const remoteSubmitBtn = document.getElementById("remote-submit") as HTMLButtonElement | null;
  remoteUrlInput?.addEventListener("input", () => {
    remoteUrlValue = remoteUrlInput.value;
    if (remoteSubmitBtn) remoteSubmitBtn.disabled = remoteLoading || !remoteUrlInput.value.trim();
  });
  remoteUrlInput?.addEventListener("keydown", (evt) => {
    if (evt.key === "Enter" && !remoteUrlInput.value.trim()) return;
    if (evt.key === "Enter") void actionSubmitRemoteDialog();
    if (evt.key === "Escape") actionCancelRemoteDialog();
  });
  if (remoteDialogOpen && !remoteLoading) {
    remoteUrlInput?.focus();
    remoteUrlInput?.setSelectionRange(remoteUrlInput.value.length, remoteUrlInput.value.length);
  }

  document.getElementById("btn-store-settings")?.addEventListener("click", actionOpenStoreSettings);
  document.getElementById("btn-server-settings")?.addEventListener("click", actionOpenServerSettings);
  document.getElementById("server-settings-cancel")?.addEventListener("click", actionCancelServerSettings);
  document.getElementById("server-settings-submit")?.addEventListener("click", actionSubmitServerSettings);
  const serverUrlInput = document.getElementById("server-url-input") as HTMLInputElement | null;
  serverUrlInput?.addEventListener("input", () => {
    serverSettingsUrlValue = serverUrlInput.value;
  });
  serverUrlInput?.addEventListener("keydown", (evt) => {
    if (evt.key === "Enter") actionSubmitServerSettings();
    if (evt.key === "Escape") actionCancelServerSettings();
  });
  if (serverSettingsOpen) {
    serverUrlInput?.focus();
    serverUrlInput?.setSelectionRange(serverUrlInput.value.length, serverUrlInput.value.length);
  }
  document.getElementById("btn-start-collab")?.addEventListener("click", () => void actionStartCollaboration());
  document.getElementById("btn-copy-collab-link")?.addEventListener("click", () => void actionCopyCollabLink());
  document.getElementById("btn-leave-collab")?.addEventListener("click", actionLeaveCollaboration);
  document.getElementById("store-settings-cancel")?.addEventListener("click", actionCancelStoreSettings);
  document.getElementById("store-settings-submit")?.addEventListener("click", actionSubmitStoreSettings);
  const storeUrlInput = document.getElementById("store-url-input") as HTMLInputElement | null;
  storeUrlInput?.addEventListener("input", () => {
    storeSettingsUrlValue = storeUrlInput.value;
  });
  document.querySelectorAll<HTMLInputElement>('input[name="cart-mode"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      if (radio.checked) storeSettingsCartMode = radio.value as "accumulate" | "instant";
    });
  });
  const cartIdPatternInput = document.getElementById("cart-id-pattern-input") as HTMLInputElement | null;
  cartIdPatternInput?.addEventListener("input", () => {
    storeSettingsCartIdPattern = cartIdPatternInput.value;
  });
  const cartItemParamInput = document.getElementById("cart-item-param-input") as HTMLInputElement | null;
  cartItemParamInput?.addEventListener("input", () => {
    storeSettingsCartItemParam = cartItemParamInput.value;
  });
  const cartBaseUrlInput = document.getElementById("cart-base-url-input") as HTMLInputElement | null;
  cartBaseUrlInput?.addEventListener("input", () => {
    storeSettingsCartCheckoutBaseUrl = cartBaseUrlInput.value;
  });
  if (storeSettingsOpen) {
    storeUrlInput?.focus();
    storeUrlInput?.setSelectionRange(storeUrlInput.value.length, storeUrlInput.value.length);
  }

  document.getElementById("btn-search")?.addEventListener("click", actionToggleSearch);
  const searchInput = document.getElementById("search-input") as HTMLInputElement | null;
  searchInput?.addEventListener("input", () => {
    searchQuery = searchInput.value;
    refreshSearchResults();
  });
  searchInput?.addEventListener("keydown", (evt) => {
    if (evt.key === "Escape") {
      searchOpen = false;
      render();
    }
  });
  document.getElementById("search-field")?.addEventListener("change", (evt) => {
    searchField = (evt.target as HTMLSelectElement).value as SearchField;
    refreshSearchResults();
  });
  wireSearchResultClicks();
  if (searchOpen) searchInput?.focus();

  const fileImage = document.getElementById("file-image") as HTMLInputElement;
  document.getElementById("btn-add-image")?.addEventListener("click", () => fileImage.click());
  fileImage.addEventListener("change", () => {
    const file = fileImage.files?.[0];
    if (file) void actionAddImage(file);
  });

  document.querySelectorAll<HTMLLIElement>(".panel-images li[data-id]").forEach((li) => {
    li.addEventListener("click", () => actionSelectImage(Number(li.dataset.id)));
  });
  document.querySelectorAll<HTMLButtonElement>(".image-list-delete").forEach((btn) => {
    btn.addEventListener("click", (evt) => {
      evt.stopPropagation(); // don't also trigger the <li>'s own click (select image)
      actionDeleteImage(Number(btn.dataset.deleteId));
    });
  });

  document.querySelectorAll<HTMLButtonElement>(".mobile-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => actionSetMobileTab(btn.dataset.tab as "images" | "stage" | "inspector"));
  });

  document.getElementById("btn-save-image")?.addEventListener("click", actionUpdateImageMeta);

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
  const stageInner = document.getElementById("stage-inner") as HTMLElement | null;
  if (stageImg && stageScroll) {
    stageImg.addEventListener("mousedown", (evt) => startStageInteraction(evt, stageImg, stageScroll));
  }

  if (stageImg && stageInner) {
    stageInner.addEventListener("mousemove", (evt) => {
      // Hovering an existing hotspot (or mid-pan) — let its own cursor/drag
      // handling take over instead of drawing the placement crosshair.
      if (stageScroll?.classList.contains("panning") || (evt.target as HTMLElement).closest(".hotspot")) {
        hideCrosshair();
        return;
      }
      const rect = stageImg.getBoundingClientRect();
      showCrosshair((evt.clientX - rect.left) / zoom, (evt.clientY - rect.top) / zoom);
    });
    stageInner.addEventListener("mouseleave", hideCrosshair);
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

  document.querySelectorAll<HTMLTableRowElement>("tr[data-row-id]").forEach((tr) => {
    tr.addEventListener("click", () => actionEditRow(Number(tr.dataset.rowId)));
  });

  document.getElementById("form-edit-row")?.addEventListener("submit", (evt) => {
    evt.preventDefault();
    const fd = new FormData(evt.target as HTMLFormElement);
    actionSaveRowEdit(
      String(fd.get("name") ?? ""),
      String(fd.get("sku") ?? ""),
      String(fd.get("description") ?? ""),
      String(fd.get("extra") ?? ""),
    );
  });
  document.getElementById("btn-cancel-edit-row")?.addEventListener("click", actionCancelEditRow);
  document.getElementById("btn-delete-row")?.addEventListener("click", actionDeleteRow);
}

void boot();

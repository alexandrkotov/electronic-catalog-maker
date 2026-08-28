import { CATALOG_FILE_EXTENSION } from "./schema.js";
import {
  findRowByUrl,
  initSqlite,
  listAllRows,
  listImages,
  listLinksForImage,
  listRowsForImage,
  openCatalog,
  readMeta,
} from "./db.js";
import { detectFileKind, importSchCatalog } from "./legacySch.js";
import { groupImagesByFolder } from "./images.js";
import { collectExtraKeys, searchRows, type SearchField } from "./search.js";
import { applyTheme, currentTheme, resolveInitialTheme, toggleTheme } from "./theme.js";
import type { CatalogImage, CatalogLink, CatalogRow } from "./types.js";
import type { Database, SqlJsStatic } from "sql.js";

/**
 * Minimal slice of the File System Access API
 * (https://wicg.github.io/file-system-access/, Chromium-only as of writing)
 * this file uses — re-reading a locally opened file for Refresh. Declared
 * locally (not a global ambient .d.ts like packages/editor's) because a
 * global augmentation in packages/shared/src isn't visible when this file
 * gets type-checked as part of packages/viewer's or packages/viewer-embed's
 * own TS program (each package only pulls in shared's *.ts via the import
 * graph, not shared's own tsconfig `include`). Feature-detected at runtime
 * via getShowOpenFilePicker(); every call site falls back to a plain
 * <input type=file> when it's undefined.
 */
interface EcmFileSystemFileHandle {
  readonly name: string;
  getFile(): Promise<File>;
}

/**
 * Demo catalogs shipped in the repo itself (see demo/ at the repo root and
 * .github/workflows/ci.yml's deploy-pages job, which is what actually
 * publishes them) — offered from the empty-state screen below so a
 * first-time visitor can see the app working on real-looking data without
 * needing a catalog file of their own. Hardcoded (not derived from
 * location.origin) because it's the same files regardless of where this
 * build of the viewer happens to be hosted — including a local dev server,
 * which has no copy of its own to serve.
 */
const DEMO_CATALOGS = [
  {
    label: "Auto parts",
    url: "https://alexandrkotov.github.io/electronic-catalog-maker/demo/auto-spare-parts.ecatm",
  },
  {
    label: "Furniture",
    url: "https://alexandrkotov.github.io/electronic-catalog-maker/demo/furniture.ecatm",
  },
];

// Limits/defaults for the resizable side panels + row-data table columns —
// see the per-instance state declared inside mountViewer() below. Plain
// module-level constants (not per-instance) since they're the same for
// every mounted viewer, unlike the widths themselves.
const PANEL_WIDTH_LIMITS = { min: 160, max: 640 };
const COL_WIDTH_LIMITS = { min: 40, max: 400 };
/** Name, SKU, Description, Extra — matches rowHtml()'s cell order below. */
const DEFAULT_COL_WIDTHS = [100, 70, 110, 120];
type ShowOpenFilePicker = (options?: {
  types?: { description?: string; accept: Record<string, string[]> }[];
  multiple?: boolean;
}) => Promise<EcmFileSystemFileHandle[]>;
function getShowOpenFilePicker(): ShowOpenFilePicker | undefined {
  return (window as unknown as { showOpenFilePicker?: ShowOpenFilePicker }).showOpenFilePicker;
}

/**
 * The viewer's actual behavior — rendering, state, event wiring — factored
 * out of packages/viewer's own entry point so it can be mounted more than
 * once: as the full-page standalone app, and inside the embeddable
 * <ecm-viewer> Web Component (packages/viewer-embed), potentially several
 * times on one host page. Deliberately has no Vite-specific imports (no
 * `?url`/`?inline` asset imports, no `import "./style.css"`) — the caller
 * resolves the sql.js WASM URL and injects CSS however fits its own build,
 * and hands both in here.
 */
export interface MountViewerOptions {
  /** Element to render the viewer's UI into. Its innerHTML is fully owned by this instance. */
  container: HTMLElement;
  /**
   * Scope for `getElementById`/`querySelector` lookups — pass the
   * ShadowRoot when `container` lives inside one; `document` (default)
   * does NOT find elements inside a shadow tree.
   */
  root?: Document | ShadowRoot;
  /**
   * "full": toolbar with Open catalog…/Open remote catalog…/Search…/theme
   * toggle, same as the standalone app. "lite": no toolbar chrome at all —
   * just the image list, stage, and data table. Default "full".
   */
  mode?: "full" | "lite";
  /** A catalog URL to fetch and open automatically once mounted. */
  initialSrc?: string;
  /**
   * Whether a successful load should sync `?src=` into the browser's
   * address bar, so the resulting page is itself a shareable link (see
   * README, "Sharing a catalog via link"). Right for the standalone app's
   * own tab; must stay false for an embedded instance — it must never
   * rewrite the *host* page's URL. Default false.
   */
  updateAddressBar?: boolean;
  /**
   * Element the theme's `data-theme` attribute is applied to. Defaults to
   * `document.documentElement` (right for the standalone app); the embed
   * passes its own shadow host — it must never touch the embedding page's
   * `<html>`.
   */
  themeTarget?: HTMLElement;
  /** Passed straight through to sql.js's `initSqlite`. */
  wasmUrl: string | ((file: string) => string);
}

export interface ViewerController {
  /** Clears everything this instance rendered. Not reusable after this. */
  destroy(): void;
}

export function mountViewer(options: MountViewerOptions): ViewerController {
  const container = options.container;
  const root: Document | ShadowRoot = options.root ?? document;
  const mode = options.mode ?? "full";
  const updateAddressBar = options.updateAddressBar ?? false;
  const themeTarget = options.themeTarget ?? document.documentElement;

  applyTheme(resolveInitialTheme(), themeTarget);

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
  // "Open remote catalog…" dialog state — a URL alternative to the local file
  // picker, for opening a catalog someone shared as a link (see loadFromUrl).
  // Only reachable in "full" mode (no trigger button exists in "lite").
  let remoteDialogOpen = false;
  let remoteUrlValue = "";
  let remoteLoading = false;
  let remoteError: string | null = null;
  // Reverse search — a catalog-wide dropdown (not scoped to the active image),
  // see search.ts. Results are refreshed by directly patching #search-results
  // on every keystroke rather than a full render(), so the search input
  // never loses focus mid-type. Only reachable in "full" mode.
  let searchOpen = false;
  let searchQuery = "";
  let searchField: SearchField = "all";
  // render() replaces the container's innerHTML wholesale, which recreates
  // #stage-scroll from scratch (a fresh element always starts scrolled to
  // 0,0) — tracked so render() can restore the pan position instead of
  // losing it on every unrelated update (selecting a link/row, zooming, ...).
  let lastRenderedImageId: number | null = null;
  // The URL the catalog was last (re)loaded from, if any — set on every
  // successful loadFromUrl() and used by actionRefresh() to refetch the same
  // source (e.g. a catalog shared via a cloud drive that another editor
  // session just saved a new version of).
  let currentSrcUrl: string | null = options.initialSrc ?? null;
  // Set instead of currentSrcUrl when the catalog was opened via the local
  // file picker (showOpenFilePicker, not the plain <input> fallback) — lets
  // actionRefresh() re-read the same file from disk, e.g. a catalog synced
  // locally via a cloud-drive client (OneDrive/Google Drive desktop) rather
  // than fetched over HTTP. The two are mutually exclusive: opening one way
  // clears the other.
  let openedFileHandle: EcmFileSystemFileHandle | null = null;
  let refreshing = false;
  // Which single panel is shown below the mobile breakpoint (see .mobile-tabs
  // / .ecm-viewer-app[data-mobile-tab] in style.css) — irrelevant above it,
  // where all three panels sit side by side per the desktop grid regardless
  // of this value. Starts on "images" so a freshly opened catalog shows its
  // image list first, same as the desktop layout's left panel; picking an
  // image switches to "stage" (see actionSelectImage) since that's the part
  // the user just asked to look at.
  let mobileTab: "images" | "stage" | "table" = "images";

  // ---------- resizable layout (side panels + the row-data table's columns) ----------
  // Same pattern as the editor's equivalent (packages/editor/src/main.ts) —
  // user-adjustable, remembered per-browser via localStorage, not part of
  // the catalog file itself. Per-instance state (not module-level like the
  // editor's, which only ever has one instance) since a page can embed
  // several <ecm-viewer> widgets at once, each mounting this function
  // separately — sharing one localStorage key across instances is fine
  // (same as theme.ts already does), but the in-memory width has to be
  // each instance's own.
  let imagesPanelWidth = loadPanelWidth("ecm-viewer-images-width", 220);
  let tablePanelWidth = loadPanelWidth("ecm-viewer-table-width", 380);
  let colWidths = loadColWidths();
  applyPanelWidths(); // before the first render — avoids a flash of the default width

  function loadPanelWidth(key: string, fallback: number): number {
    try {
      const raw = Number(localStorage.getItem(key));
      if (Number.isFinite(raw) && raw >= PANEL_WIDTH_LIMITS.min && raw <= PANEL_WIDTH_LIMITS.max) return raw;
    } catch {
      // localStorage unavailable (privacy mode, etc.) — fall back to the default.
    }
    return fallback;
  }

  // Applied as CSS custom properties directly on `container` (not
  // `container.innerHTML`), so a resize survives render()'s wholesale
  // innerHTML rebuild without needing to be reapplied on every call.
  function applyPanelWidths() {
    container.style.setProperty("--images-w", `${imagesPanelWidth}px`);
    container.style.setProperty("--table-w", `${tablePanelWidth}px`);
  }

  function loadColWidths(): number[] {
    try {
      const raw = localStorage.getItem("ecm-viewer-table-col-widths");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length === DEFAULT_COL_WIDTHS.length && parsed.every((n) => typeof n === "number" && n > 0)) {
          return parsed;
        }
      }
    } catch {
      // malformed or unavailable storage — use the default widths instead.
    }
    return [...DEFAULT_COL_WIDTHS];
  }

  function saveColWidths() {
    try {
      localStorage.setItem("ecm-viewer-table-col-widths", JSON.stringify(colWidths));
    } catch {
      // Width still applies for this session, just won't persist.
    }
  }

  function colTableTotalWidth(): number {
    return colWidths.reduce((a, b) => a + b, 0);
  }

  /**
   * Drags one of the two panel dividers (images↔stage, stage↔table).
   * Follows the same "poke style properties directly on mousemove, skip
   * render()" pattern as hotspot dragging elsewhere in this file — a full
   * re-render on every mousemove would be wasteful and can lose focus.
   */
  function startPanelResize(evt: MouseEvent, side: "images" | "table") {
    evt.preventDefault();
    const divider = evt.currentTarget as HTMLElement;
    const startX = evt.clientX;
    const startWidth = side === "images" ? imagesPanelWidth : tablePanelWidth;
    divider.classList.add("dragging");

    function onMove(moveEvt: MouseEvent) {
      const dx = moveEvt.clientX - startX;
      // The table panel sits on the right, so dragging its divider left (dx < 0) should grow it.
      const raw = side === "images" ? startWidth + dx : startWidth - dx;
      const width = Math.min(PANEL_WIDTH_LIMITS.max, Math.max(PANEL_WIDTH_LIMITS.min, raw));
      if (side === "images") imagesPanelWidth = width;
      else tablePanelWidth = width;
      applyPanelWidths();
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      divider.classList.remove("dragging");
      try {
        localStorage.setItem(side === "images" ? "ecm-viewer-images-width" : "ecm-viewer-table-width", String(side === "images" ? imagesPanelWidth : tablePanelWidth));
      } catch {
        // Width still applies for this session, just won't persist.
      }
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  /** Drags a column-resize handle in the row-data table's header. */
  function startColumnResize(evt: MouseEvent, colIndex: number) {
    evt.preventDefault();
    evt.stopPropagation();
    const handle = evt.currentTarget as HTMLElement;
    const startX = evt.clientX;
    const startWidth = colWidths[colIndex] ?? COL_WIDTH_LIMITS.min;
    handle.classList.add("dragging");

    function onMove(moveEvt: MouseEvent) {
      const width = Math.min(COL_WIDTH_LIMITS.max, Math.max(COL_WIDTH_LIMITS.min, startWidth + (moveEvt.clientX - startX)));
      colWidths[colIndex] = width;
      const table = root.querySelector<HTMLTableElement>("table[data-col-key='rows']");
      const col = table?.querySelectorAll("col")[colIndex] as HTMLElement | undefined;
      if (col) col.style.width = `${width}px`;
      if (table) table.style.width = `${colTableTotalWidth()}px`;
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      handle.classList.remove("dragging");
      saveColWidths();
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function actionSetZoom(next: number) {
    zoom = Math.min(4, Math.max(0.25, next));
    render();
  }

  async function boot() {
    container.innerHTML = `<p style="padding:1rem">Loading SQLite (sql.js)…</p>`;
    SQL = await initSqlite(options.wasmUrl);

    if (options.initialSrc) {
      await loadFromUrl(options.initialSrc);
    } else {
      render();
    }
  }

  /** Never throws — returns an error message on failure, or null on success. */
  async function loadFromUrl(url: string): Promise<string | null> {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      await openBytes(bytes, baseName(new URL(url, location.href).pathname), null);
      currentSrcUrl = url;
      openedFileHandle = null;
      if (updateAddressBar) {
        history.replaceState(null, "", `?src=${encodeURIComponent(url)}`);
      }
      return null;
    } catch (err) {
      const message = (err as Error).message;
      statusMessage = `Could not load "${url}": ${message}`;
      render();
      return message;
    }
  }

  function actionOpenRemote() {
    remoteDialogOpen = true;
    remoteUrlValue = "";
    remoteError = null;
    render();
  }

  /** "Try a demo catalog" on the empty-state screen — see DEMO_CATALOGS. */
  function actionOpenDemo(url: string) {
    void loadFromUrl(url);
  }

  function actionCancelRemote() {
    if (remoteLoading) return; // let an in-flight request settle rather than leaving stale state
    remoteDialogOpen = false;
    render();
  }

  async function actionSubmitRemote() {
    if (remoteLoading) return;
    const url = remoteUrlValue.trim();
    if (!url) return;
    remoteLoading = true;
    remoteError = null;
    render();
    const error = await loadFromUrl(url);
    // On success, openBytes() already closed the dialog and re-rendered —
    // nothing left to do. On failure, keep the dialog open and show the
    // error right next to the field: closing it and leaving only a small
    // status hint in the toolbar corner reads as "nothing happened".
    remoteLoading = false;
    if (error) {
      remoteError = error;
      render();
    }
  }

  /**
   * Re-reads the catalog from wherever it was last opened — refetches
   * currentSrcUrl if it was loaded via URL, or re-reads openedFileHandle
   * from disk if it was opened via the local file picker (a catalog synced
   * locally by a cloud-drive client is the common case for that path). For
   * watching a catalog someone else is actively editing without leaving the
   * page. Keeps the current image/hotspot/zoom selected if they still exist
   * in the refreshed data, instead of snapping back to the first image the
   * way a plain reopen does.
   */
  async function actionRefresh() {
    if ((!currentSrcUrl && !openedFileHandle) || refreshing) return;
    const savedImageId = activeImageId;
    const savedLinkId = selectedLinkId;
    const savedZoom = zoom;
    refreshing = true;
    render();
    if (currentSrcUrl) {
      await loadFromUrl(currentSrcUrl);
    } else if (openedFileHandle) {
      try {
        const file = await openedFileHandle.getFile();
        const bytes = new Uint8Array(await file.arrayBuffer());
        await openBytes(bytes, baseName(file.name), openedFileHandle);
      } catch (err) {
        statusMessage = `Could not refresh "${openedFileHandle.name}": ${(err as Error).message}`;
      }
    }
    refreshing = false;
    if (db && savedImageId !== null && listImages(db).some((i) => i.id === savedImageId)) {
      activeImageId = savedImageId;
      if (savedLinkId !== null && listLinksForImage(db, savedImageId).some((l) => l.id === savedLinkId)) {
        selectedLinkId = savedLinkId;
      }
      zoom = savedZoom;
    }
    render();
  }

  /**
   * Opens either format transparently — sniffed from the file's actual tables,
   * not its extension (see detectFileKind). A legacy `.sch` file is converted
   * in-memory into a fresh catalog in *our* schema (importSchCatalog), so
   * everything downstream (rendering, search, folders, instance-nav) just
   * works without a parallel "legacy" code path anywhere else in this app.
   */
  async function openBytes(
    bytes: Uint8Array,
    sourceName = "Legacy catalog",
    handle: EcmFileSystemFileHandle | null,
  ) {
    const kind = detectFileKind(SQL, bytes);
    if (kind === "legacy-sch") {
      statusMessage = "Converting legacy .sch catalog… this can take a moment for large files.";
      render();
      // Yield one tick so the status message above actually paints before the
      // (synchronous, potentially slow for a big catalog) conversion work runs.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const result = await importSchCatalog(SQL, bytes, sourceName);
      db = result.db;
      statusMessage = `Converted legacy catalog "${sourceName}" (${result.imageCount} image${result.imageCount === 1 ? "" : "s"}${result.skippedDiagrams ? `, ${result.skippedDiagrams} skipped` : ""}).`;
    } else {
      db = openCatalog(SQL, bytes);
      const meta = readMeta(db);
      statusMessage = `Opened catalog "${meta.catalogName}".`;
    }
    activeImageId = listImages(db)[0]?.id ?? null;
    selectedLinkId = null;
    zoom = 1;
    mobileTab = "images"; // fresh catalog — start from the image list, same as opening one the first time
    remoteDialogOpen = false;
    openedFileHandle = handle;
    if (handle) currentSrcUrl = null;
    render();
  }

  function baseName(nameOrPath: string): string {
    const last = nameOrPath.split(/[\\/]/).pop() || nameOrPath;
    return last.replace(/\.[^./]+$/, "") || last;
  }

  async function actionOpenFile(file: File) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      await openBytes(bytes, baseName(file.name), null);
    } catch (err) {
      statusMessage = `Could not open file: ${(err as Error).message}`;
      render();
    }
  }

  /**
   * "Open catalog…" click: prefers the File System Access API so the
   * resulting handle can back Refresh (re-reading the same file from disk —
   * the common case for a catalog synced locally via a cloud-drive client).
   * Falls back to the plain <input type=file> in browsers without it
   * (Firefox, Safari); Refresh then stays disabled for a locally-opened file.
   */
  async function actionOpenFileClicked(fallbackInput: HTMLInputElement) {
    const showOpenFilePicker = getShowOpenFilePicker();
    if (showOpenFilePicker) {
      try {
        const [handle] = await showOpenFilePicker({
          types: [
            {
              description: "Electronic catalog",
              accept: { "application/x-sqlite3": [`.${CATALOG_FILE_EXTENSION}`, ".sch"] },
            },
          ],
        });
        if (!handle) return;
        const file = await handle.getFile();
        const bytes = new Uint8Array(await file.arrayBuffer());
        await openBytes(bytes, baseName(file.name), handle);
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          statusMessage = `Could not open file: ${(err as Error).message}`;
          render();
        }
      }
      return;
    }
    fallbackInput.click();
  }

  function actionSelectImage(id: number) {
    activeImageId = id;
    selectedLinkId = null;
    zoom = 1;
    mobileTab = "stage"; // no-op above the mobile breakpoint — see mobileTab's declaration
    render();
  }

  function actionSetMobileTab(tab: "images" | "stage" | "table") {
    mobileTab = tab;
    render();
  }

  /** Clicking a hotspot directly: we know exactly which physical instance was clicked. */
  function actionSelectHotspot(linkId: number) {
    selectedLinkId = linkId;
    // Also reached from actionSelectRowByUrl (tapping a table row) — jump to
    // the stage so the highlight this just produced is actually visible.
    // No-op above the mobile breakpoint and when a hotspot on the stage
    // itself was the thing clicked — see mobileTab's declaration.
    mobileTab = "stage";
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

  /** Clicking a search result: unlike actionSelectRowByUrl, this may switch images first. */
  function actionGoToSearchResult(imageId: number, url: string) {
    if (!db) return;
    searchOpen = false;
    activeImageId = imageId;
    zoom = 1;
    mobileTab = "stage"; // no-op above the mobile breakpoint — see mobileTab's declaration
    const link = listLinksForImage(db, imageId).find((l) => l.url === url);
    selectedLinkId = link ? link.id : null;
    render();
    if (link) centerSelection();
  }

  function actionToggleSearch() {
    searchOpen = !searchOpen;
    if (searchOpen) {
      searchQuery = "";
      searchField = "all";
    }
    render();
  }

  function centerSelection() {
    const hotspotEl = root.querySelector(`.hotspot[data-id="${selectedLinkId}"]`);
    hotspotEl?.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
    const url = hotspotEl?.getAttribute("data-url");
    if (url) root.querySelector(`tr[data-url="${cssEscape(url)}"]`)?.scrollIntoView({ block: "nearest" });
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
    // image (rebuilding the container's innerHTML recreates #stage-scroll
    // from scratch, which would otherwise silently snap back to
    // scrollLeft/Top = 0).
    const prevStageScroll = root.getElementById("stage-scroll");
    const savedScroll =
      prevStageScroll && activeImageId === lastRenderedImageId
        ? { left: prevStageScroll.scrollLeft, top: prevStageScroll.scrollTop }
        : null;
    lastRenderedImageId = activeImageId;

    // Styling hooks live on `container` itself (a class, not a hardcoded id —
    // it might be the standalone app's own #app div, or a plain div created
    // inside a shadow root by the embed) so nothing here assumes who created it.
    container.classList.add("ecm-viewer-app", `mode-${mode}`);
    // Read by the mobile breakpoint's CSS (.ecm-viewer-app[data-mobile-tab=...])
    // to decide which single panel to show — see mobileTab's declaration.
    // Set on `container` itself (not inside innerHTML below) so it survives
    // the wholesale rebuild, same reasoning as applyPanelWidths()'s CSS
    // custom properties.
    container.setAttribute("data-mobile-tab", mobileTab);
    container.innerHTML = `
        ${
          mode === "full"
            ? `<div class="toolbar">
                 <h1>Electronic Catalog — Viewer</h1>
                 <button id="btn-open">Open catalog…</button>
                 <input type="file" id="file-open" accept=".${CATALOG_FILE_EXTENSION},.sch" style="display:none" />
                 <button id="btn-open-remote" title="Open a catalog hosted at a URL">Open remote catalog…</button>
                 <button id="btn-refresh" ${currentSrcUrl || openedFileHandle ? "" : "disabled"} title="Re-read the catalog from its source (URL or local file) — see changes someone else just saved">${refreshing ? "Refreshing…" : "Refresh"}</button>
                 <button id="btn-search" ${db ? "" : "disabled"} title="Search every row in this catalog, not just the current image">Search…</button>
                 <span class="spacer"></span>
                 <button id="btn-theme" title="Toggle light/dark theme">${currentTheme(themeTarget) === "dark" ? "☀️ Light" : "🌙 Dark"}</button>
                 <span class="hint">${escapeHtml(statusMessage)}</span>
                 ${searchOpen ? renderSearchPanel() : ""}
               </div>`
            : ""
        }

        <div class="mobile-tabs">
          <button type="button" class="mobile-tab-btn ${mobileTab === "images" ? "active" : ""}" data-tab="images">Images</button>
          <button type="button" class="mobile-tab-btn ${mobileTab === "stage" ? "active" : ""}" data-tab="stage">Diagram</button>
          <button type="button" class="mobile-tab-btn ${mobileTab === "table" ? "active" : ""}" data-tab="table">Table</button>
        </div>

        <div class="panel-images">
          ${
            images.length === 0
              ? mode === "lite"
                ? `<p class="hint">${escapeHtml(statusMessage || "Loading…")}</p>`
                : `<p class="hint">Open a .${CATALOG_FILE_EXTENSION} catalog file, or try a demo catalog: ${DEMO_CATALOGS.map(
                    (d, i) => `<a href="#" class="open-demo-link" data-demo="${i}">${escapeHtml(d.label)}</a>`,
                  ).join(", ")}.</p>`
              : renderImageList(images)
          }
        </div>

        <div class="panel-divider" id="divider-images" title="Drag to resize"></div>

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

        <div class="panel-divider" id="divider-table" title="Drag to resize"></div>

        <div class="table-panel">
          ${
            activeImage
              ? `<table data-col-key="rows" style="width:${colTableTotalWidth()}px">
                   <colgroup>${colWidths.map((w) => `<col style="width:${w}px">`).join("")}</colgroup>
                   <thead><tr>
                     <th>Name<span class="col-resize-handle" data-col="0"></span></th>
                     <th>SKU<span class="col-resize-handle" data-col="1"></span></th>
                     <th>Description<span class="col-resize-handle" data-col="2"></span></th>
                     <th>Extra<span class="col-resize-handle" data-col="3"></span></th>
                   </tr></thead>
                   <tbody>${rows.map((r) => rowHtml(r, selectedUrl)).join("")}</tbody>
                 </table>`
              : ""
          }
        </div>

        ${
          mode === "full" && remoteDialogOpen
            ? `<div class="open-overlay" id="open-overlay">
                 <div class="open-box">
                   <h2>Open remote catalog</h2>
                   <div class="field">
                     <label for="open-url-input">URL to a .${CATALOG_FILE_EXTENSION} file</label>
                     <input type="text" id="open-url-input" value="${escapeHtml(remoteUrlValue)}" placeholder="https://example.com/catalog.${CATALOG_FILE_EXTENSION}" ${remoteLoading ? "disabled" : ""} />
                   </div>
                   ${
                     remoteError
                       ? `<p class="error">${escapeHtml(remoteError)}</p>`
                       : `<p class="hint">The file's host must allow cross-origin requests (CORS), or loading will fail.</p>`
                   }
                   <div class="open-actions">
                     <button id="open-url-cancel" ${remoteLoading ? "disabled" : ""}>Cancel</button>
                     <button id="open-url-submit" ${remoteLoading || !remoteUrlValue.trim() ? "disabled" : ""}>${remoteLoading ? "Opening…" : "Open"}</button>
                   </div>
                 </div>
               </div>`
            : ""
        }
    `;

    if (savedScroll) {
      const stageScroll = root.getElementById("stage-scroll");
      if (stageScroll) {
        stageScroll.scrollLeft = savedScroll.left;
        stageScroll.scrollTop = savedScroll.top;
      }
    }

    wireEvents();
  }

  /** Two-level list: ungrouped images first, then one heading per folder (see images.ts). */
  function renderImageList(images: CatalogImage[]): string {
    return groupImagesByFolder(images)
      .map((group) => {
        const items = group.images
          .map(
            (img) =>
              `<li data-id="${img.id}" class="${img.id === activeImageId ? "active" : ""}">${escapeHtml(img.name)}</li>`,
          )
          .join("");
        if (group.folder === "") return `<ul class="image-list">${items}</ul>`;
        return `<div class="image-folder"><div class="image-folder-name">${escapeHtml(group.folder)}</div><ul class="image-list">${items}</ul></div>`;
      })
      .join("");
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
    const el = root.getElementById("search-results");
    if (!el) return;
    el.innerHTML = renderSearchResultsList();
    wireSearchResultClicks();
  }

  function wireSearchResultClicks() {
    root.querySelectorAll<HTMLLIElement>("#search-results li[data-url]").forEach((li) => {
      li.addEventListener("click", () => actionGoToSearchResult(Number(li.dataset.imageId), li.dataset.url!));
    });
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
    const buyUrl = typeof r.extra.buy_url === "string" && r.extra.buy_url ? r.extra.buy_url : null;
    const extra = Object.entries(r.extra)
      .filter(([k]) => k !== "buy_url")
      .map(([k, v]) => `${escapeHtml(k)}: ${escapeHtml(String(v))}`)
      .join(", ");
    const cell = (text: string) => `<td><span class="cell-text">${text}</span></td>`;
    const extraCell = `<td><span class="cell-text">${extra}</span>${
      buyUrl
        ? `<a class="buy-btn" href="${escapeHtml(buyUrl)}" target="_blank" rel="noopener noreferrer" title="Buy this item">Buy</a>`
        : ""
    }</td>`;
    return `<tr data-url="${escapeHtml(r.url)}" class="${selected}">${cell(escapeHtml(r.name))}${cell(escapeHtml(r.sku))}${cell(escapeHtml(r.description))}${extraCell}</tr>`;
  }

  function wireEvents() {
    // Only present in "full" mode, same as #btn-open below — never actually
    // null when the listeners it's used in can fire.
    const fileOpen = root.getElementById("file-open") as HTMLInputElement;
    root.getElementById("btn-theme")?.addEventListener("click", () => {
      toggleTheme(themeTarget);
      render();
    });

    root.getElementById("btn-open")?.addEventListener("click", () => void actionOpenFileClicked(fileOpen));
    fileOpen?.addEventListener("change", () => {
      const file = fileOpen.files?.[0];
      if (file) void actionOpenFile(file);
    });

    root.getElementById("btn-open-remote")?.addEventListener("click", actionOpenRemote);
    root.querySelectorAll<HTMLAnchorElement>(".open-demo-link").forEach((link) => {
      link.addEventListener("click", (evt) => {
        evt.preventDefault();
        const demo = DEMO_CATALOGS[Number(link.dataset.demo)];
        if (demo) actionOpenDemo(demo.url);
      });
    });
    root.getElementById("btn-refresh")?.addEventListener("click", () => void actionRefresh());
    root.getElementById("open-url-cancel")?.addEventListener("click", actionCancelRemote);
    root.getElementById("open-url-submit")?.addEventListener("click", () => void actionSubmitRemote());
    const openUrlInput = root.getElementById("open-url-input") as HTMLInputElement | null;
    const openUrlSubmit = root.getElementById("open-url-submit") as HTMLButtonElement | null;
    openUrlInput?.addEventListener("input", () => {
      remoteUrlValue = openUrlInput.value;
      if (openUrlSubmit) openUrlSubmit.disabled = remoteLoading || !openUrlInput.value.trim();
    });
    openUrlInput?.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter" && !openUrlInput.value.trim()) return;
      if (evt.key === "Enter") void actionSubmitRemote();
      if (evt.key === "Escape") actionCancelRemote();
    });
    if (remoteDialogOpen && !remoteLoading) {
      openUrlInput?.focus();
      openUrlInput?.setSelectionRange(openUrlInput.value.length, openUrlInput.value.length);
    }

    root.getElementById("btn-search")?.addEventListener("click", actionToggleSearch);
    const searchInput = root.getElementById("search-input") as HTMLInputElement | null;
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
    root.getElementById("search-field")?.addEventListener("change", (evt) => {
      searchField = (evt.target as HTMLSelectElement).value as SearchField;
      refreshSearchResults();
    });
    wireSearchResultClicks();
    if (searchOpen) searchInput?.focus();

    root.querySelectorAll<HTMLLIElement>(".panel-images li[data-id]").forEach((li) => {
      li.addEventListener("click", () => actionSelectImage(Number(li.dataset.id)));
    });

    root.querySelectorAll<HTMLButtonElement>(".mobile-tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => actionSetMobileTab(btn.dataset.tab as "images" | "stage" | "table"));
    });

    root.getElementById("btn-zoom-in")?.addEventListener("click", () => actionSetZoom(zoom * 1.25));
    root.getElementById("btn-zoom-out")?.addEventListener("click", () => actionSetZoom(zoom / 1.25));
    root.getElementById("btn-zoom-reset")?.addEventListener("click", () => actionSetZoom(1));

    root.getElementById("btn-instance-prev")?.addEventListener("click", () => actionCycleInstance(-1));
    root.getElementById("btn-instance-next")?.addEventListener("click", () => actionCycleInstance(1));

    root.getElementById("stage-scroll")?.addEventListener(
      "wheel",
      (evt) => {
        if (!evt.ctrlKey && !evt.metaKey) return;
        evt.preventDefault();
        actionSetZoom(zoom * Math.exp(-evt.deltaY * 0.001));
      },
      { passive: false },
    );

    const stageImg = root.getElementById("stage-img") as HTMLImageElement | null;
    const stageScroll = root.getElementById("stage-scroll") as HTMLElement | null;
    if (stageImg && stageScroll) {
      stageImg.addEventListener("mousedown", (evt) => startImagePan(evt, stageScroll));
    }

    root.querySelectorAll<HTMLDivElement>(".hotspot[data-id]").forEach((el) => {
      el.addEventListener("click", () => actionSelectHotspot(Number(el.dataset.id)));
    });

    root.querySelectorAll<HTMLTableRowElement>("tr[data-url]").forEach((tr) => {
      tr.addEventListener("click", () => actionSelectRowByUrl(tr.dataset.url!));
    });

    root.getElementById("divider-images")?.addEventListener("mousedown", (evt) => startPanelResize(evt as MouseEvent, "images"));
    root.getElementById("divider-table")?.addEventListener("mousedown", (evt) => startPanelResize(evt as MouseEvent, "table"));
    root.querySelectorAll<HTMLElement>(".col-resize-handle").forEach((handle) => {
      handle.addEventListener("mousedown", (evt) => startColumnResize(evt as MouseEvent, Number(handle.dataset.col)));
    });

    void findRowByUrl; // used indirectly via listRowsForImage today; kept for future direct-lookup use
  }

  void boot();

  return {
    destroy() {
      container.innerHTML = "";
      container.classList.remove("ecm-viewer-app", "mode-full", "mode-lite");
    },
  };
}

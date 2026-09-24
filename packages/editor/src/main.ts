import "./style.css";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import pdfFontUrl from "@ecm/shared/assets/fonts/DejaVuSans.ttf?url";
import {
  EDITOR_LOCALES,
  EDITOR_LOCALE_NAMES,
  appLocaleCandidates,
  createTranslator,
  editorMessages,
  matchLocale,
  pickLocale,
  saveLocale,
  type MessageParams,
  type Translate,
  addImage,
  addLink,
  addRow,
  isNavLink,
  navLinkUrl,
  navTargetImageId,
  CATALOG_FILE_EXTENSION,
  catalogHasAnyBuyUrl,
  collectExtraKeys,
  collectFolders,
  COLLAB_AUTO_DETECT_BASE_PORT,
  createEmptyCatalog,
  createRoom,
  DEFAULT_CART_CHECKOUT_BASE_URL,
  DEFAULT_CART_ID_PATTERN,
  DEFAULT_CART_ITEM_PARAM,
  DEFAULT_PDF_EXPORT_OPTIONS,
  deleteImage,
  deleteLink,
  deleteRoom,
  deleteRow,
  detectFileKind,
  detectLocalCollabServer,
  detectLocalCollabServerViaBridge,
  downloadSnapshot,
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
  isListMode,
  isProtectedCatalog,
  makeCoverThumbnail,
  passwordStrength,
  PROTECT_MAX_COVER_BYTES,
  PROTECT_MIN_PASSWORD_LENGTH,
  protectCatalog,
  readCatalogMode,
  readMeta,
  type CatalogMode,
  renderQrCodeSvg,
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
  type DiagramPageMode,
  type LinkConflict,
  type PdfExportOptions,
  type QrPlacement,
  type SearchField,
  type SqlJsStatic,
} from "@ecm/shared";
import { slugify } from "./slugify";
import {
  CollabConnection,
  listOpsSince,
  type CollabClosedReason,
  type CollabStatus,
  type EditingEntry,
  type EditingMove,
  type Op,
  type PresenceUser,
} from "./collab";
import { clearOutbox, loadOutbox, saveOutbox, type QueuedOp } from "./collabStore";

// Applied before the first render so there's no flash of the wrong theme.
applyTheme(resolveInitialTheme());

// Service Worker registration + the standalone-aware GoatCounter gate —
// see packages/shared/src/pwa.ts.
setUpPwa();

const app = document.getElementById("app")!;

// UI language: saved choice -> browser language -> English (see i18n.ts).
// The editor is a single-instance page, so this is plain module state
// rather than the viewer's per-mount option.
let locale = pickLocale(appLocaleCandidates(EDITOR_LOCALES), EDITOR_LOCALES);
document.documentElement.lang = locale;
const translators = new Map<string, Translate>();
/** Catalog mode picks wording through `key@education` overrides — pass the mode explicitly where it matters (see skuLabel, the store settings dialog). */
function tMode(mode: CatalogMode, key: string, params?: MessageParams): string {
  const cacheKey = `${locale}|${mode}`;
  let translate = translators.get(cacheKey);
  if (!translate) {
    translate = createTranslator({
      messages: editorMessages[locale] ?? {},
      locale,
      fallback: editorMessages.en,
      mode: mode === "commercial" ? undefined : mode,
    });
    translators.set(cacheKey, translate);
  }
  return translate(key, params);
}
function t(key: string, params?: MessageParams): string {
  return tMode("commercial", key, params);
}
document.title = t("toolbar.title");
/** t() for text/attribute positions inside the HTML templates. */
function te(key: string, params?: MessageParams): string {
  return escapeHtml(t(key, params));
}

const CATALOG_PICKER_TYPE: FilePickerAcceptType = {
  description: t("filePicker.description"),
  // .sch: the previous-generation desktop app's format — opened read-write
  // here too, but always as an unattached copy (see openCatalogFromBytes).
  accept: { "application/x-sqlite3": [`.${CATALOG_FILE_EXTENSION}`, ".sch"] },
};

// There's no maintainer-hosted default collab server — self-hosting is the
// only model (see the project's collaboration-hosting design notes). This
// defaults to the standalone @ecm/collab-server app's own default local
// port, so a fresh install of both just works together with nothing to
// configure by hand — actionStartCollaboration() auto-detects a running
// instance rather than relying on this being set correctly ahead of time;
// this value mainly matters as what a fresh join or reconnect uses (set
// from a shared link's `server=` param — see below — or the manual address
// from the "can't find a collaboration server" dialog's escape hatch).
// "localhost", not "127.0.0.1" — both are equally exempt from the mixed-
// content block, but a real live test (2026-09-01) found a Windows browser
// talking to this app running under WSL2 can flat-out refuse a literal
// 127.0.0.1 connection while the same port under "localhost" works fine —
// WSL2's own port forwarding, not this app. See detectLocalCollabServerViaBridge
// and probeCollabServerPort below, which match this choice.
const DEFAULT_COLLAB_SERVER_URL = "http://localhost:8787";
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
// "Export PDF…" — see pdfExport.ts. Both the module itself and the font
// bytes it needs are fetched lazily (dynamic import / cached fetch, see
// actionExportPdf) so opening the editor doesn't cost anyone pdf-lib or the
// ~2MB embedded font unless they actually click the button.
let exportPdfBusy = false;
let pdfFontBytesPromise: Promise<Uint8Array> | null = null;
// Options dialog asked every time "Export PDF…" is clicked (see
// renderPdfOptionsDialog) — chosen values persist across opens within this
// session (last choice wins), same pattern as the viewer's own.
let pdfOptionsDialogOpen = false;
let pdfQrPlacement: QrPlacement = DEFAULT_PDF_EXPORT_OPTIONS.qrPlacement;
let pdfDiagramPageMode: DiagramPageMode = DEFAULT_PDF_EXPORT_OPTIONS.diagramPageMode;
// "Export protected…" dialog (see renderProtectDialog): the password, and the
// public cover shown on the lock screen before it is entered. `protectCoverChoice`
// is "none", "file" (the seller's own picture) or "image:<id>" (one of this
// catalog's images); `protectCover` is the ready-to-embed thumbnail for it and
// `protectCoverUrl` its preview. `protectCoverToken` drops a stale thumbnail
// when the choice changes while an earlier one is still being prepared.
let protectDialogOpen = false;
let protectPassword = "";
let protectRepeat = "";
let protectCoverChoice = "none";
let protectCustomFile: File | null = null;
let protectCover: { mime: string; bytes: Uint8Array } | null = null;
let protectCoverUrl: string | null = null;
let protectCoverBusy = false;
let protectCoverError: string | null = null;
let protectCoverToken = 0;
let protectBusy = false;
let protectFocusPending = false;
let protectError: string | null = null;
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
// Set only by beginCollaboration() (a joiner never gets one — see
// actionJoinCollaboration) and never persisted across a reload. Its only
// use is actionEndSessionForEveryone() (Phase 6) — also what the toolbar's
// "End for everyone" button being shown at all is conditioned on, since
// only its actual holder can end the session for everyone else.
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
// "Store settings" dialog state — edits the catalog's catalog_mode/store_url/
// cart_mode meta (see db.ts updateStoreSettings), which the viewer reads to
// decide how its Buy button behaves and, for catalogMode, which labels/icon
// it shows for Buy/Cart (see viewerEngine.ts cartIcon/cartLabel/buyLabel —
// catalogMode changes no behavior, only on-screen wording). Opened fresh
// from the catalog's current meta each time (not kept live in sync with it),
// same lifecycle as the remote dialog.
let storeSettingsOpen = false;
let storeSettingsCatalogMode: CatalogMode = "commercial";
let storeSettingsUrlValue = "";
let storeSettingsCartMode: "accumulate" | "instant" = "accumulate";
// "Advanced" cart-URL recipe fields — how a combined checkout URL is built
// from several rows' buy_url values (see schema.ts DEFAULT_CART_ID_PATTERN).
// Default to Payhip's own scheme, same as an unset catalog falls back to.
let storeSettingsCartIdPattern = DEFAULT_CART_ID_PATTERN;
let storeSettingsCartItemParam = DEFAULT_CART_ITEM_PARAM;
let storeSettingsCartCheckoutBaseUrl = DEFAULT_CART_CHECKOUT_BASE_URL;
// Which single panel a fresh open of this catalog starts on, below the
// mobile-tab breakpoint — see CatalogMeta.defaultView.
let storeSettingsDefaultView: "images" | "diagram" | "table" = "images";

// "Can't find a collaboration server" dialog — shown when
// actionStartCollaboration()'s auto-detect (see detectLocalCollabServer)
// can't find a running @ecm/collab-server app on any port it might
// plausibly be using. Lets a person retry (after actually starting the
// app) or type in an address by hand for the rare case it's running
// somewhere auto-detect can't reach (a different computer, a custom port).
let collabNotFoundOpen = false;
let collabManualUrlValue = "";

// "Share this session" dialog — the link+QR popup opened by the "Share
// link…" button in the collab status bar (see item 6 of the OneDrive
// backlog: a colleague on a phone can scan it instead of retyping a URL).
// collabShareCopyFeedback briefly flips true right after a successful
// in-dialog copy so the person gets confirmation without needing to see
// the toolbar's status line, which this overlay covers.
let collabShareDialogOpen = false;
let collabShareCopyFeedback = false;

// ---------- presence (Phase 5) ----------
// A small fixed palette rather than an arbitrary generated color — every
// entry is dark/saturated enough to stay readable with white avatar text
// (see renderPresenceAvatar), and every entry is a plain `#rrggbb`, which
// is also the exact shape collab-server/src/server.ts's sanitizeColor()
// (and this file's own sanitizePresenceColor(), for a color that arrived
// over the wire from a peer instead of from here) requires.
const PRESENCE_COLORS = [
  "#e63946",
  "#f77f00",
  "#2a9d8f",
  "#264653",
  "#3a86ff",
  "#8338ec",
  "#d90429",
  "#588157",
  "#ae2012",
  "#6a4c93",
];

// Set once per joined session (see initPresenceIdentity, called when the
// "join as…" name dialog is confirmed) — null whenever this tab isn't
// currently part of a shared session. Regenerated fresh on every new
// start/join, including a rejoin after Leave, matching the plan's "a
// persistent color for the whole session" (not across separate sessions).
let collabClientId: string | null = null;
let collabDisplayName = "";
let collabColor = "";
// The room's currently-active participants, as last reported by the server
// (see connectAndSync's onPresence callback) — kept around across a brief
// reconnect blip rather than cleared, so the roster doesn't flicker empty
// for every dropped connection, only genuinely updates when the server next
// says otherwise.
let collabPresence: PresenceUser[] = [];

// ---------- live editing indicators (2026-09-07 backlog item 8) ----------
// "Who's touching what" balloons — see EditingEntry. Same "last reported by
// the server, kept across a brief reconnect blip" reasoning as collabPresence
// above.
let collabEditing: EditingEntry[] = [];
// The latest live position during someone *else's* drag, keyed by their
// clientId — filled in by editing-move frames, read by renderEditingBalloons
// as an override on top of the hotspot's own (stale, pre-drag) position from
// collabEditing's matching entry. Pruned to just what collabEditing still
// says is actually happening on every roster update, so a drag that ended
// abruptly (a dropped connection, not a clean editing-end) can't leave a
// stale ghost position behind for a *later* drag of the same hotspot to
// wrongly inherit.
const collabEditingMoves = new Map<string, EditingMove>();

/**
 * What this tab has told the room it's currently touching, whenever that's
 * driven by editingLinkId/editingRowId (i.e. "form"/"row" mode — see
 * syncCollabEditingState). Compared against on every render() rather than
 * threaded through editingLinkId/editingRowId's own ~18 assignment sites:
 * render() already runs synchronously right after every one of them, so
 * this never misses a change, and there's exactly one place to keep correct
 * instead of many. Drag ("mode: drag") is unrelated to this — it never
 * touches editingLinkId, so it sends its own start/move/end directly from
 * startDragHotspot instead.
 */
let lastSyncedEditingTarget: { linkId: number | null; rowId: number | null } = { linkId: null, rowId: null };

/**
 * Tells the room what this tab's "Edit link"/"Edit table row" form (if any)
 * is currently open on — a no-op unless that actually changed since the last
 * call. Deliberately doesn't cover "drag" (see lastSyncedEditingTarget's
 * doc). Known gap, not worth guarding against: dragging a *different*
 * hotspot while a form is still open elsewhere sends "drag"'s own
 * editing-end at drop, silently clearing this tab's roster entry even though
 * the form is still open — collab-server's EditingEntry only ever holds one
 * entry per clientId (see its own doc), same simplification presence's
 * single `active` flag already makes.
 */
function syncCollabEditingState(imageId: number | null, linkId: number | null, rowId: number | null, rowUrl: string | null) {
  if (!collab) return;
  if (linkId === lastSyncedEditingTarget.linkId && rowId === lastSyncedEditingTarget.rowId) return;
  if (lastSyncedEditingTarget.linkId !== null || lastSyncedEditingTarget.rowId !== null) collab.sendEditingEnd();
  if (linkId !== null && imageId !== null) collab.sendEditingStart("form", imageId, linkId);
  else if (rowId !== null && imageId !== null && rowUrl !== null) collab.sendEditingStart("row", imageId, undefined, rowUrl);
  lastSyncedEditingTarget = { linkId, rowId };
}

// "Join as…" name dialog — shown once, right before a brand-new
// start/join actually happens (see promptForCollabNameThen), not on every
// reconnect: the identity it establishes is reused for the rest of that
// session's connectAndSync calls.
let collabNameDialogOpen = false;
let collabNameValue = "";
let collabNameDialogOnConfirm: (() => void) | null = null;

function loadCollabDisplayName(): string {
  try {
    return localStorage.getItem("ecm-editor-collab-display-name") ?? "";
  } catch {
    return ""; // localStorage unavailable (privacy mode, etc.)
  }
}

function saveCollabDisplayName(name: string) {
  try {
    localStorage.setItem("ecm-editor-collab-display-name", name);
  } catch {
    // Still applies for this session, just won't be pre-filled next time.
  }
}

// crypto.randomUUID() is spec'd as secure-context-only (unlike
// crypto.getRandomValues(), which isn't) — throws uncaught on a plain-http
// origin. Confirmed live: an http redirect landing an iPad's Safari on the
// insecure origin threw here with no visible error, silently breaking
// "Join". This id is only ever compared for equality, never parsed as a
// real UUID, so the fallback's exact format doesn't matter beyond looking
// like one.
function randomClientId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function initPresenceIdentity(name: string) {
  collabClientId = randomClientId();
  collabDisplayName = name;
  collabColor = PRESENCE_COLORS[Math.floor(Math.random() * PRESENCE_COLORS.length)]!;
  saveCollabDisplayName(name);
}

/**
 * Tab visible + recent mouse/keyboard activity — the same "real visitor vs
 * abandoned tab" idea a lot of secured sites already use for their own
 * session timeouts (see the plan doc for Phase 5), not merely "the socket
 * is open". Module-level and wired once (see the bottom of this file),
 * regardless of whether a shared session is currently open — cheap either
 * way, and it means the very first presence-hello (right after connecting)
 * already reflects a real, current reading instead of a hardcoded "true".
 */
const PRESENCE_IDLE_TIMEOUT_MS = 60_000;
let lastActivityAt = Date.now();
let presenceActive = true;

function isPresenceActive(): boolean {
  return document.visibilityState === "visible" && Date.now() - lastActivityAt < PRESENCE_IDLE_TIMEOUT_MS;
}

function notePresenceActivity() {
  lastActivityAt = Date.now();
  reconcilePresenceActive();
}

/** Only actually sends anything when the active/idle reading has flipped — called far more often than that (every mouse move), so this is what keeps that cheap. */
function reconcilePresenceActive() {
  const next = isPresenceActive();
  if (next === presenceActive) return;
  presenceActive = next;
  if (collab && collabRoomId) collab.sendPresenceActive(presenceActive);
}

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
  rows: [60, 120, 70, 120, 140], // URL, Name, SKU, Description, Extra
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
 *
 * Pointer Events, not Mouse Events — the mouse-only version never fired
 * on a touchscreen at all (Safari/iPadOS only synthesizes mouse events for
 * a simple tap, never for a sustained drag), and `touch-action: none` on
 * `.panel-divider` (style.css) is what actually stops the browser from
 * treating the drag as a page scroll before this code ever sees it.
 * `setPointerCapture` keeps events coming even if the finger/cursor slides
 * off the thin divider mid-drag; the pointerId check guards against a
 * stray second touch confusing an in-progress drag.
 */
function startPanelResize(evt: PointerEvent, side: "images" | "inspector") {
  evt.preventDefault();
  const divider = evt.currentTarget as HTMLElement;
  const pointerId = evt.pointerId;
  divider.setPointerCapture(pointerId);
  const startX = evt.clientX;
  const startWidth = side === "images" ? imagesPanelWidth : inspectorPanelWidth;
  divider.classList.add("dragging");

  function onMove(moveEvt: PointerEvent) {
    if (moveEvt.pointerId !== pointerId) return;
    const dx = moveEvt.clientX - startX;
    // The inspector sits on the right, so dragging its divider left (dx < 0) should grow it.
    const raw = side === "images" ? startWidth + dx : startWidth - dx;
    const width = Math.min(PANEL_WIDTH_LIMITS.max, Math.max(PANEL_WIDTH_LIMITS.min, raw));
    if (side === "images") imagesPanelWidth = width;
    else inspectorPanelWidth = width;
    applyPanelWidths();
  }
  function onUp(upEvt: PointerEvent) {
    if (upEvt.pointerId !== pointerId) return;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    divider.classList.remove("dragging");
    try {
      localStorage.setItem(side === "images" ? "ecm-editor-images-width" : "ecm-editor-inspector-width", String(side === "images" ? imagesPanelWidth : inspectorPanelWidth));
    } catch {
      // Width still applies for this session, just won't persist.
    }
  }
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}

/** Drags a column-resize handle in the "Links on this image" or "Table (N rows)" list. Pointer Events — see startPanelResize's doc for why. */
function startColumnResize(evt: PointerEvent, tableKey: ColTableKey, colIndex: number) {
  evt.preventDefault();
  evt.stopPropagation();
  const handle = evt.currentTarget as HTMLElement;
  const pointerId = evt.pointerId;
  handle.setPointerCapture(pointerId);
  const startX = evt.clientX;
  const startWidth = colWidths[tableKey][colIndex] ?? COL_WIDTH_LIMITS.min;
  handle.classList.add("dragging");

  function onMove(moveEvt: PointerEvent) {
    if (moveEvt.pointerId !== pointerId) return;
    const width = Math.min(COL_WIDTH_LIMITS.max, Math.max(COL_WIDTH_LIMITS.min, startWidth + (moveEvt.clientX - startX)));
    colWidths[tableKey][colIndex] = width;
    const table = document.querySelector<HTMLTableElement>(`table[data-col-key="${tableKey}"]`);
    const col = table?.querySelectorAll("col")[colIndex] as HTMLElement | undefined;
    if (col) col.style.width = `${width}px`;
    if (table) table.style.width = `${colTableTotalWidth(tableKey)}px`;
  }
  function onUp(upEvt: PointerEvent) {
    if (upEvt.pointerId !== pointerId) return;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    handle.classList.remove("dragging");
    saveColWidths(tableKey);
  }
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
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
// collabServerUrl too (not just used for this one join) so a later
// reconnect or reload of this same tab still knows where to look.
const initialCollabServerParam = new URLSearchParams(location.search).get("server");

async function boot() {
  app.innerHTML = `<p style="padding:1rem">${te("boot.loadingSqlite")}</p>`;
  SQL = await initSqlite(wasmUrl);
  if (initialCollabParam) {
    if (initialCollabServerParam) saveCollabServerUrl(initialCollabServerParam);
    promptForCollabNameThen(() => void actionJoinCollaboration(initialCollabParam));
  } else if (initialSrcParam) {
    await loadInitialFromUrl(initialSrcParam);
  } else {
    render();
  }
}

async function loadInitialFromUrl(url: string) {
  app.innerHTML = `<p style="padding:1rem">${te("boot.loadingCatalog")}</p>`;
  let bytes: Uint8Array;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    statusMessage = t("status.loadFailed", { url, message: (err as Error).message });
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
  const name = prompt(t("catalog.newPrompt"), t("catalog.untitled"));
  if (name === null) return;
  db = createEmptyCatalog(SQL, name || t("catalog.untitled"));
  activeImageId = null;
  openedFileHandle = null;
  resetTransientEditState();
  mobileTab = "images"; // fresh catalog — start from the image list, same as opening one
  setStatus(t("catalog.created", { name: name || t("catalog.untitled") }));
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
  sourceName = t("legacy.sourceName"),
  fileStamp: { size: number; lastModified: number } | null = null,
) {
  // Opening a different local file while still connected to a shared
  // session for a *different* catalog would silently keep sending that
  // session edits meant for this new one — leave it instead of guessing.
  if (collab) actionLeaveCollaboration();
  try {
    if (isProtectedCatalog(bytes)) {
      // The editor works on the plain catalog; a protected copy is only for
      // handing out (see actionOpenProtectDialog), so say so instead of failing obscurely.
      setStatus(t("status.protectedNotEditable"));
      return;
    }
    const kind = detectFileKind(SQL, bytes);
    if (kind === "legacy-sch") {
      setStatus(t("status.converting"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      const result = await importSchCatalog(SQL, bytes, sourceName);
      db = result.db;
      activeImageId = currentImages()[0]?.id ?? null;
      openedFileHandle = null;
      openedFileStamp = null;
      resetTransientEditState();
      mobileTab = "images"; // fresh catalog — start from the image list
      setStatus(
        t(result.skippedDiagrams ? "status.convertedSkipped" : "status.converted", {
          name: sourceName,
          count: result.imageCount,
          skipped: result.skippedDiagrams,
          ext: CATALOG_FILE_EXTENSION,
        }),
      );
    } else {
      db = openCatalog(SQL, bytes);
      const meta = readMeta(db);
      activeImageId = currentImages()[0]?.id ?? null;
      openedFileHandle = handle;
      openedFileStamp = handle ? fileStamp : null;
      resetTransientEditState();
      mobileTab = "images"; // fresh catalog — start from the image list
      setStatus(t("catalog.opened", { name: meta.catalogName }));
    }
  } catch (err) {
    setStatus(t("status.openFailed", { message: (err as Error).message }));
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
        setStatus(t("status.openFailed", { message: (err as Error).message }));
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
  storeSettingsCatalogMode = meta.catalogMode;
  storeSettingsUrlValue = meta.storeUrl;
  storeSettingsCartMode = meta.cartMode;
  storeSettingsCartIdPattern = meta.cartIdPattern;
  storeSettingsCartItemParam = meta.cartItemParam;
  storeSettingsCartCheckoutBaseUrl = meta.cartCheckoutBaseUrl;
  storeSettingsDefaultView = meta.defaultView;
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
    catalogMode: storeSettingsCatalogMode,
    storeUrl: storeSettingsUrlValue.trim(),
    cartMode: storeSettingsCartMode,
    cartIdPattern: storeSettingsCartIdPattern.trim() || DEFAULT_CART_ID_PATTERN,
    cartItemParam: storeSettingsCartItemParam.trim() || DEFAULT_CART_ITEM_PARAM,
    cartCheckoutBaseUrl: storeSettingsCartCheckoutBaseUrl.trim() || DEFAULT_CART_CHECKOUT_BASE_URL,
    defaultView: storeSettingsDefaultView,
  });
  storeSettingsOpen = false;
  setStatus(t("store.updated"));
}

function actionCancelCollabNotFound() {
  collabNotFoundOpen = false;
  render();
}

/** Retries the whole auto-detect from scratch — the normal "I started the app, now let me try again" path. */
async function actionRetryCollabDetect() {
  collabNotFoundOpen = false;
  await actionStartCollaboration();
}

/** The "it's running somewhere auto-detect can't reach" escape hatch — skips detection entirely and goes straight to using the typed address. */
function actionUseManualCollabUrl() {
  const url = collabManualUrlValue.trim();
  if (!url) return;
  collabNotFoundOpen = false;
  // Same "brand-new shared session starting" moment as the auto-detected
  // path above (line ~1243) — a real live test caught this route skipping
  // the name prompt entirely: the session's own initiator never got asked
  // for a display name and so never showed up in their own presence
  // roster, while a colleague joining via the link (which does go through
  // promptForCollabNameThen) showed up fine. Not specific to this escape
  // hatch's usual reason (a server on another machine) — it's also what a
  // host on *this* machine now has to use whenever loopback auto-detect
  // itself is blocked (e.g. Chrome's Local Network Access), which is
  // exactly how this was found.
  promptForCollabNameThen(() => void beginCollaboration(url));
}

function suggestedFileName(): string {
  const meta = db ? readMeta(db) : null;
  const base = meta?.catalogName.replace(/[^\w\-]+/g, "_") || "catalog";
  return `${base}.${CATALOG_FILE_EXTENSION}`;
}

function downloadBytes(bytes: Uint8Array, fileName = suggestedFileName()) {
  const blob = new Blob([bytes as BlobPart], { type: "application/x-sqlite3" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Always downloads a fresh copy — never touches whatever file was opened. */
function actionExportCatalog() {
  if (!db) return;
  downloadBytes(exportCatalog(db));
}

/** The protected copy gets its own name so it can never overwrite the editable file saved next to it. */
function suggestedProtectedFileName(): string {
  const meta = db ? readMeta(db) : null;
  const base = meta?.catalogName.replace(/[^\w\-]+/g, "_") || "catalog";
  return `${base}_protected.${CATALOG_FILE_EXTENSION}`;
}

function setProtectCoverUrl(url: string | null) {
  if (protectCoverUrl) URL.revokeObjectURL(protectCoverUrl);
  protectCoverUrl = url;
}

/** Opens "Export protected…" with the catalog's first image preselected as the cover — the seller can change or drop it. */
function actionOpenProtectDialog() {
  if (!db) return;
  protectDialogOpen = true;
  protectPassword = "";
  protectRepeat = "";
  protectCustomFile = null;
  protectError = null;
  protectFocusPending = true;
  const first = currentImages()[0];
  protectCoverChoice = first ? `image:${first.id}` : "none";
  render();
  void refreshProtectCover();
}

function actionCloseProtectDialog() {
  if (protectBusy) return;
  protectDialogOpen = false;
  protectCoverToken++; // an in-flight thumbnail must not repaint a closed dialog
  protectCoverBusy = false;
  setProtectCoverUrl(null);
  protectCover = null;
  render();
}

/** Prepares the thumbnail for whatever `protectCoverChoice` currently points at. */
async function refreshProtectCover() {
  const token = ++protectCoverToken;
  protectCoverError = null;
  let source: Blob | null = null;
  if (protectCoverChoice.startsWith("image:") && db) {
    const img = currentImages().find((i) => i.id === Number(protectCoverChoice.slice("image:".length)));
    if (img) source = await (await fetch(`data:${img.mimeType};base64,${img.imageData}`)).blob();
  } else if (protectCoverChoice === "file") {
    source = protectCustomFile;
  }
  if (!source) {
    protectCover = null;
    setProtectCoverUrl(null);
    protectCoverBusy = false;
    if (protectDialogOpen) render();
    return;
  }
  protectCoverBusy = true;
  protectCover = null;
  setProtectCoverUrl(null);
  render();
  try {
    const cover = await makeCoverThumbnail(source);
    if (token !== protectCoverToken) return;
    protectCover = cover;
    setProtectCoverUrl(URL.createObjectURL(new Blob([cover.bytes as BlobPart], { type: cover.mime })));
  } catch (err) {
    if (token !== protectCoverToken) return;
    protectCoverError = t("protect.cover.failed", { message: err instanceof Error ? err.message : String(err) });
  }
  protectCoverBusy = false;
  if (protectDialogOpen) render();
}

/** Whether the dialog's fields allow submitting; also drives the live-patched button state. */
function protectFormProblem(): "short" | "mismatch" | "cover" | null {
  if ([...protectPassword].length < PROTECT_MIN_PASSWORD_LENGTH) return "short";
  if (protectPassword !== protectRepeat) return "mismatch";
  if (protectCoverBusy || (protectCoverChoice === "file" && !protectCover)) return "cover";
  return null;
}

async function actionConfirmProtect() {
  if (!db || protectBusy || protectFormProblem()) return;
  protectBusy = true;
  protectError = null;
  render();
  try {
    const bytes = await protectCatalog(exportCatalog(db), protectPassword, {
      name: readMeta(db).catalogName,
      cover: protectCoverChoice === "none" ? null : protectCover,
    });
    const fileName = suggestedProtectedFileName();
    downloadBytes(bytes, fileName);
    protectBusy = false;
    protectDialogOpen = false;
    protectCoverToken++;
    setProtectCoverUrl(null);
    protectCover = null;
    protectPassword = "";
    protectRepeat = "";
    setStatus(t("protect.done", { name: fileName }));
  } catch (err) {
    protectBusy = false;
    protectError = t("protect.failed", { message: err instanceof Error ? err.message : String(err) });
    render();
  }
}

function suggestedPdfFileName(): string {
  const meta = db ? readMeta(db) : null;
  const base = meta?.catalogName.replace(/[^\w-]+/g, "_") || "catalog";
  return `${base}.pdf`;
}

/** Opens the "Export PDF…" options dialog — the button's own click handler; the actual export happens in actionConfirmExportPdf once it's submitted. */
function actionOpenPdfOptions() {
  if (!db || exportPdfBusy) return;
  pdfOptionsDialogOpen = true;
  render();
}

function actionCancelPdfOptions() {
  pdfOptionsDialogOpen = false;
  render();
}

/**
 * Builds and downloads the whole catalog as a printable A4 PDF — see
 * pdfExport.ts — using whatever the options dialog last had selected.
 * Offered in the editor too (see backlog discussion) so the author can
 * check the result — QR placement, page breaks — without leaving the
 * editor to open the same file in the viewer.
 */
async function actionConfirmExportPdf() {
  if (!db || exportPdfBusy) return;
  pdfOptionsDialogOpen = false;
  exportPdfBusy = true;
  render();
  try {
    if (!pdfFontBytesPromise) {
      pdfFontBytesPromise = fetch(pdfFontUrl)
        .then((r) => r.arrayBuffer())
        .then((buf) => new Uint8Array(buf));
    }
    // Relative, not a bare "@ecm/shared" import — the package's own barrel
    // (index.ts) deliberately doesn't re-export this module, so pdf-lib
    // isn't pulled into this app's main bundle for everyone who never
    // clicks this button. See index.ts's own comment on that export.
    const [{ exportCatalogPdf }, fontBytes] = await Promise.all([import("../../shared/src/pdfExport.js"), pdfFontBytesPromise]);
    const options: PdfExportOptions = { qrPlacement: pdfQrPlacement, diagramPageMode: pdfDiagramPageMode };
    const bytes = await exportCatalogPdf(db, fontBytes, options);
    const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = suggestedPdfFileName();
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (err) {
    pdfFontBytesPromise = null; // let a retry re-fetch, in case the failure was a network blip fetching the font
    statusMessage = t("pdf.failed", { message: err instanceof Error ? err.message : String(err) });
  } finally {
    exportPdfBusy = false;
    render();
  }
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
        setStatus(t("status.saveLocationFailed", { message: (err as Error).message }));
      }
      return;
    }
  }

  if (openedFileHandle) {
    if (openedFileStamp && (await fileChangedOnDisk(openedFileHandle, openedFileStamp))) {
      askConfirm(
        t("status.changedOnDisk", { name: openedFileHandle.name }),
        () => void writeToOpenedHandle(bytes),
      );
      return;
    }
    await writeToOpenedHandle(bytes);
    return;
  }

  downloadBytes(bytes);
  setStatus(t("status.downloadedCopy"));
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
    setStatus(t("status.saved", { name: openedFileHandle.name }));
  } catch (err) {
    setStatus(t("status.saveFailed", { message: (err as Error).message }));
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
    setStatus(t("collab.status.remoteOpFailed", { message: (err as Error).message }));
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
      return t("op.row", { name: input.name || t("op.empty"), sku: input.sku || t("op.empty") });
    }
    case "deleteRow":
      return t("op.rowDeleted");
    case "updateLink": {
      const input = args[1] as { name: string; url: string };
      return t("op.link", { name: input.name, url: input.url });
    }
    case "deleteLink":
      return t("op.linkDeleted");
    case "updateLinkPosition":
      return t("op.linkPosition", { top: String(args[1]), left: String(args[2]) });
    case "updateImage": {
      const input = args[1] as { name: string; folder: string };
      return input.folder ? t("op.imageFolder", { name: input.name, folder: input.folder }) : t("op.image", { name: input.name });
    }
    case "deleteImage":
      return t("op.imageDeleted");
    case "updateStoreSettings": {
      const input = args[0] as { storeUrl: string };
      return t("op.storeSettings", { url: input.storeUrl });
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
      .map(({ queued, theirs }) =>
        t("collab.conflict.pair", { yours: describeOp(queued.fn, queued.args), current: describeOp(theirs.fn, theirs.args) }),
      )
      .join("\n\n");
    askConfirm(
      t("collab.conflict", { count: n, details }),
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
    (users) => {
      collabPresence = users;
      updatePresenceRosterDisplay();
    },
    (editors) => {
      collabEditing = editors;
      // A drag that ended abruptly (a dropped connection, not a clean
      // editing-end) leaves no editing-roster entry behind — drop its
      // last-known live position too, so a *later* drag of the same
      // hotspot by someone else can't wrongly inherit it for one frame.
      for (const clientId of [...collabEditingMoves.keys()]) {
        if (!editors.some((e) => e.clientId === clientId && e.mode === "drag")) collabEditingMoves.delete(clientId);
      }
      updateEditingBalloonsDisplay();
    },
    (move) => {
      collabEditingMoves.set(move.clientId, move);
      updateEditingBalloonsDisplay();
    },
    (reason) => handleCollabClosed(reason),
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

  // Re-announced on every reconnect too, not just the first connect — a
  // fresh WebSocket is a fresh connection server-side even with the same
  // clientId, so without this a reconnect would silently stay off
  // everyone else's roster. collabClientId is only ever unset if this got
  // called outside the normal start/join path, which shouldn't happen.
  if (collabClientId) collab.sendPresenceHello(collabClientId, collabDisplayName, collabColor, presenceActive);

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

// Bounded local-collab-server port range + auto-detect (plain scan, then
// the Local Network Access bridge fallback) now live in
// packages/shared/src/collabClient.ts, shared with the viewer's "Share
// view…" (see COLLAB_AUTO_DETECT_BASE_PORT/_PORT_COUNT, detectLocalCollabServer,
// detectLocalCollabServerViaBridge, imported from "@ecm/shared" above).

/** Kicks off a brand-new shared session — auto-detects a running collab-server app first (see detectLocalCollabServer) rather than relying on anyone having typed an address in anywhere. */
async function actionStartCollaboration() {
  if (!db) return;
  setStatus(t("collab.status.looking"));
  const detected = (await detectLocalCollabServer()) ?? (await detectLocalCollabServerViaBridge(COLLAB_AUTO_DETECT_BASE_PORT));
  if (!detected) {
    // Deliberately blank, not collabServerUrl — that's very often the
    // address of a server that *used* to be running (e.g. this same
    // computer's, from an earlier session) and just got stopped, which
    // auto-detect already ruled out above. Pre-filling it here reads as
    // the app claiming to already know a live address, which it doesn't;
    // a real bug report from the user confirmed this was genuinely
    // confusing in exactly that scenario, not just a hypothetical.
    collabManualUrlValue = "";
    collabNotFoundOpen = true;
    setStatus(t("collab.status.notFound"));
    return;
  }
  if (!detected.hasPublicUrl) {
    pendingConfirmation = {
      message: t("collab.confirm.noPublicUrl"),
      onConfirm: () => promptForCollabNameThen(() => void beginCollaboration(detected.url)),
    };
    render();
    return;
  }
  promptForCollabNameThen(() => void beginCollaboration(detected.url));
}

/**
 * Shows the "join as…" name dialog, then runs `action` once a name's been
 * confirmed (see initPresenceIdentity) — used right before both ways a
 * brand-new shared session actually begins (starting one, joining one via
 * a link), never on a plain reconnect: connectAndSync reuses whatever
 * identity this already established for the rest of that session.
 */
function promptForCollabNameThen(action: () => void) {
  collabNameValue = loadCollabDisplayName();
  collabNameDialogOnConfirm = action;
  collabNameDialogOpen = true;
  render();
}

function actionCancelCollabNameDialog() {
  collabNameDialogOpen = false;
  collabNameDialogOnConfirm = null;
  render();
}

function actionSubmitCollabNameDialog() {
  const name = collabNameValue.trim();
  if (!name) return; // the submit button is disabled for this too — see wireEvents
  collabNameDialogOpen = false;
  const action = collabNameDialogOnConfirm;
  collabNameDialogOnConfirm = null;
  initPresenceIdentity(name);
  render();
  action?.();
}

/** Uploads the current catalog as a brand-new shared session against `serverUrl` and connects to it. */
async function beginCollaboration(serverUrl: string) {
  if (!db) return;
  saveCollabServerUrl(serverUrl);
  setStatus(t("collab.status.starting"));
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
    setStatus(t("collab.status.started"));
  } catch (err) {
    setStatus(collabErrorMessage("start", err));
  }
}

/** Joins an existing shared session by id — downloads its original snapshot, replays the full history, then catches up via connectAndSync. */
async function actionJoinCollaboration(roomId: string) {
  setStatus(t("collab.status.joining"));
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
    setStatus(t("collab.status.joined"));
  } catch (err) {
    setStatus(collabErrorMessage("join", err));
  }
}

/**
 * A failed join (or, more rarely, a create that got past auto-detect but
 * still failed) is very often just "nothing's listening at collabServerUrl
 * anymore" — e.g. a shared link's server has since been stopped — rather
 * than an actual server-side rejection. The raw fetch error alone ("Failed
 * to fetch") doesn't tell a non-technical person that; naming the address
 * it tried does.
 */
function collabErrorMessage(action: "start" | "join" | "end", err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return t(`collab.error.${action}`, { server: collabServerUrl, detail });
}

/**
 * Tears down every bit of this tab's local collaboration state — shared by
 * a deliberate Leave, and by the two ways a session can end out from under
 * this tab entirely (see handleCollabClosed below). Never shows a status
 * message itself — every caller picks whatever wording fits how it got
 * here.
 */
function exitCollaboration() {
  const roomId = collabRoomId;
  collabRoomId = null; // first, so a reconnect already in flight (or a status callback about to fire from collab.close() below) becomes a no-op
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  collab?.close();
  collab = null;
  collabOwnerToken = null;
  collabStatus = "disconnected";
  // The server already drops this tab's presence entry on the socket
  // closing — this just clears the local echo of it (and this tab's own
  // identity, so a later restart gets a fresh name prompt and color, per
  // "persistent for the whole session" rather than forever).
  collabPresence = [];
  collabClientId = null;
  collabEditing = [];
  collabEditingMoves.clear();
  // A later start/join gets a brand-new connection — reset so its very
  // first render() re-sends this tab's current form state (if any) to it,
  // rather than staying silent because it looks unchanged from what the
  // now-dead connection was last told.
  lastSyncedEditingTarget = { linkId: null, rowId: null };
  outbox = [];
  if (roomId) void clearOutbox(roomId);
}

/** Disconnects this tab only — the room itself and everyone else in it are unaffected. Ending it for everyone is actionEndSessionForEveryone(), a separate, deliberate action. */
function actionLeaveCollaboration() {
  exitCollaboration();
  setStatus(t("collab.status.left"));
}

// Set for the duration of actionEndSessionForEveryone()'s own DELETE call.
// This tab is still subscribed to the room while that request is in
// flight, so its own "room-closed" broadcast can arrive back over the WS
// before (or after — no ordering guarantee between an HTTP response and a
// WS frame) the fetch() call itself resolves; this flag lets
// handleCollabClosed recognize that echo as its own doing and skip
// showing a redundant "session closed" notice on top of the one this
// action already shows once the fetch resolves.
let endingCollabSelf = false;

/** Only ever reachable when collabOwnerToken is set — the toolbar button this backs is hidden otherwise (a joiner never holds the owner token; see actionJoinCollaboration). */
async function actionEndSessionForEveryone() {
  if (!collabRoomId || !collabOwnerToken) return;
  const roomId = collabRoomId;
  const ownerToken = collabOwnerToken;
  endingCollabSelf = true;
  try {
    await deleteRoom(collabServerUrl, roomId, ownerToken, collabDisplayName);
    exitCollaboration();
    setStatus(t("collab.status.ended"));
  } catch (err) {
    setStatus(collabErrorMessage("end", err));
  } finally {
    endingCollabSelf = false;
  }
}

function actionConfirmEndSessionForEveryone() {
  if (!collabRoomId) return;
  pendingConfirmation = {
    message:
      t("collab.confirm.end"),
    onConfirm: actionEndSessionForEveryone,
  };
  render();
}

/**
 * A session ending out from under this tab, not by this tab's own choice —
 * either someone (possibly this same tab, see endingCollabSelf above) ended
 * it for everyone, or the whole collaboration-server process is going away
 * (Stop button, Ctrl+C, the host's computer sleeping — see the project's
 * Phase 4 self-hosting trade-off). Shown as a real notice, not folded into
 * the ordinary "disconnected" status — that status is also what a genuine
 * network blip looks like, and just quietly retrying every few seconds
 * into a session that's actually gone for good isn't an honest reflection
 * of what happened, which is the whole point of this existing.
 */
function handleCollabClosed(reason: CollabClosedReason) {
  if (endingCollabSelf) return; // this tab's own actionEndSessionForEveryone() already handled its own echo
  exitCollaboration();
  const message =
    reason.kind === "room-closed"
      ? reason.by
        ? t("collab.closed.byName", { by: reason.by })
        : t("collab.closed.ended")
      : t("collab.closed.serverStopped");
  // Both the modal (the actual point of this — see this function's own doc)
  // and the toolbar's corner hint, so it doesn't keep reading something
  // stale like "Joined the shared session" after the modal's dismissed.
  statusMessage = message;
  pendingNotice = message;
  render();
}

function actionOpenCollabShareDialog() {
  collabShareCopyFeedback = false;
  collabShareDialogOpen = true;
  render();
}

function actionCloseCollabShareDialog() {
  collabShareDialogOpen = false;
  render();
}

async function actionCopyCollabLink() {
  if (!collabRoomId) return;
  try {
    await navigator.clipboard.writeText(collabShareLink());
    setStatus(t("collab.status.linkCopied"));
    // The dialog's overlay sits on top of the toolbar status line above, so
    // it gets its own transient "Copied!" next to the button instead.
    collabShareCopyFeedback = true;
    render();
    setTimeout(() => {
      collabShareCopyFeedback = false;
      render();
    }, 1500);
  } catch {
    setStatus(t("collab.status.copyFailed", { link: collabShareLink() }));
  }
}

// ---------- actions: images ----------

async function actionAddImage(file: File) {
  if (!db) return;
  const dataUrl = await fileToDataUrl(file);
  const [, mimeType, base64] = dataUrl.match(/^data:([^;]+);base64,(.*)$/s) ?? [];
  if (!base64) {
    setStatus(t("image.imageReadFailed"));
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
  setStatus(t("image.added", { name: file.name }));
}

/** Renames the active image, moves it into a different (or no) folder, and/or sets "fit when opened". */
function actionUpdateImageMeta() {
  if (!db || activeImageId === null) return;
  const nameInput = document.getElementById("image-name-input") as HTMLInputElement | null;
  const folderInput = document.getElementById("image-folder-input") as HTMLInputElement | null;
  const fitInput = document.getElementById("image-fit-input") as HTMLInputElement | null;
  const name = nameInput?.value.trim() || t("image.untitled");
  const folder = folderInput?.value.trim() ?? "";
  applyAndBroadcast("updateImage", updateImage, activeImageId, { name, folder, fitOnOpen: fitInput?.checked ?? false });
  setStatus(t("image.updated", { name }));
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
    notify(t("image.cantDelete", { name: image?.name ?? t("image.thisImage"), count: linkCount }));
    return;
  }
  const rowCount = listRowsForImage(db, imageId).length;
  const imageName = image?.name ?? t("image.thisImage");
  const confirmMessage = rowCount
    ? t("image.confirmDeleteRows", { name: imageName, count: rowCount })
    : t("image.confirmDelete", { name: imageName });
  askConfirm(confirmMessage, () => {
    if (!db) return;
    applyAndBroadcast("deleteImage", deleteImage, imageId);
    if (activeImageId === imageId) {
      activeImageId = currentImages()[0]?.id ?? null;
      resetTransientEditState();
    }
    setStatus(t("image.deleted", { name: image?.name ?? t("image.imageWord") }));
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
 *
 * Pointer Events, not Mouse Events — see startPanelResize's doc for why a
 * touchscreen (tested live on an iPad) needs this and `touch-action: none`
 * on `.stage-inner img` (style.css) rather than the old mouse-only
 * handlers: a tap still synthesizes mouse events on iOS/Safari, which is
 * why placing a hotspot by tapping looked like it *should* work, but a
 * sustained drag (panning, or dragging an existing hotspot below) never
 * did, since no synthetic `mousemove` stream ever follows a real touch-
 * drag — only `pointermove` does, uniformly for mouse/touch/pen.
 */
function startStageInteraction(evt: PointerEvent, img: HTMLImageElement, scrollEl: HTMLElement) {
  evt.preventDefault();
  const pointerId = evt.pointerId;
  img.setPointerCapture(pointerId);
  const rect = img.getBoundingClientRect();
  const startX = evt.clientX;
  const startY = evt.clientY;
  const startScrollLeft = scrollEl.scrollLeft;
  const startScrollTop = scrollEl.scrollTop;
  let moved = false;

  function onMove(moveEvt: PointerEvent) {
    if (moveEvt.pointerId !== pointerId) return;
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

  function onUp(upEvt: PointerEvent) {
    if (upEvt.pointerId !== pointerId) return;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
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

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
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
 *
 * Pointer Events, not Mouse Events — see startStageInteraction's doc for
 * why (this is the other half of the same iPad-drag bug: a tap-to-edit
 * already worked via synthesized mouse events, but dragging a hotspot to
 * reposition it never did). `touch-action: none` lives on `.hotspot`
 * (style.css).
 */
function startDragHotspot(evt: PointerEvent, link: CatalogLink, el: HTMLElement, img: HTMLImageElement) {
  evt.preventDefault();
  evt.stopPropagation();
  hideCrosshair(); // dragging an existing hotspot, not placing a new one
  const pointerId = evt.pointerId;
  el.setPointerCapture(pointerId);
  const rect = img.getBoundingClientRect();
  const startX = evt.clientX;
  const startY = evt.clientY;
  let top = link.top;
  let left = link.left;
  let moved = false;
  el.classList.add("dragging");
  // Announced lazily, on the first real movement (not on pointerdown) — a
  // plain click-to-open-the-form gesture starts exactly the same way as a
  // drag until it's clear which one this is, and a click shouldn't flash a
  // "moving hotspot" balloon at everyone else for one frame.
  let editingStartSent = false;
  let lastMoveSentAt = 0;
  const EDITING_MOVE_THROTTLE_MS = 80; // frequent enough to read as live movement, not so frequent it floods the room over a long drag

  function onMove(moveEvt: PointerEvent) {
    if (moveEvt.pointerId !== pointerId) return;
    if (Math.abs(moveEvt.clientX - startX) > 3 || Math.abs(moveEvt.clientY - startY) > 3) moved = true;
    top = Math.round((moveEvt.clientY - rect.top) / zoom);
    left = Math.round((moveEvt.clientX - rect.left) / zoom);
    el.style.top = `${top}px`;
    el.style.left = `${left}px`;
    if (moved && activeImageId !== null) {
      if (!editingStartSent) {
        editingStartSent = true;
        collab?.sendEditingStart("drag", activeImageId, link.id);
        lastMoveSentAt = performance.now();
      } else if (performance.now() - lastMoveSentAt >= EDITING_MOVE_THROTTLE_MS) {
        lastMoveSentAt = performance.now();
        collab?.sendEditingMove(link.id, top, left);
      }
    }
  }

  function onUp(upEvt: PointerEvent) {
    if (upEvt.pointerId !== pointerId) return;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    if (editingStartSent) collab?.sendEditingEnd();
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

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
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
 * Steps to the next/previous hotspot sharing the currently edited link's
 * url, wrapping around — same behavior as the viewer's instance-nav
 * (viewerEngine.ts's actionCycleInstance), for a part drawn in several
 * spots on the same diagram.
 */
function actionCycleInstance(delta: number) {
  if (!db || activeImageId === null || editingLinkId === null) return;
  const links = listLinksForImage(db, activeImageId);
  const current = links.find((l) => l.id === editingLinkId);
  if (!current) return;
  const siblings = links.filter((l) => l.url === current.url).sort((a, b) => a.id - b.id);
  const index = siblings.findIndex((l) => l.id === editingLinkId);
  if (index === -1) return;
  const next = siblings[(index + delta + siblings.length) % siblings.length];
  if (next) actionEditLink(next.id);
}

/**
 * Scrolls the inspector panel so the just-opened "Edit link" form is
 * visible. Runs on every path that opens it — clicking a hotspot directly
 * on the image (where the inspector's current scroll position has nothing
 * to do with where the form ends up) and clicking a row in "Links on this
 * image" (whose form renders *above* the list in the DOM, so on an image
 * with many hotspots a preserved scroll position can leave it off-screen).
 *
 * Also nudges the highlighted row itself into view within its own list —
 * "Links on this image" is capped to ~10 rows with its own internal scroll
 * (see .table-scroll in style.css), independent of the inspector panel's
 * scroll that the line above handles. Without this, clicking a hotspot far
 * down a long list (or stepping through duplicates via ‹ N of M ›)
 * highlighted the right row but left it scrolled out of view — caught live
 * by the user on a real 86-hotspot image.
 *
 * And — same idea, other direction — "Table (N rows)" also highlights
 * (and now scrolls to) whichever row shares this link's url, per the
 * user's own follow-up request: a hotspot click should reveal both its own
 * Links entry *and* its data row, not just the former.
 */
function scrollInspectorToEditLink() {
  document.getElementById("form-edit-link")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  // block: "center", not "nearest" — these tables have a sticky <thead>
  // (see .table-scroll thead th in style.css), and "nearest" only scrolls
  // the minimum distance needed to bring the row's box into the container's
  // viewport. That minimum can land the row directly *behind* the sticky
  // header instead of below it, so it ends up still hidden. Centering it
  // leaves enough headroom that it clears the header.
  document.querySelector("tr[data-link-id].editing")?.scrollIntoView({ behavior: "smooth", block: "center" });
  // .row-match, not .editing — editing a link never sets editingRowId, so
  // the matching table row (if any) only ever carries .row-match (see
  // renderRowsSection).
  document.querySelector("tr[data-row-id].row-match")?.scrollIntoView({ behavior: "smooth", block: "center" });
}

/**
 * Scrolls the inspector panel so the just-opened "Edit table row" form is
 * visible. Always runs — the form renders *above* the table in the DOM
 * (see renderEditRowForm/renderRowsSection order in render()), so a long
 * table's preserved scroll position can leave it off-screen above the
 * clicked row, same reasoning as "Edit link" above. Also nudges the
 * highlighted row into view within its own capped-height list, same
 * reasoning as scrollInspectorToEditLink above.
 */
function scrollInspectorToEditRow() {
  document.getElementById("form-edit-row")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  // block: "center" — see the comment in scrollInspectorToEditLink: with a
  // sticky <thead>, "nearest" can leave the row tucked behind the header.
  document.querySelector("tr[data-row-id].editing")?.scrollIntoView({ behavior: "smooth", block: "center" });
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
    (c) => t(c.field === "name" ? "link.conflict.name" : "link.conflict.address", { value: c.value }),
  );
  return `${lines.join("\n")}\n\n${t("link.conflict.footer")}`;
}

function actionAddLink(name: string, url: string) {
  if (!db || activeImageId === null || !pendingHotspot) return;
  const imageId = activeImageId;
  const top = pendingHotspot.top;
  const left = pendingHotspot.left;
  const conflicts = navTargetImageId(url) === null ? findLinkConflicts(db, name, url) : [];

  const doAdd = () => {
    if (!db) return;
    try {
      applyAddAndBroadcast("addLink", addLink, { imageId, name, url, top, left });
      pendingHotspot = null;
      setStatus(t("link.added", { name }));
    } catch (err) {
      setStatus(t("link.addFailed", { message: (err as Error).message }));
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
  const conflicts = navTargetImageId(url) === null ? findLinkConflicts(db, name, url, linkId) : [];

  const doUpdate = () => {
    if (!db) return;
    try {
      applyAndBroadcast("updateLink", updateLink, linkId, { name, url });
      editingLinkId = null;
      setStatus(t("link.updated", { name }));
    } catch (err) {
      setStatus(t("link.updateFailed", { message: (err as Error).message }));
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
    notify(t("link.cantDelete", { url: link.url }));
    return;
  }
  askConfirm(t("link.confirmDelete"), () => {
    if (!db) return;
    try {
      applyAndBroadcast("deleteLink", deleteLink, linkId);
      editingLinkId = null;
      setStatus(t("link.deleted"));
    } catch (err) {
      setStatus(t("link.deleteFailed", { message: (err as Error).message }));
    }
  });
}

function actionCancelEditLink() {
  editingLinkId = null;
  render();
}

/** Parses the "Edit as JSON…" fallback textarea; returns null (and sets a status message) if invalid. */
function parseExtraField(extraText: string): Record<string, string> | null {
  if (!extraText.trim()) return {};
  try {
    return JSON.parse(extraText);
  } catch {
    setStatus(t("extra.invalidJson"));
    return null;
  }
}

/** One key/value row inside an Extra field's pairs UI — used both for the initial render and to rebuild rows after switching back from "Edit as JSON…". */
// `value` is typed string but a catalog's extra JSON can hold numbers/booleans (e.g. the demo's `price_usd: 0`, `in_stock: true`) — hence String() below.
function extraPairRowHtml(key: string, value: string): string {
  return `
    <div class="extra-pair">
      <input type="text" class="extra-key" list="extra-key-options" placeholder="${te("extra.key")}" value="${escapeHtml(key)}" />
      <input type="text" class="extra-value" placeholder="${te("extra.value")}" value="${escapeHtml(String(value))}" />
      <button type="button" class="btn-remove-pair" title="${te("extra.remove")}" aria-label="${te("extra.remove")}">×</button>
    </div>`;
}

/**
 * The Extra field itself: a list of key/value pairs (the default, backlog
 * item 8) with a JSON-textarea fallback for pasting a ready-made object —
 * both live in the DOM at once, `.extra-json`'s `display` says which is
 * showing. Shared by "New table row" and "Edit table row"; each caller's
 * form has its own instance, told apart at wiring/submit time by walking up
 * to the nearest `.extra-field`, not by a per-form id.
 */
function renderExtraField(extra: Record<string, string>): string {
  return `
    <div class="field extra-field">
      <label>${te("extra.label")}</label>
      <div class="extra-pairs">${Object.entries(extra)
        .map(([k, v]) => extraPairRowHtml(k, v))
        .join("")}</div>
      <textarea class="extra-json" rows="3" placeholder='{"weight": "2.3 kg"}' style="display:none">${escapeHtml(Object.keys(extra).length ? JSON.stringify(extra, null, 2) : "")}</textarea>
      <div class="extra-field-actions">
        <button type="button" class="btn-add-pair">${te("extra.addPair")}</button>
        <button type="button" class="btn-toggle-extra-json">${te("extra.toJson")}</button>
      </div>
    </div>`;
}

/** Reads every `.extra-pair` row currently inside `fieldEl`, trimming keys and dropping blank ones. `duplicates` lists any key entered more than once (case-sensitive, after trim) — the caller decides whether that needs confirming. */
function collectExtraPairs(fieldEl: HTMLElement): { entries: [string, string][]; duplicates: string[] } {
  const entries: [string, string][] = [];
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  fieldEl.querySelectorAll<HTMLDivElement>(".extra-pair").forEach((row) => {
    const key = (row.querySelector<HTMLInputElement>(".extra-key")?.value ?? "").trim();
    if (!key) return;
    const value = row.querySelector<HTMLInputElement>(".extra-value")?.value ?? "";
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
    entries.push([key, value]);
  });
  return { entries, duplicates: [...duplicates] };
}

/**
 * Resolves `formEl`'s Extra field (pairs UI or the JSON fallback, whichever
 * is currently showing) and hands the finished object to `onResolved` — the
 * shared last step before actionAddRow/actionSaveRowEdit. A duplicate key in
 * the pairs UI doesn't block saving, same policy as the existing hotspot
 * name/address conflict check (askConfirm below): it just confirms first,
 * since the last value winning is often intentional (correcting a typo by
 * re-adding the pair) rather than a mistake.
 */
function resolveExtraThen(formEl: HTMLFormElement, onResolved: (extra: Record<string, string>) => void) {
  const fieldEl = formEl.querySelector<HTMLElement>(".extra-field");
  if (!fieldEl) {
    onResolved({});
    return;
  }
  const jsonTextarea = fieldEl.querySelector<HTMLTextAreaElement>(".extra-json")!;
  if (jsonTextarea.style.display !== "none") {
    const extra = parseExtraField(jsonTextarea.value);
    if (extra === null) return; // parseExtraField already set a status message
    onResolved(extra);
    return;
  }
  const { entries, duplicates } = collectExtraPairs(fieldEl);
  const extra = Object.fromEntries(entries);
  if (duplicates.length > 0) {
    const list = duplicates.map((k) => `"${k}"`).join(", ");
    askConfirm(t("extra.duplicate", { count: duplicates.length, list }), () => onResolved(extra));
    return;
  }
  onResolved(extra);
}

/**
 * Wires one Extra field's Add/Remove/toggle buttons. Called for every
 * `.extra-field` after each render() (there can be two live at once — "New
 * table row" and "Edit table row" — same pattern as the other per-row
 * listeners in wireEvents()). Add/remove/toggle patch the DOM directly
 * rather than going through render(), so typing elsewhere in the same form
 * (or the other one) is never disturbed.
 */
function wireExtraField(fieldEl: HTMLElement) {
  const pairsContainer = fieldEl.querySelector<HTMLDivElement>(".extra-pairs")!;
  const jsonTextarea = fieldEl.querySelector<HTMLTextAreaElement>(".extra-json")!;
  const addBtn = fieldEl.querySelector<HTMLButtonElement>(".btn-add-pair")!;
  const toggleBtn = fieldEl.querySelector<HTMLButtonElement>(".btn-toggle-extra-json")!;

  function wireRemoveButton(row: HTMLElement) {
    row.querySelector(".btn-remove-pair")?.addEventListener("click", () => row.remove());
  }
  pairsContainer.querySelectorAll<HTMLDivElement>(".extra-pair").forEach(wireRemoveButton);

  addBtn.addEventListener("click", () => {
    pairsContainer.insertAdjacentHTML("beforeend", extraPairRowHtml("", ""));
    const row = pairsContainer.lastElementChild as HTMLElement;
    wireRemoveButton(row);
    row.querySelector<HTMLInputElement>(".extra-key")?.focus();
  });

  toggleBtn.addEventListener("click", () => {
    const showingJson = jsonTextarea.style.display !== "none";
    if (showingJson) {
      const parsed = parseExtraField(jsonTextarea.value);
      if (parsed === null) return; // stay in JSON mode, status message already set
      pairsContainer.innerHTML = Object.entries(parsed)
        .map(([k, v]) => extraPairRowHtml(k, String(v)))
        .join("");
      pairsContainer.querySelectorAll<HTMLDivElement>(".extra-pair").forEach(wireRemoveButton);
      jsonTextarea.style.display = "none";
      pairsContainer.style.display = "";
      addBtn.style.display = "";
      toggleBtn.textContent = t("extra.toJson");
    } else {
      const { entries } = collectExtraPairs(fieldEl);
      const obj = Object.fromEntries(entries);
      jsonTextarea.value = entries.length ? JSON.stringify(obj, null, 2) : "";
      pairsContainer.style.display = "none";
      addBtn.style.display = "none";
      jsonTextarea.style.display = "";
      toggleBtn.textContent = t("extra.toPairs");
    }
  });
}

function actionAddRow(url: string, name: string, sku: string, description: string, extra: Record<string, string>) {
  if (!db || activeImageId === null) return;
  applyAddAndBroadcast("addRow", addRow, { imageId: activeImageId, url, name, sku, description, extra });
  setStatus(t("row.added", { url }));
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

function actionSaveRowEdit(name: string, sku: string, description: string, extra: Record<string, string>) {
  if (!db || editingRowId === null) return;
  applyAndBroadcast("updateRow", updateRow, editingRowId, { name, sku, description, extra });
  editingRowId = null;
  setStatus(t("row.updated", { name }));
}

function actionDeleteRow() {
  if (!db || editingRowId === null) return;
  const rowId = editingRowId;
  askConfirm(t("row.confirmDelete"), () => {
    if (!db) return;
    applyAndBroadcast("deleteRow", deleteRow, rowId);
    editingRowId = null;
    setStatus(t("row.deleted"));
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
  // Navigation hotspots (#image=<id>, see navLink.ts) never get a row.
  const availableLinks = links.filter((l) => !usedUrls.has(l.url) && !isNavLink(l));
  const editingLink = links.find((l) => l.id === editingLinkId) ?? null;
  const editingRow = rows.find((r) => r.id === editingRowId) ?? null;
  // The url of whichever's being edited (link or row) — feeds the hotspot
  // row-match highlight below, the Table row-match highlight (see
  // renderRowsSection), and the instance-nav "N of M" control, mirroring
  // the viewer. Whichever one you clicked, the *other* representation of
  // the same part (a hotspot's matching table row, or vice versa) is easy
  // to lose track of on a dense diagram, so both point back to each other.
  const editingUrl = editingRow?.url ?? editingLink?.url ?? null;
  // Feeds the Extra field's key datalist below — every key already used
  // anywhere in the catalog, not just this image, same reasoning as the
  // search panel's "Extra: <key>" dropdown a few lines further down.
  const extraKeys = db ? collectExtraKeys(listAllRows(db)) : [];
  // Other hotspots on this image sharing the edited link's url (same part
  // drawn more than once) — feeds both the row-match highlight below and
  // the instance-nav "N of M" control, mirroring the viewer.
  const instances = editingLink ? links.filter((l) => l.url === editingLink.url).sort((a, b) => a.id - b.id) : [];
  const instanceIndex = instances.findIndex((l) => l.id === editingLinkId);

  syncCollabEditingState(activeImageId, editingLinkId, editingRowId, editingRow?.url ?? null);

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
  // Same problem again for "Links on this image"/"Table (N rows)"'s own
  // internal scroll (see .table-scroll in style.css): clicking a row you
  // can already see re-renders and would otherwise reset that list's box
  // back to its own top regardless, which combined with the
  // highlight-scrolling below (scrollInspectorToEditLink/…Row) looked like
  // the whole list jumping to the top and animating back down to where it
  // already was — caught live by the user right after .table-scroll
  // shipped. Keyed by data-col-key ("links"/"rows") since there are two of
  // these boxes and #id can't be reused across an innerHTML rebuild.
  const savedTableScroll: Record<string, number> = {};
  if (activeImageId === lastRenderedImageId) {
    document.querySelectorAll<HTMLElement>(".table-scroll").forEach((el) => {
      const key = el.querySelector("table")?.getAttribute("data-col-key");
      if (key) savedTableScroll[key] = el.scrollTop;
    });
  }
  lastRenderedImageId = activeImageId;

  // Read by the mobile breakpoint's CSS (#app[data-mobile-tab=...]) to
  // decide which single panel to show — see mobileTab's declaration. Set on
  // #app itself (not inside innerHTML below) so it survives the wholesale
  // rebuild, same reasoning as applyPanelWidths()'s CSS custom properties.
  app.setAttribute("data-mobile-tab", mobileTab);
  app.innerHTML = `
    <div class="toolbar">
      <h1>${te("toolbar.title")}</h1>
      <button id="btn-new">${te("toolbar.new")}</button>
      <button id="btn-open">${te("toolbar.open")}</button>
      <input type="file" id="file-open" accept=".${CATALOG_FILE_EXTENSION},.sch" style="display:none" />
      <button id="btn-copy-remote" title="${te("toolbar.copyRemote.tip")}">${te("toolbar.copyRemote")}</button>
      <button id="btn-add-image" ${db ? "" : "disabled"}>${te("toolbar.addImage")}</button>
      <input type="file" id="file-image" accept="image/*" style="display:none" />
      <button id="btn-save" ${db ? "" : "disabled"} title="${te("toolbar.save.tip")}">${te("toolbar.save")}</button>
      <button id="btn-export" ${db ? "" : "disabled"} title="${te("toolbar.export.tip")}">${te("toolbar.export", { ext: CATALOG_FILE_EXTENSION })}</button>
      <button id="btn-export-protected" ${db ? "" : "disabled"} title="${te("toolbar.exportProtected.tip")}">${te("toolbar.exportProtected")}</button>
      <button id="btn-export-pdf" ${db && !exportPdfBusy ? "" : "disabled"} title="${te("toolbar.exportPdf.tip")}">${exportPdfBusy ? te("toolbar.exportPdf.busy") : te("toolbar.exportPdf")}</button>
      <button id="btn-search" ${db ? "" : "disabled"} title="${te("toolbar.search.tip")}">${te("toolbar.search")}</button>
      <button id="btn-store-settings" ${db ? "" : "disabled"} title="${te("toolbar.storeSettings.tip")}">${te("toolbar.storeSettings")}</button>
      ${db && !collabRoomId ? `<button id="btn-start-collab" title="${te("toolbar.startCollab.tip")}">${te("toolbar.startCollab")}</button>` : ""}
      ${collabRoomId ? renderCollabStatus() : ""}
      <span class="spacer"></span>
      <select id="lang-select" title="${te("toolbar.language.tip")}" aria-label="${te("toolbar.language.tip")}">${EDITOR_LOCALES.map(
        (l) => `<option value="${l}" ${l === locale ? "selected" : ""}>${escapeHtml(EDITOR_LOCALE_NAMES[l] ?? l)}</option>`,
      ).join("")}</select>
      <button id="btn-theme" title="${te("toolbar.theme.tip")}">${currentTheme() === "dark" ? te("theme.light") : te("theme.dark")}</button>
      <span class="hint">${escapeHtml(statusMessage)}</span>
      ${searchOpen ? renderSearchPanel() : ""}
    </div>

    <div class="mobile-tabs">
      <button type="button" class="mobile-tab-btn ${mobileTab === "images" ? "active" : ""}" data-tab="images">${te("tab.images")}</button>
      <button type="button" class="mobile-tab-btn ${mobileTab === "stage" ? "active" : ""}" data-tab="stage">${te("tab.diagram")}</button>
      <button type="button" class="mobile-tab-btn ${mobileTab === "inspector" ? "active" : ""}" data-tab="inspector">${te("tab.details")}</button>
    </div>

    <div class="panel-images">
      ${
        images.length === 0
          ? `<p class="hint">${db ? te("images.none") : te("images.createOrOpen")}</p>`
          : renderImageList(images)
      }
    </div>

    <div class="panel-divider" id="divider-images" title="${te("divider.tip")}"></div>

    <div class="stage">
      <div class="stage-scroll" id="stage-scroll">
        ${
          activeImage
            ? `<div class="stage-inner" id="stage-inner" style="transform: scale(${zoom})">
                 <img id="stage-img" src="data:${activeImage.mimeType};base64,${activeImage.imageData}" width="${activeImage.width}" height="${activeImage.height}" />
                 <div class="crosshair-box" id="crosshair-box"></div>
                 <div class="crosshair-h" id="crosshair-h"></div>
                 <div class="crosshair-v" id="crosshair-v"></div>
                 ${links.map((l) => hotspotHtml(l, editingUrl)).join("")}
                 ${pendingHotspot ? `<div class="hotspot pending" style="top:${pendingHotspot.top}px;left:${pendingHotspot.left}px">${te("hotspot.pending")}</div>` : ""}
                 <div id="editing-balloons">${renderEditingBalloons(links, activeImage.id)}</div>
               </div>`
            : `<p class="hint" style="padding:2rem">${te("stage.select")}</p>`
        }
      </div>
      ${activeImage ? renderZoomControls() : ""}
      ${instances.length > 1 ? renderInstanceNav(instanceIndex, instances.length) : ""}
    </div>

    <div class="panel-divider" id="divider-inspector" title="${te("divider.tip")}"></div>

    <div class="inspector" id="inspector">
      <datalist id="extra-key-options">${extraKeys.map((k) => `<option value="${escapeHtml(k)}"></option>`).join("")}</datalist>
      ${activeImage ? renderImageForm(activeImage, images) : ""}
      ${activeImage ? renderLinkForm(links, images) : ""}
      ${activeImage ? renderEditLinkForm(editingLink, images) : ""}
      ${activeImage ? renderLinksSection(links, editingLinkId, images) : ""}
      ${activeImage ? renderRowForm(availableLinks) : ""}
      ${activeImage ? renderEditRowForm(editingRow) : ""}
      ${activeImage ? renderRowsSection(rows, editingRowId, editingUrl) : ""}
    </div>

    ${renderConfirmOverlay()}
    ${renderNoticeOverlay()}
    ${renderRemoteDialog()}
    ${renderStoreSettingsDialog()}
    ${renderPdfOptionsDialog()}
    ${renderProtectDialog()}
    ${renderCollabNotFoundDialog()}
    ${renderCollabNameDialog()}
    ${renderCollabShareDialog()}
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
  document.querySelectorAll<HTMLElement>(".table-scroll").forEach((el) => {
    const key = el.querySelector("table")?.getAttribute("data-col-key");
    if (key && savedTableScroll[key] !== undefined) el.scrollTop = savedTableScroll[key];
  });

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
    ? t("image.delete.blocked", { count: links.length, names: links.map((l) => l.name).join(", ") })
    : t("image.delete.tip", { name: img.name });
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
      <h2>${te("image.title")}</h2>
      <div class="field">
        <label for="image-name-input">${te("column.name")}</label>
        <input type="text" id="image-name-input" value="${escapeHtml(image.name)}" />
      </div>
      <div class="field">
        <label for="image-folder-input">${te("image.folder")}</label>
        <input type="text" id="image-folder-input" list="folder-options" value="${escapeHtml(image.folder)}" placeholder="${te("image.folder.placeholder")}" />
        <datalist id="folder-options">${folders.map((f) => `<option value="${escapeHtml(f)}"></option>`).join("")}</datalist>
      </div>
      <div class="field">
        <label style="display:flex; gap:0.4rem; align-items:center"><input type="checkbox" id="image-fit-input" ${image.fitOnOpen ? "checked" : ""} /> ${te("image.fitOnOpen")}</label>
        <p class="hint">${te("image.fitOnOpen.hint")}</p>
      </div>
      <button id="btn-save-image">${te("action.save")}</button>
    </section>
  `;
}

function renderZoomControls(): string {
  return `
    <div class="zoom-controls">
      <button id="btn-zoom-out" title="${te("zoom.out")}">−</button>
      <span class="zoom-pct">${Math.round(zoom * 100)}%</span>
      <button id="btn-zoom-in" title="${te("zoom.in")}">+</button>
      <button id="btn-zoom-reset" title="${te("zoom.reset.tip")}">${te("zoom.reset")}</button>
    </div>
  `;
}

/** Mirrors the viewer's instance-nav (viewerEngine.ts) — same markup/ids, same left-of-zoom placement. */
function renderInstanceNav(index: number, total: number): string {
  return `
    <div class="instance-nav">
      <button id="btn-instance-prev" title="${te("instance.prev")}">‹</button>
      <span>${te("nav.position", { index: index + 1, total })}</span>
      <button id="btn-instance-next" title="${te("instance.next")}">›</button>
    </div>
  `;
}

function collabShareLink(): string {
  return `${location.origin}${location.pathname}?collab=${collabRoomId}&server=${encodeURIComponent(collabServerUrl)}`;
}

function collabStatusText(): { icon: string; label: string; title: string } {
  const icon = collabStatus === "connected" ? "🟢" : collabStatus === "connecting" ? "🟡" : "🔴";
  let label = t(collabStatus === "connected" ? "collab.live" : collabStatus === "connecting" ? "collab.connecting" : "collab.disconnected");
  let title = t("collab.tip", { link: collabShareLink() });
  if (outbox.length > 0) {
    label = t("collab.statusPending", { label, count: outbox.length });
    title = t("collab.tipPending", { count: outbox.length, tip: title });
  }
  return { icon, label, title };
}

function renderCollabStatus(): string {
  const { icon, label, title } = collabStatusText();
  return `
    <span class="collab-status" id="collab-status-text" title="${escapeHtml(title)}">${icon} ${label}</span>
    <button type="button" id="btn-copy-collab-link">${te("collab.shareLink")}</button>
    <button type="button" id="btn-leave-collab">${te("collab.leave")}</button>
    ${
      collabOwnerToken
        ? `<button type="button" id="btn-end-collab-session" title="${te("collab.end.tip")}">${te("collab.end")}</button>`
        : ""
    }
    ${renderPresenceRoster()}
  `;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
/** Defense-in-depth alongside collab-server's own sanitizeColor() — this roster's `color` came in over the wire from another peer, not this tab, and ends up straight in a `style` attribute below. */
function sanitizePresenceColor(color: string): string {
  return HEX_COLOR.test(color) ? color : "#6c757d";
}

/** A row of small initial avatars — who's currently active in this session (see PresenceUser; someone connected but idle/hidden just isn't in the list, not shown greyed-out). */
function renderPresenceRoster(): string {
  return `<div class="collab-presence" id="collab-presence-list" title="${te("presence.tip")}">${collabPresence.map(renderPresenceAvatar).join("")}</div>`;
}

function renderPresenceAvatar(user: PresenceUser): string {
  const initial = (user.name.trim()[0] ?? "?").toUpperCase();
  const isMe = user.clientId === collabClientId;
  const label = isMe ? t("presence.you", { name: user.name }) : user.name;
  return `<span class="presence-avatar${isMe ? " presence-avatar-me" : ""}" style="background:${sanitizePresenceColor(user.color)}" title="${escapeHtml(label)}">${escapeHtml(initial)}</span>`;
}

/**
 * Translucent "‹Name› — ‹action›" balloons for what everyone *else* in the
 * session currently has open on *this* image (see EditingEntry / the
 * backlog's 2026-09-07 item 8 decision) — never this tab's own, and never
 * anyone else's if they're on a different image. Anchored in the same
 * unscaled #stage-inner coordinate space as the hotspots themselves, like
 * the pending "new…" label above, so they zoom/pan identically with no
 * extra math.
 */
function renderEditingBalloons(links: CatalogLink[], imageId: number): string {
  const stackedAt = new Map<string, number>(); // how many balloons already placed at a given (rounded) spot — see stackOffset below
  const balloons: string[] = [];
  for (const entry of collabEditing) {
    if (entry.imageId !== imageId || entry.clientId === collabClientId) continue;
    // entry.name/color, not a fresh lookup against collabPresence — that
    // roster is active-only, and this entry can legitimately outlive
    // someone going idle/backgrounded (see EditingEntry's doc for the real
    // bug this replaced).
    const name = entry.name;
    const color = sanitizePresenceColor(entry.color);
    if (entry.mode === "row") {
      // A table row's url isn't tied to one hotspot — the same part can be
      // drawn at several positions on this image (the app's own orange
      // duplicate-highlight already tracks this same set — see
      // hotspotHtml's row-match class).
      for (const link of links.filter((l) => l.url === entry.url)) {
        balloons.push(renderOneEditingBalloon(link.top, link.left, name, color, t("balloon.editRow"), stackedAt));
      }
      continue;
    }
    const link = links.find((l) => l.id === entry.linkId);
    if (!link) continue; // stale — the hotspot got deleted out from under this entry, or it's on a different image after all
    if (entry.mode === "drag") {
      const move = collabEditingMoves.get(entry.clientId);
      const pos = move && move.linkId === entry.linkId ? move : link;
      balloons.push(renderOneEditingBalloon(pos.top, pos.left, name, color, t("balloon.moving"), stackedAt));
    } else {
      balloons.push(renderOneEditingBalloon(link.top, link.left, name, color, t("balloon.editLink"), stackedAt));
    }
  }
  return balloons.join("");
}

/** One balloon, offset upward a bit further for every earlier one already placed at (about) the same spot — otherwise two people on the same hotspot (e.g. both drawn to the same "row" match) would render exactly on top of each other. */
function renderOneEditingBalloon(top: number, left: number, name: string, color: string, action: string, stackedAt: Map<string, number>): string {
  const key = `${Math.round(top)},${Math.round(left)}`;
  const stack = stackedAt.get(key) ?? 0;
  stackedAt.set(key, stack + 1);
  const yOffset = 14 + stack * 22; // px above the hotspot's own point, stacking further up per collision
  return `<div class="editing-balloon" style="top:${top - yOffset}px;left:${left}px;background:${color}">${te("balloon.text", { name, action })}</div>`;
}

/** Same reasoning as updateCollabStatusDisplay() below — a change here (a drag in progress, a form opening/closing) can land at any moment, including mid-typing in an open form elsewhere on the page, so this patches the balloons' own small DOM subtree instead of calling render(). Cheap even during a live drag's throttled stream of editing-move frames — a handful of small `<div>`s, not the whole #app. */
function updateEditingBalloonsDisplay() {
  const el = document.getElementById("editing-balloons");
  if (!el || !db || activeImageId === null) return; // no active image currently rendered — the next real render() will pick this up
  el.innerHTML = renderEditingBalloons(listLinksForImage(db, activeImageId), activeImageId);
}

/** Same reasoning as updateCollabStatusDisplay() below — a roster change (someone else joining, going idle, leaving) can land at any moment, including mid-typing in an open form, so this patches the roster's own small DOM subtree instead of calling render(). */
function updatePresenceRosterDisplay() {
  const el = document.getElementById("collab-presence-list");
  if (!el) return; // no active session currently rendered — the next real render() will pick this roster up
  el.innerHTML = collabPresence.map(renderPresenceAvatar).join("");
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
          <button id="btn-confirm-no">${te("action.cancel")}</button>
          <button id="btn-confirm-yes">${te("action.ok")}</button>
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
          <button id="btn-notice-ok">${te("action.ok")}</button>
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
        <h2>${te("remote.title")}</h2>
        <div class="field">
          <label for="remote-url-input">${te("remote.urlLabel", { ext: CATALOG_FILE_EXTENSION })}</label>
          <input type="text" id="remote-url-input" value="${escapeHtml(remoteUrlValue)}" placeholder="${te("remote.placeholder", { ext: CATALOG_FILE_EXTENSION })}" ${remoteLoading ? "disabled" : ""} />
        </div>
        ${
          remoteError
            ? `<p class="error">${escapeHtml(remoteError)}</p>`
            : `<p class="hint">${te("remote.hint")}</p>`
        }
        <div class="confirm-actions">
          <button id="remote-cancel" ${remoteLoading ? "disabled" : ""}>${te("action.cancel")}</button>
          <button id="remote-submit" ${remoteLoading || !remoteUrlValue.trim() ? "disabled" : ""}>${remoteLoading ? te("remote.copying") : te("remote.copy")}</button>
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
  const isEducation = storeSettingsCatalogMode === "education";
  const isFitness = storeSettingsCatalogMode === "fitness";
  const isQuiz = storeSettingsCatalogMode === "quiz";
  // Mirrors viewerEngine.ts's cartLabel/buyLabel — the whole dialog talks
  // about "Buy"/"cart"/"checkout" because that's what the underlying
  // mechanism (extra.buy_url, combining several into one link) literally
  // is, but under "Education" those words read as an odd mismatch next to
  // "Learn more"/"Collection" above. Keep the mechanism identical, just
  // relabel every string here the same way the viewer's own UI does.
  const tm = (key: string, params?: MessageParams) => escapeHtml(tMode(storeSettingsCatalogMode, key, params));
  // The regex/param/base-url "recipe" only exists to combine several ids
  // into one store's checkout URL (Payhip-style) — a commercial-only
  // concept. A school catalog's buy_urls are plain reference links with
  // nothing to combine them into, so this whole section would just be
  // confusing advanced config for a mechanism Education mode never uses
  // (see actionPrintCollection/actionOpenCart in viewerEngine.ts: every
  // Education-mode link opens/prints on its own regardless of this recipe).
  return `
    <div class="confirm-overlay">
      <div class="confirm-box">
        <h2>${te("store.title")}</h2>
        <div class="field">
          <label>${te("store.type.legend")}</label>
          <label class="radio-option">
            <input type="radio" name="catalog-mode" value="commercial" ${!isEducation && !isFitness && !isQuiz ? "checked" : ""} />
            ${te("store.type.commercial")}
          </label>
          <label class="radio-option">
            <input type="radio" name="catalog-mode" value="education" ${isEducation ? "checked" : ""} />
            ${te("store.type.education")}
          </label>
          <label class="radio-option">
            <input type="radio" name="catalog-mode" value="fitness" ${isFitness ? "checked" : ""} />
            ${te("store.type.fitness")}
          </label>
          <label class="radio-option">
            <input type="radio" name="catalog-mode" value="quiz" ${isQuiz ? "checked" : ""} />
            ${te("store.type.quiz")}
          </label>
        </div>
        ${
          // Only a memo for store catalogs — nothing reads it — so Education/Fitness hide it (the value is kept and saved as-is).
          isListMode(storeSettingsCatalogMode)
            ? ""
            : `<div class="field">
          <label for="store-url-input">${te("store.url.label")}</label>
          <input type="text" id="store-url-input" value="${escapeHtml(storeSettingsUrlValue)}" placeholder="https://payhip.com/YourStore" />
        </div>`
        }
        <div class="field">
          <label>${tm("store.behavior.legend")}</label>
          <label class="radio-option">
            <input type="radio" name="cart-mode" value="accumulate" ${storeSettingsCartMode === "accumulate" ? "checked" : ""} />
            ${tm("store.behavior.accumulate")}
          </label>
          <label class="radio-option">
            <input type="radio" name="cart-mode" value="instant" ${storeSettingsCartMode === "instant" ? "checked" : ""} />
            ${tm("store.behavior.instant")}
          </label>
        </div>
        ${
          isListMode(storeSettingsCatalogMode)
            ? ""
            : `<details class="cart-recipe" ${usingDefaultRecipe ? "" : "open"}>
          <summary>${te("store.recipe.summary")}</summary>
          <div class="field">
            <label for="cart-id-pattern-input">${te("store.recipe.idPattern")}</label>
            <input type="text" id="cart-id-pattern-input" value="${escapeHtml(storeSettingsCartIdPattern)}" />
          </div>
          <div class="field">
            <label for="cart-item-param-input">${te("store.recipe.itemParam")}</label>
            <input type="text" id="cart-item-param-input" value="${escapeHtml(storeSettingsCartItemParam)}" />
          </div>
          <div class="field">
            <label for="cart-base-url-input">${te("store.recipe.baseUrl")}</label>
            <input type="text" id="cart-base-url-input" value="${escapeHtml(storeSettingsCartCheckoutBaseUrl)}" />
          </div>
          <p class="hint">${te("store.recipe.hint")}</p>
        </details>`
        }
        <div class="field">
          <label>${te("store.view.legend")}</label>
          <label class="radio-option">
            <input type="radio" name="default-view" value="images" ${storeSettingsDefaultView === "images" ? "checked" : ""} />
            ${te("store.view.images")}
          </label>
          <label class="radio-option">
            <input type="radio" name="default-view" value="diagram" ${storeSettingsDefaultView === "diagram" ? "checked" : ""} />
            ${te("store.view.diagram")}
          </label>
          <label class="radio-option">
            <input type="radio" name="default-view" value="table" ${storeSettingsDefaultView === "table" ? "checked" : ""} />
            ${te("store.view.table")}
          </label>
          <p class="hint">${te("store.view.hint")}</p>
        </div>
        <div class="confirm-actions">
          <button id="store-settings-cancel">${te("action.cancel")}</button>
          <button id="store-settings-submit">${te("action.save")}</button>
        </div>
      </div>
    </div>
  `;
}

/** "Export PDF…" options — see pdfOptionsDialogOpen's own doc; asked every time so a per-export choice (e.g. "real-size" for one especially dense diagram) doesn't linger unnoticed into the next, ordinary export. The QR placement question is grayed out entirely when the open catalog has no buy_url anywhere — there's nothing for any of the three choices to affect. */
function renderPdfOptionsDialog(): string {
  if (!pdfOptionsDialogOpen || !db) return "";
  const hasBuyUrl = catalogHasAnyBuyUrl(listAllRows(db));
  return `
    <div class="confirm-overlay">
      <div class="confirm-box">
        <h2>${te("pdf.title")}</h2>
        <div class="field">
          <label>${te("pdf.qr.legend")}</label>
          <label class="radio-option">
            <input type="radio" name="pdf-qr-placement" value="table" ${pdfQrPlacement === "table" ? "checked" : ""} ${hasBuyUrl ? "" : "disabled"} />
            ${te("pdf.qr.table")}
          </label>
          <label class="radio-option">
            <input type="radio" name="pdf-qr-placement" value="image" ${pdfQrPlacement === "image" ? "checked" : ""} ${hasBuyUrl ? "" : "disabled"} />
            ${te("pdf.qr.image")}
          </label>
          <label class="radio-option">
            <input type="radio" name="pdf-qr-placement" value="both" ${pdfQrPlacement === "both" ? "checked" : ""} ${hasBuyUrl ? "" : "disabled"} />
            ${te("pdf.qr.both")}
          </label>
          <p class="hint">
            ${
              hasBuyUrl
                ? te("pdf.qr.hint")
                : te("pdf.qr.hintNoStore")
            }
          </p>
        </div>
        <div class="field">
          <label>${te("pdf.size.legend")}</label>
          <label class="radio-option">
            <input type="radio" name="pdf-diagram-page-mode" value="fit" ${pdfDiagramPageMode === "fit" ? "checked" : ""} />
            ${te("pdf.size.fit")}
          </label>
          <label class="radio-option">
            <input type="radio" name="pdf-diagram-page-mode" value="real-size" ${pdfDiagramPageMode === "real-size" ? "checked" : ""} />
            ${te("pdf.size.real")}
          </label>
        </div>
        <div class="confirm-actions">
          <button id="pdf-options-cancel">${te("action.cancel")}</button>
          <button id="pdf-options-submit">${te("pdf.submit")}</button>
        </div>
      </div>
    </div>
  `;
}

/** "Export protected…": password (twice), the public cover, and what the seller must know before handing the file out. */
function renderProtectDialog(): string {
  if (!protectDialogOpen || !db) return "";
  const images = currentImages();
  const strength = passwordStrength(protectPassword);
  const problem = protectFormProblem();
  return `
    <div class="confirm-overlay">
      <form class="confirm-box protect-box" id="protect-form" autocomplete="off">
        <h2>${te("protect.title")}</h2>
        <p class="hint">${te("protect.intro")}</p>
        <div class="field">
          <label for="protect-password">${te("protect.password")}</label>
          <input type="password" id="protect-password" value="${escapeHtml(protectPassword)}" autocomplete="new-password" spellcheck="false" ${protectBusy ? "disabled" : ""} />
          <span class="hint protect-strength protect-strength-${strength}" id="protect-strength">${protectStrengthText(strength)}</span>
        </div>
        <div class="field">
          <label for="protect-repeat">${te("protect.repeat")}</label>
          <input type="password" id="protect-repeat" value="${escapeHtml(protectRepeat)}" autocomplete="new-password" spellcheck="false" ${protectBusy ? "disabled" : ""} />
          <span class="hint error" id="protect-mismatch">${protectMismatchText()}</span>
        </div>
        <div class="field">
          <label for="protect-cover-select">${te("protect.cover.label")}</label>
          <select id="protect-cover-select" ${protectBusy ? "disabled" : ""}>
            <option value="none" ${protectCoverChoice === "none" ? "selected" : ""}>${te("protect.cover.none")}</option>
            ${images
              .map(
                (i) =>
                  `<option value="image:${i.id}" ${protectCoverChoice === `image:${i.id}` ? "selected" : ""}>${escapeHtml(i.name)}</option>`,
              )
              .join("")}
            <option value="file" ${protectCoverChoice === "file" ? "selected" : ""}>${te("protect.cover.upload")}</option>
          </select>
          ${
            protectCoverChoice === "file"
              ? `<input type="file" id="protect-cover-file" accept="image/*" ${protectBusy ? "disabled" : ""} />`
              : ""
          }
          ${
            protectCoverBusy
              ? `<span class="hint">${te("protect.cover.preparing")}</span>`
              : protectCoverError
                ? `<span class="hint error">${escapeHtml(protectCoverError)}</span>`
                : protectCoverUrl && protectCover
                  ? `<img class="protect-cover-preview" src="${protectCoverUrl}" alt="" />
                     <span class="hint">${te("protect.cover.size", { kb: Math.max(1, Math.round(protectCover.bytes.length / 1024)), max: Math.round(PROTECT_MAX_COVER_BYTES / 1024) })}</span>`
                  : ""
          }
          <span class="hint">${te("protect.cover.public")}</span>
        </div>
        <p class="hint">${te("protect.warn")}</p>
        ${protectError ? `<p class="error" role="alert">${escapeHtml(protectError)}</p>` : ""}
        <div class="confirm-actions">
          <button type="button" id="protect-cancel" ${protectBusy ? "disabled" : ""}>${te("action.cancel")}</button>
          <button type="submit" id="protect-submit" ${problem || protectBusy ? "disabled" : ""}>${protectBusy ? te("protect.busy") : te("protect.submit")}</button>
        </div>
      </form>
    </div>
  `;
}

function protectStrengthText(strength: ReturnType<typeof passwordStrength>): string {
  if (strength === "empty") return te("protect.tooShort", { min: PROTECT_MIN_PASSWORD_LENGTH });
  if ([...protectPassword].length < PROTECT_MIN_PASSWORD_LENGTH) return te("protect.tooShort", { min: PROTECT_MIN_PASSWORD_LENGTH });
  return strength === "strong" ? te("protect.strength.strong") : strength === "fair" ? te("protect.strength.fair") : te("protect.strength.weak");
}

function protectMismatchText(): string {
  return protectRepeat && protectPassword !== protectRepeat ? te("protect.mismatch") : "";
}

/** Typing patches the hint lines and the button in place — a full render() would drop focus from the password field on every key. */
function wireProtectDialog() {
  const password = document.getElementById("protect-password") as HTMLInputElement | null;
  const repeat = document.getElementById("protect-repeat") as HTMLInputElement | null;
  if (!password || !repeat) return;
  const patch = () => {
    const strength = passwordStrength(protectPassword);
    const strengthEl = document.getElementById("protect-strength");
    if (strengthEl) {
      strengthEl.textContent = protectStrengthText(strength);
      strengthEl.className = `hint protect-strength protect-strength-${strength}`;
    }
    const mismatchEl = document.getElementById("protect-mismatch");
    if (mismatchEl) mismatchEl.textContent = protectMismatchText();
    const submit = document.getElementById("protect-submit") as HTMLButtonElement | null;
    if (submit) submit.disabled = protectFormProblem() !== null || protectBusy;
  };
  password.addEventListener("input", () => {
    protectFocusPending = false;
    protectPassword = password.value;
    patch();
  });
  repeat.addEventListener("input", () => {
    protectFocusPending = false;
    protectRepeat = repeat.value;
    patch();
  });
  document.getElementById("protect-form")?.addEventListener("submit", (evt) => {
    evt.preventDefault();
    void actionConfirmProtect();
  });
  document.getElementById("protect-cancel")?.addEventListener("click", actionCloseProtectDialog);
  document.getElementById("protect-cover-select")?.addEventListener("change", (evt) => {
    protectFocusPending = false;
    protectCoverChoice = (evt.target as HTMLSelectElement).value;
    protectCustomFile = null;
    void refreshProtectCover();
  });
  document.getElementById("protect-cover-file")?.addEventListener("change", (evt) => {
    protectFocusPending = false;
    protectCustomFile = (evt.target as HTMLInputElement).files?.[0] ?? null;
    void refreshProtectCover();
  });
  // Held until the seller touches something: the first renders after opening
  // (the cover thumbnail finishing) would otherwise take the focus away again.
  if (protectFocusPending) password.focus();
}

function renderCollabNotFoundDialog(): string {
  if (!collabNotFoundOpen) return "";
  return `
    <div class="confirm-overlay">
      <div class="confirm-box">
        <h2>${te("collab.notFound.title")}</h2>
        <p>${t("collab.notFound.body.html")}</p>
        <div class="confirm-actions">
          <button id="collab-not-found-cancel">${te("action.cancel")}</button>
          <button id="collab-not-found-retry">${te("collab.notFound.retry")}</button>
        </div>
        <details style="margin-top: 0.75rem">
          <summary>${te("collab.notFound.manual")}</summary>
          <p class="hint" style="margin-top: 0.5rem">${te("collab.notFound.manualHint")}</p>
          <div class="field" style="margin-top: 0.5rem">
            <label for="collab-manual-url-input">${te("collab.notFound.address")}</label>
            <input type="text" id="collab-manual-url-input" value="${escapeHtml(collabManualUrlValue)}" placeholder="${DEFAULT_COLLAB_SERVER_URL}" />
          </div>
          <button id="collab-manual-url-submit">${te("collab.notFound.use")}</button>
        </details>
      </div>
    </div>
  `;
}

function renderCollabNameDialog(): string {
  if (!collabNameDialogOpen) return "";
  return `
    <div class="confirm-overlay">
      <div class="confirm-box">
        <h2>${te("collab.name.title")}</h2>
        <p>${te("collab.name.body")}</p>
        <div class="field">
          <label for="collab-name-input">${te("collab.name.label")}</label>
          <input type="text" id="collab-name-input" value="${escapeHtml(collabNameValue)}" placeholder="${te("collab.name.placeholder")}" maxlength="60" />
        </div>
        <div class="confirm-actions">
          <button id="collab-name-cancel">${te("action.cancel")}</button>
          <button id="collab-name-submit" ${collabNameValue.trim() ? "" : "disabled"}>${te("collab.name.join")}</button>
        </div>
      </div>
    </div>
  `;
}

/** Link+QR popup for a running session — see collabShareDialogOpen's own doc. Not renderable without a room (collabRoomId null), same guard as the status bar's own "Share link…" button. */
function renderCollabShareDialog(): string {
  if (!collabShareDialogOpen || !collabRoomId) return "";
  const link = collabShareLink();
  return `
    <div class="confirm-overlay">
      <div class="confirm-box collab-share-box">
        <h2>${te("collab.share.title")}</h2>
        <p>${te("collab.share.body")}</p>
        <div class="collab-share-qr">${renderQrCodeSvg(link)}</div>
        <div class="field">
          <label for="collab-share-link-input">${te("collab.share.link")}</label>
          <textarea id="collab-share-link-input" readonly rows="5">${escapeHtml(link)}</textarea>
        </div>
        <div class="confirm-actions">
          <span class="hint collab-share-copy-feedback">${collabShareCopyFeedback ? te("collab.share.copied") : ""}</span>
          <button type="button" id="collab-share-copy">${te("collab.share.copy")}</button>
          <button type="button" id="collab-share-close">${te("action.close")}</button>
        </div>
      </div>
    </div>
  `;
}

// Same cosmetic-only relabel as the viewer's skuLabel() — SKU reads as
// commerce jargon in a classroom catalog, so Education mode calls it "Code"
// instead. The underlying `sku` column/field is unchanged either way.
function skuLabel(): string {
  return tMode(db ? readMeta(db).catalogMode : "commercial", "column.sku");
}

function renderSearchPanel(): string {
  if (!db) return "";
  const extraKeys = collectExtraKeys(listAllRows(db));
  return `
    <div class="search-panel" id="search-panel">
      <div class="search-controls">
        <input type="text" id="search-input" value="${escapeHtml(searchQuery)}" placeholder="${te("search.placeholder")}" />
        <select id="search-field">
          <option value="all" ${searchField === "all" ? "selected" : ""}>${te("search.allFields")}</option>
          <option value="name" ${searchField === "name" ? "selected" : ""}>${te("column.name")}</option>
          <option value="sku" ${searchField === "sku" ? "selected" : ""}>${skuLabel()}</option>
          <option value="description" ${searchField === "description" ? "selected" : ""}>${te("column.description")}</option>
          ${extraKeys
            .map(
              (k) =>
                `<option value="extra:${escapeHtml(k)}" ${searchField === `extra:${k}` ? "selected" : ""}>${te("search.extraField", { key: k })}</option>`,
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
  if (!searchQuery.trim()) return `<p class="hint">${te("search.hint")}</p>`;
  const results = searchRows(listAllRows(db), searchQuery, searchField).slice(0, 30);
  if (results.length === 0) return `<p class="hint">${te("search.none")}</p>`;
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

function hotspotHtml(l: CatalogLink, highlightUrl: string | null): string {
  const classes = ["hotspot"];
  if (l.id === editingLinkId) classes.push("editing");
  if (highlightUrl !== null && l.url === highlightUrl) classes.push("row-match");
  return `<div class="${classes.join(" ")}" data-id="${l.id}" style="top:${l.top}px;left:${l.left}px" title="${te("hotspot.tip", { url: l.url })}">${escapeHtml(l.name)}</div>`;
}

/**
 * "Goes to image" select: picking an image turns the hotspot into a
 * navigation link (address `#image=<id>`, no table row) — room overview →
 * close-up → ⌂ back. The first option keeps it an ordinary item hotspot.
 */
function renderNavTargetField(images: CatalogImage[], currentUrl: string): string {
  const target = navTargetImageId(currentUrl);
  const others = images.filter((img) => img.id !== activeImageId || img.id === target);
  if (others.length === 0) return "";
  return `<div class="field"><label>${te("link.target.label")}</label>
      <select class="nav-target-select">
        <option value="">${te("link.target.none")}</option>
        ${others.map((img) => `<option value="${img.id}" ${img.id === target ? "selected" : ""}>${escapeHtml(img.name)}</option>`).join("")}
      </select>
    </div>`;
}

function renderLinkForm(links: CatalogLink[], images: CatalogImage[]): string {
  // One option per distinct url already on this image — for pointing a new
  // hotspot at a part that's already drawn elsewhere (same bolt, another spot).
  const reusable = Array.from(new Map(links.filter((l) => !isNavLink(l)).map((l) => [l.url, l])).values());
  return `
    <section>
      <h2>${te("link.new.title")}</h2>
      <p class="hint">${te("link.new.hint")}</p>
      ${
        pendingHotspot
          ? `<p class="hint">${te("link.position", { top: pendingHotspot.top, left: pendingHotspot.left })}</p>
             <form id="form-link">
               ${
                 reusable.length > 0
                   ? `<div class="field"><label>${te("link.reuse.label")}</label>
                        <select id="reuse-link-select">
                          <option value="">${te("link.reuse.none")}</option>
                          ${reusable.map((l) => `<option value="${escapeHtml(l.url)}" data-name="${escapeHtml(l.name)}">${escapeHtml(l.name)} (${escapeHtml(l.url)})</option>`).join("")}
                        </select>
                      </div>`
                   : ""
               }
               ${renderNavTargetField(images, "")}
               <div class="field"><label>${te("link.name")}</label><input name="name" required /></div>
               <div class="field"><label>${te("link.address")}</label><input name="url" required /></div>
               <button type="submit">${te("link.add")}</button>
             </form>`
          : `<p class="hint">${te("link.placeHint")}</p>`
      }
    </section>
  `;
}

function renderEditLinkForm(link: CatalogLink | null, images: CatalogImage[]): string {
  if (!link) return "";
  return `
    <section>
      <h2>${te("link.edit.title")}</h2>
      <p class="hint">${te("link.edit.position", { top: link.top, left: link.left })}</p>
      <form id="form-edit-link">
        ${renderNavTargetField(images, link.url)}
        <div class="field"><label>${te("link.name")}</label><input name="name" value="${escapeHtml(link.name)}" required /></div>
        <div class="field"><label>${te("link.edit.address")}</label><input name="url" value="${escapeHtml(link.url)}" required /></div>
        <div style="display:flex; gap:0.5rem; align-items:center">
          <button type="submit">${te("action.saveChanges")}</button>
          <button type="button" id="btn-cancel-edit">${te("action.cancel")}</button>
          <button type="button" id="btn-delete-link" style="margin-left:auto; color:#b91c1c; border-color:#b91c1c">${te("action.delete")}</button>
        </div>
      </form>
    </section>
  `;
}

function renderLinksSection(links: CatalogLink[], editingLinkId: number | null, images: CatalogImage[]): string {
  const imageName = (url: string) => {
    const target = navTargetImageId(url);
    if (target === null) return "";
    const name = images.find((img) => img.id === target)?.name;
    return ` → ${escapeHtml(name ?? te("link.target.missing"))}`;
  };
  const [nameW, urlW] = colWidths.links;
  return `
    <section>
      <h2>${te("links.title", { count: links.length })}</h2>
      <div class="table-scroll">
        <table data-col-key="links" style="table-layout:fixed; width:${colTableTotalWidth("links")}px">
          <colgroup><col style="width:${nameW}px"><col style="width:${urlW}px"></colgroup>
          <thead><tr>
            <th>${te("column.name")}<span class="col-resize-handle" data-table="links" data-col="0"></span></th>
            <th>${te("column.address")}<span class="col-resize-handle" data-table="links" data-col="1"></span></th>
          </tr></thead>
          <tbody>
            ${links
              .map(
                (l) =>
                  `<tr data-link-id="${l.id}" class="clickable-row${l.id === editingLinkId ? " editing" : ""}"><td>${escapeHtml(l.name)}</td><td>${escapeHtml(l.url)}${imageName(l.url)}</td></tr>`,
              )
              .join("")}
          </tbody>
        </table>
      </div>
      <p class="hint">${te("links.hint")}</p>
    </section>
  `;
}

function renderRowForm(availableLinks: CatalogLink[]): string {
  return `
    <section>
      <h2>${te("row.new.title")}</h2>
      ${
        availableLinks.length === 0
          ? `<p class="hint">${te("row.addLinkFirst")}</p>`
          : `<form id="form-row">
               <div class="field"><label>${te("row.address")}</label>
                 <select name="url">${availableLinks.map((l) => `<option value="${escapeHtml(l.url)}">${escapeHtml(l.url)} (${escapeHtml(l.name)})</option>`).join("")}</select>
               </div>
               <div class="field"><label>${te("column.name")}</label><input name="name" /></div>
               <div class="field"><label>${skuLabel()}</label><input name="sku" /></div>
               <div class="field"><label>${te("column.description")}</label><input name="description" /></div>
               ${renderExtraField({})}
               <button type="submit">${te("row.add")}</button>
             </form>`
      }
    </section>
  `;
}

function renderEditRowForm(row: CatalogRow | null): string {
  if (!row) return "";
  return `
    <section>
      <h2>${te("row.edit.title")}</h2>
      <p class="hint">${te("row.edit.address", { url: row.url })}</p>
      <form id="form-edit-row">
        <div class="field"><label>${te("column.name")}</label><input name="name" value="${escapeHtml(row.name)}" /></div>
        <div class="field"><label>${skuLabel()}</label><input name="sku" value="${escapeHtml(row.sku)}" /></div>
        <div class="field"><label>${te("column.description")}</label><input name="description" value="${escapeHtml(row.description)}" /></div>
        ${renderExtraField(row.extra)}
        <div style="display:flex; gap:0.5rem; align-items:center">
          <button type="submit">${te("action.saveChanges")}</button>
          <button type="button" id="btn-cancel-edit-row">${te("action.cancel")}</button>
          <button type="button" id="btn-delete-row" style="margin-left:auto; color:#b91c1c; border-color:#b91c1c">${te("action.delete")}</button>
        </div>
      </form>
    </section>
  `;
}

/** Extra's cell text for the row table — every key, unlike the viewer's Extra column which hides `buy_url` (it has a separate Buy button; the editor doesn't, so buy_url is just another value to audit here). */
function extraCellText(extra: Record<string, string>): string {
  return Object.entries(extra)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");
}

function renderRowsSection(rows: ReturnType<typeof listRowsForImage>, editingRowId: number | null, editingUrl: string | null): string {
  const [urlW, nameW, skuW, descriptionW, extraW] = colWidths.rows;
  return `
    <section>
      <h2>${te("rows.title", { count: rows.length })}</h2>
      <div class="table-scroll">
        <table data-col-key="rows" style="table-layout:fixed; width:${colTableTotalWidth("rows")}px">
          <colgroup><col style="width:${urlW}px"><col style="width:${nameW}px"><col style="width:${skuW}px"><col style="width:${descriptionW}px"><col style="width:${extraW}px"></colgroup>
          <thead><tr>
            <th>${te("column.address")}<span class="col-resize-handle" data-table="rows" data-col="0"></span></th>
            <th>${te("column.name")}<span class="col-resize-handle" data-table="rows" data-col="1"></span></th>
            <th>${skuLabel()}<span class="col-resize-handle" data-table="rows" data-col="2"></span></th>
            <th>${te("column.description")}<span class="col-resize-handle" data-table="rows" data-col="3"></span></th>
            <th>${te("column.extra")}<span class="col-resize-handle" data-table="rows" data-col="4"></span></th>
          </tr></thead>
          <tbody>
            ${rows
              .map((r) => {
                // .editing: this exact row is open for editing. .row-match
                // (new, mutually exclusive with .editing): not itself open,
                // but its Address matches the hotspot/link that *is* — e.g.
                // clicking a hotspot only ever sets editingLinkId, never
                // editingRowId, so the id check alone would miss this
                // row-in-the-table entirely. Mirrors the stage's own
                // hotspot .row-match highlight (see hotspotHtml above),
                // just pointed the other direction: hotspot → table row.
                const isEditing = r.id === editingRowId;
                const isRowMatch = !isEditing && editingUrl !== null && r.url === editingUrl;
                const rowClass = isEditing ? " editing" : isRowMatch ? " row-match" : "";
                // Extra alone gets the hover-expand treatment (see .extra-cell in
                // style.css) — it's the column most likely to overflow a
                // reasonably-sized column, and this is meant for a quick spot-check
                // across the whole image, not a place to also copy from (that's
                // still the row's own edit form).
                return `<tr data-row-id="${r.id}" class="clickable-row${rowClass}"><td>${escapeHtml(r.url)}</td><td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.sku)}</td><td>${escapeHtml(r.description)}</td><td class="extra-cell"><span class="cell-text">${escapeHtml(extraCellText(r.extra))}</span></td></tr>`;
              })
              .join("")}
          </tbody>
        </table>
      </div>
      <p class="hint">${tMode(db ? readMeta(db).catalogMode : "commercial", "rows.hint")}</p>
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

  document.getElementById("lang-select")?.addEventListener("change", (evt) => {
    const chosen = matchLocale((evt.target as HTMLSelectElement).value, EDITOR_LOCALES);
    if (!chosen || chosen === locale) return;
    locale = chosen;
    saveLocale(chosen);
    document.documentElement.lang = chosen;
    document.title = t("toolbar.title");
    statusMessage = ""; // was worded in the previous language
    render();
  });
  document.getElementById("btn-theme")?.addEventListener("click", () => {
    toggleTheme();
    render();
  });

  document.getElementById("divider-images")?.addEventListener("pointerdown", (evt) => startPanelResize(evt as PointerEvent, "images"));
  document.getElementById("divider-inspector")?.addEventListener("pointerdown", (evt) => startPanelResize(evt as PointerEvent, "inspector"));

  document.querySelectorAll<HTMLElement>(".col-resize-handle").forEach((handle) => {
    handle.addEventListener("pointerdown", (evt) => {
      const tableKey = handle.dataset.table as ColTableKey;
      const colIndex = Number(handle.dataset.col);
      startColumnResize(evt as PointerEvent, tableKey, colIndex);
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
  document.getElementById("btn-export-pdf")?.addEventListener("click", actionOpenPdfOptions);
  document.getElementById("btn-export-protected")?.addEventListener("click", actionOpenProtectDialog);
  wireProtectDialog();
  document.getElementById("pdf-options-cancel")?.addEventListener("click", actionCancelPdfOptions);
  document.getElementById("pdf-options-submit")?.addEventListener("click", () => void actionConfirmExportPdf());
  document.querySelectorAll<HTMLInputElement>('input[name="pdf-qr-placement"]').forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) pdfQrPlacement = input.value as QrPlacement;
    });
  });
  document.querySelectorAll<HTMLInputElement>('input[name="pdf-diagram-page-mode"]').forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) pdfDiagramPageMode = input.value as DiagramPageMode;
    });
  });

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
  document.getElementById("collab-not-found-cancel")?.addEventListener("click", actionCancelCollabNotFound);
  document.getElementById("collab-not-found-retry")?.addEventListener("click", () => void actionRetryCollabDetect());
  document.getElementById("collab-manual-url-submit")?.addEventListener("click", actionUseManualCollabUrl);
  const collabManualUrlInput = document.getElementById("collab-manual-url-input") as HTMLInputElement | null;
  collabManualUrlInput?.addEventListener("input", () => {
    collabManualUrlValue = collabManualUrlInput.value;
  });
  collabManualUrlInput?.addEventListener("keydown", (evt) => {
    if (evt.key === "Enter" && collabManualUrlInput.value.trim()) actionUseManualCollabUrl();
    if (evt.key === "Escape") actionCancelCollabNotFound();
  });
  document.getElementById("btn-start-collab")?.addEventListener("click", () => void actionStartCollaboration());
  document.getElementById("btn-copy-collab-link")?.addEventListener("click", actionOpenCollabShareDialog);
  document.getElementById("collab-share-copy")?.addEventListener("click", () => void actionCopyCollabLink());
  document.getElementById("collab-share-close")?.addEventListener("click", actionCloseCollabShareDialog);
  const collabShareLinkInput = document.getElementById("collab-share-link-input") as HTMLTextAreaElement | null;
  collabShareLinkInput?.addEventListener("click", () => collabShareLinkInput.select());
  collabShareLinkInput?.addEventListener("keydown", (evt) => {
    if (evt.key === "Escape") actionCloseCollabShareDialog();
  });
  if (collabShareDialogOpen) {
    collabShareLinkInput?.focus();
    collabShareLinkInput?.select();
  }
  document.getElementById("btn-leave-collab")?.addEventListener("click", actionLeaveCollaboration);
  document.getElementById("btn-end-collab-session")?.addEventListener("click", actionConfirmEndSessionForEveryone);
  document.getElementById("collab-name-cancel")?.addEventListener("click", actionCancelCollabNameDialog);
  document.getElementById("collab-name-submit")?.addEventListener("click", actionSubmitCollabNameDialog);
  const collabNameInput = document.getElementById("collab-name-input") as HTMLInputElement | null;
  const collabNameSubmitBtn = document.getElementById("collab-name-submit") as HTMLButtonElement | null;
  collabNameInput?.addEventListener("input", () => {
    collabNameValue = collabNameInput.value;
    if (collabNameSubmitBtn) collabNameSubmitBtn.disabled = !collabNameInput.value.trim();
  });
  collabNameInput?.addEventListener("keydown", (evt) => {
    if (evt.key === "Enter" && collabNameInput.value.trim()) actionSubmitCollabNameDialog();
    if (evt.key === "Escape") actionCancelCollabNameDialog();
  });
  if (collabNameDialogOpen) {
    collabNameInput?.focus();
    collabNameInput?.setSelectionRange(collabNameInput.value.length, collabNameInput.value.length);
  }
  document.getElementById("store-settings-cancel")?.addEventListener("click", actionCancelStoreSettings);
  document.getElementById("store-settings-submit")?.addEventListener("click", actionSubmitStoreSettings);
  document.querySelectorAll<HTMLInputElement>('input[name="catalog-mode"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      storeSettingsCatalogMode = readCatalogMode(radio.value);
      render(); // re-labels the fields below (see renderStoreSettingsDialog)
    });
  });
  const storeUrlInput = document.getElementById("store-url-input") as HTMLInputElement | null;
  storeUrlInput?.addEventListener("input", () => {
    storeSettingsUrlValue = storeUrlInput.value;
  });
  document.querySelectorAll<HTMLInputElement>('input[name="cart-mode"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      if (radio.checked) storeSettingsCartMode = radio.value as "accumulate" | "instant";
    });
  });
  document.querySelectorAll<HTMLInputElement>('input[name="default-view"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      if (radio.checked) storeSettingsDefaultView = radio.value as "images" | "diagram" | "table";
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
  const stageInner = document.getElementById("stage-inner") as HTMLElement | null;
  if (stageImg && stageScroll) {
    stageImg.addEventListener("pointerdown", (evt) => startStageInteraction(evt, stageImg, stageScroll));
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
      if (link) el.addEventListener("pointerdown", (evt) => startDragHotspot(evt, link, el, stageImg));
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
  // "Goes to image" select (renderNavTargetField): sets the address to
  // #image=<id>; back to "—" clears a navigation address so a new one can be typed.
  document.querySelectorAll<HTMLSelectElement>(".nav-target-select").forEach((sel) => {
    sel.addEventListener("change", () => {
      const form = sel.closest("form");
      const urlInput = form?.querySelector<HTMLInputElement>('input[name="url"]');
      const nameInput = form?.querySelector<HTMLInputElement>('input[name="name"]');
      if (!urlInput) return;
      if (sel.value) {
        urlInput.value = navLinkUrl(Number(sel.value));
        urlInput.dispatchEvent(new Event("input")); // stops the name→address auto-slug
        if (nameInput && !nameInput.value) nameInput.value = sel.selectedOptions[0]?.textContent ?? "";
      } else if (navTargetImageId(urlInput.value) !== null) {
        urlInput.value = "";
      }
    });
  });
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
    const formEl = evt.target as HTMLFormElement;
    const fd = new FormData(formEl);
    const url = String(fd.get("url") ?? "");
    const name = String(fd.get("name") ?? "");
    const sku = String(fd.get("sku") ?? "");
    const description = String(fd.get("description") ?? "");
    resolveExtraThen(formEl, (extra) => actionAddRow(url, name, sku, description, extra));
  });

  document.querySelectorAll<HTMLTableRowElement>("tr[data-row-id]").forEach((tr) => {
    tr.addEventListener("click", () => actionEditRow(Number(tr.dataset.rowId)));
  });

  document.getElementById("form-edit-row")?.addEventListener("submit", (evt) => {
    evt.preventDefault();
    const formEl = evt.target as HTMLFormElement;
    const fd = new FormData(formEl);
    const name = String(fd.get("name") ?? "");
    const sku = String(fd.get("sku") ?? "");
    const description = String(fd.get("description") ?? "");
    resolveExtraThen(formEl, (extra) => actionSaveRowEdit(name, sku, description, extra));
  });
  document.getElementById("btn-cancel-edit-row")?.addEventListener("click", actionCancelEditRow);
  document.getElementById("btn-delete-row")?.addEventListener("click", actionDeleteRow);

  document.querySelectorAll<HTMLElement>(".extra-field").forEach(wireExtraField);
}

// ---------- presence activity tracking (Phase 5) ----------
// Wired once at module load, not inside wireEvents() (which reruns on every
// render) — these listen on `document` regardless of what's currently
// rendered, and adding a fresh copy on every render would pile up
// duplicates. See isPresenceActive()'s doc for what these feed into.
document.addEventListener("mousemove", notePresenceActivity, { passive: true });
document.addEventListener("mousedown", notePresenceActivity);
document.addEventListener("keydown", notePresenceActivity);
document.addEventListener("touchstart", notePresenceActivity, { passive: true });
document.addEventListener("visibilitychange", reconcilePresenceActive);
// Catches the idle timeout expiring on its own — a still-visible tab with
// zero further input wouldn't otherwise fire any of the listeners above
// again to notice.
setInterval(reconcilePresenceActive, 15_000);

void boot();

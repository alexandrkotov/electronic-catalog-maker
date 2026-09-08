/**
 * Exports a whole catalog as a single printable A4 PDF — backlog item "PDF +
 * QR export". One PDF for the entire catalog (not one per image), built
 * with pdf-lib (pure TS, no native deps — fits this project's static/
 * serverless architecture) + @pdf-lib/fontkit so a real Unicode font can be
 * embedded: pdf-lib's own built-in fonts are WinAnsi-only, and real
 * catalogs here are sometimes Cyrillic (the legacy .sch import). The font
 * itself (DejaVu Sans, a free/Bitstream-Vera-licensed static font — a
 * *variable* Unicode font was tried first and rejected: pdf-lib + fontkit
 * silently dropped most glyphs with it, confirmed by direct comparison, not
 * a subsetting artifact since it happened with `subset: false` too) lives
 * at assets/fonts/ and is handed in
 * as already-fetched bytes — this module has no opinion on bundler/URL
 * resolution, same split as initSqlite's wasmUrl.
 *
 * Two rendering modes per image, chosen purely from how many hotspots
 * (links) it has — no schema change needed, and it already matches every
 * real catalog in this repo:
 * - Exactly one link: a "tile" — a flat product photo where the whole
 *   picture is one buy target. Consecutive tile images (within one
 *   images.folder group — see groupImagesByFolder) are packed into a grid
 *   across as many pages as needed, with one shared data table right after
 *   the last tile. Its QR (if the row has a buy_url) sits inset in the
 *   tile's own top-right corner, its hotspot number/label in the top-left.
 * - Two or more links: a "diagram". Two flavors, detected from the
 *   hotspots' own pixel positions (see detectGrid), not the schema:
 *   - Most diagrams (an exploded-view schematic, or a photograph with a
 *     handful of labeled parts) have hotspots at whatever irregular spots
 *     the parts actually are. Each one gets its label centered on its own
 *     point (mirroring the on-screen `.hotspot` overlay) plus, if the row
 *     has a buy_url, a small QR just to the side of it.
 *   - Some catalogs (see the монетизация cold-pitch playbook's
 *     tile-diagram-compose tool) composite several product photos into one
 *     big image with a hotspot centered on each — a real tile grid in
 *     everything but the schema. Their hotspots sit on an evenly-spaced 2D
 *     grid; detectGrid recognizes that and switches to the tile treatment
 *     per inferred cell instead — label top-left of the cell, QR top-right
 *     — so it reads the same as a real tile grid despite being one image.
 *   Either way the image fills the page and the row table follows directly
 *   below, continuing onto further pages if it doesn't fit.
 *
 * Every QR encodes an "instant, single-item" checkout link (see
 * cart.ts buildInstantBuyUrl) regardless of the catalog's own cart_mode —
 * a printed code has no cart to add to, just one item to jump straight to.
 * Rows without a buy_url get no QR at all (not an empty placeholder).
 *
 * The row table always shows Name/SKU/Description/Extra — the same four
 * columns and same "key: value, …" Extra formatting the viewer's own table
 * uses (see viewerEngine.ts rowHtml) — but never the buy_url itself, since
 * that's now the QR code instead of printed text.
 */
import { PDFDocument, PDFFont, PDFPage, rgb, type PDFImage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import type { Database } from "sql.js";
import { listImages, listLinksForImage, listRowsForImage, readMeta } from "./db.js";
import { groupImagesByFolder } from "./images.js";
import { buildInstantBuyUrl } from "./cart.js";
import { buildQrMatrix, type QrMatrix } from "./qrcode.js";
import type { CatalogImage, CatalogLink, CatalogMeta, CatalogRow } from "./types.js";

// A4 in PDF points (1pt = 1/72in): 210mm x 297mm.
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 36; // 0.5in
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const CONTENT_TOP = PAGE_HEIGHT - MARGIN;
const CONTENT_BOTTOM = MARGIN;

const TILE_COLUMNS = 3;
const TILE_GAP = 10;
const TILE_INNER_PADDING = 6; // between a tile's border and the image drawn inside it
/**
 * Corner badge on a tile vs. next to a hotspot label on a diagram — a
 * diagram's code sits over busy artwork and needs to stay findable next to
 * a specific number among dozens of others, so it gets a bit more room; a
 * tile's code is the only one on its card. Both are deliberately small —
 * "as small as possible but reliably scannable" — tune here after a real
 * printed test if a phone camera struggles at these sizes.
 */
const TILE_QR_SIZE = 26;
const DIAGRAM_QR_SIZE = 32;
// How tight the QR/badge sit against a tile's own border — deliberately
// small (not 0): a hair of breathing room so the code's white backing
// doesn't visually fuse with the border stroke, while still reading as
// "pressed into the corner", not floating with real margin around it.
const TILE_QR_INSET = 1.5;
const TILE_BADGE_INSET = 1.5;
const TILE_BADGE_FONT_SIZE = 10;
const TILE_BADGE_PADDING = 3;
/**
 * Where a grid-detected diagram's hotspot actually sits relative to its
 * own card, as a fraction of the grid pitch (CatalogLink.top/left is the
 * pitch's own reference point, not the card's true corner or size) —
 * measured directly against a real composited file (streetrodhq-
 * alternators-taillights-gauges-demo.ecatm, card 1: pitch 302×292px,
 * hotspot at +33/+27px from the card's own top-left, card itself
 * 272×262px — consistently ~90% of the pitch on both axes). One real file
 * is what there is to go on; expect to retune these after a look at more.
 */
const GRID_MARGIN_X_FRACTION = 0.11;
const GRID_MARGIN_Y_FRACTION = 0.09;
const GRID_VISIBLE_FRACTION = 0.9;
/**
 * Reserved strip around a diagram's image, only when at least one hotspot's
 * label/QR would otherwise collide with another's — wide enough for a
 * badge+QR tag plus its leader line's approach, at the cost of a slightly
 * smaller diagram on pages that need it. Uncrowded diagrams don't pay for
 * this at all (see renderDiagramPage's own doc).
 */
const LEADER_MARGIN = 60;

const TABLE_FONT_SIZE = 8.5;
const TABLE_HEADER_FONT_SIZE = 9;
const TABLE_LINE_HEIGHT = 11;
const TABLE_CELL_PADDING = 4;
// "No." is link.name — not always a bare number (see hotspotHtml in
// viewerEngine.ts: any text is a valid hotspot label, and real catalogs
// use short words too, e.g. "Backrest"/"Seat"/"Leg") — wide enough for a
// short word without wrapping every line, not just a single digit.
const TABLE_COLUMNS: { key: "no" | "name" | "sku" | "description" | "extra"; header: string; width: number }[] = [
  { key: "no", header: "No.", width: 50 },
  { key: "name", header: "Name", width: 110 },
  { key: "sku", header: "SKU", width: 60 },
  { key: "description", header: "Description", width: 178 },
  { key: "extra", header: "Extra", width: CONTENT_WIDTH - 50 - 110 - 60 - 178 },
];

/** One row plus the hotspot number(s) — link.name, the same value on-image/on-tile — that point at it on this page/section. Several when one part is drawn at more than one shared position on the same diagram. */
interface TableEntry {
  row: CatalogRow;
  no: string;
}

/** Where the next thing gets drawn — one page plus a "next free y" cursor, shared by every render helper below so pagination logic lives in one place. */
interface Cursor {
  doc: PDFDocument;
  page: PDFPage;
  /** PDF y-coordinate (grows upward) of the top edge the next element should start at. */
  y: number;
}

function newPage(doc: PDFDocument): PDFPage {
  return doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
}

/** Starts a fresh page if `neededHeight` doesn't fit below the cursor any more. */
function ensureRoom(cursor: Cursor, neededHeight: number) {
  if (cursor.y - neededHeight < CONTENT_BOTTOM) {
    cursor.page = newPage(cursor.doc);
    cursor.y = CONTENT_TOP;
  }
}

function base64ToBytes(base64: string): Uint8Array {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * pdf-lib only embeds JPEG/PNG natively. Catalog images can be anything a
 * browser's <input type=file accept="image/*"> reports (the editor doesn't
 * convert on add) — so anything else gets rasterized to PNG via an
 * offscreen canvas first, same trick a screenshot tool would use.
 */
async function embedCatalogImage(doc: PDFDocument, image: CatalogImage): Promise<PDFImage> {
  const bytes = base64ToBytes(image.imageData);
  if (image.mimeType === "image/jpeg" || image.mimeType === "image/jpg") return doc.embedJpg(bytes);
  if (image.mimeType === "image/png") return doc.embedPng(bytes);

  const blob = new Blob([bytes as BlobPart], { type: image.mimeType });
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  const pngBlob: Blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas.toBlob failed"))), "image/png"),
  );
  return doc.embedPng(new Uint8Array(await pngBlob.arrayBuffer()));
}

/**
 * Draws one QR code with its own opaque white backing (it usually sits on
 * top of image artwork, so the quiet zone needs to actually be white, not
 * see-through) as a single filled SVG path — one draw call regardless of
 * module count, not one rectangle per dark module.
 */
function drawQrCode(page: PDFPage, matrix: QrMatrix, x: number, yTop: number, sizePt: number) {
  const scale = sizePt / matrix.size;
  page.drawRectangle({ x, y: yTop - sizePt, width: sizePt, height: sizePt, color: rgb(1, 1, 1) });

  let path = "";
  for (let row = 0; row < matrix.moduleCount; row++) {
    for (let col = 0; col < matrix.moduleCount; col++) {
      if (matrix.isDark(row, col)) path += `M${col + matrix.quietZone} ${row + matrix.quietZone}h1v1h-1z`;
    }
  }
  if (path) page.drawSvgPath(path, { x, y: yTop, scale, color: rgb(0, 0, 0) });
}

/**
 * A tile's own hotspot label ("1", "2", …) inset into its top-left corner —
 * the same number that would show as a hotspot overlay in the editor/
 * viewer (see hotspotHtml in viewerEngine.ts), so a printed tile still
 * carries the position/link identity it's built around, not just a photo.
 * Same white-backing trick as drawQrCode: a tile photo can be dark or busy
 * enough to swallow bare text otherwise.
 */
function drawTileBadge(page: PDFPage, text: string, font: PDFFont, x: number, yTop: number) {
  if (!text) return;
  const width = font.widthOfTextAtSize(text, TILE_BADGE_FONT_SIZE) + TILE_BADGE_PADDING * 2;
  const height = TILE_BADGE_FONT_SIZE + TILE_BADGE_PADDING * 1.5;
  page.drawRectangle({ x, y: yTop - height, width, height, color: rgb(1, 1, 1), borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 0.5 });
  page.drawText(text, { x: x + TILE_BADGE_PADDING, y: yTop - height + TILE_BADGE_PADDING * 0.75, size: TILE_BADGE_FONT_SIZE, font, color: rgb(0, 0, 0) });
}

/**
 * Same badge, centered on a point instead of anchored by its top-left
 * corner — matches how a hotspot's own label actually sits on screen
 * (viewerEngine.ts's `.hotspot` CSS centers it on `top`/`left` via
 * `transform: translate(-50%, -50%)`, it isn't the label's own corner).
 * Used for an ordinary diagram's hotspots, where there's no inferred cell
 * to anchor a corner to — see detectGrid.
 */
function drawBadgeCentered(page: PDFPage, text: string, font: PDFFont, centerX: number, centerY: number) {
  if (!text) return;
  const width = font.widthOfTextAtSize(text, TILE_BADGE_FONT_SIZE) + TILE_BADGE_PADDING * 2;
  const height = TILE_BADGE_FONT_SIZE + TILE_BADGE_PADDING * 1.5;
  drawTileBadge(page, text, font, centerX - width / 2, centerY + height / 2);
}

/**
 * Recognizes a diagram whose hotspots sit on an evenly-spaced 2D grid —
 * the signature of the монетизация cold-pitch playbook's tile-diagram-
 * compose tool, which composites several product photos into one image
 * with a hotspot centered on each (see this module's own top comment).
 * Real exploded-view/hand-placed hotspots don't line up this precisely by
 * coincidence. Requires at least a 2×2 grid and a handful of hotspots —
 * a genuine diagram can easily have 2-3 hotspots that happen to share an
 * x or y coordinate without being a grid at all.
 *
 * Returns the inferred cell size in the image's own pixel space (same
 * units as CatalogLink.top/left), or null if this doesn't look like one.
 */
function detectGrid(links: CatalogLink[]): { cellW: number; cellH: number } | null {
  if (links.length < 4) return null;

  const spacing = (values: number[]): number | null => {
    const sorted = [...new Set(values)].sort((a, b) => a - b);
    if (sorted.length < 2) return null;
    const diffs = sorted.slice(1).map((v, i) => v - sorted[i]!);
    const avg = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    if (avg <= 0) return null;
    // A little tolerance for coordinates that were nudged by a pixel or
    // two when authored, not just machine-perfect compositing output.
    const uniform = diffs.every((d) => Math.abs(d - avg) <= avg * 0.15 + 2);
    return uniform ? avg : null;
  };

  const cellW = spacing(links.map((l) => l.left));
  const cellH = spacing(links.map((l) => l.top));
  return cellW && cellH ? { cellW, cellH } : null;
}

/** Word-wraps `text` to fit `maxWidth` at `size` in `font`, hard-breaking any single word that's wider than the column on its own. */
function wrapText(font: PDFFont, text: string, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];

  const lines: string[] = [];
  let current = words[0]!; // guarded by the length check above
  for (let i = 1; i < words.length; i++) {
    const word = words[i]!;
    const attempt = `${current} ${word}`;
    if (font.widthOfTextAtSize(attempt, size) <= maxWidth) current = attempt;
    else {
      lines.push(current);
      current = word;
    }
  }
  lines.push(current);

  const out: string[] = [];
  for (const line of lines) {
    if (line.length <= 1 || font.widthOfTextAtSize(line, size) <= maxWidth) {
      out.push(line);
      continue;
    }
    let chunk = "";
    for (const ch of line) {
      const attempt = chunk + ch;
      if (chunk && font.widthOfTextAtSize(attempt, size) > maxWidth) {
        out.push(chunk);
        chunk = ch;
      } else {
        chunk = attempt;
      }
    }
    if (chunk) out.push(chunk);
  }
  return out;
}

/** Same "key: value, key2: value2" formatting as the viewer's own table (rowHtml in viewerEngine.ts), minus buy_url — that's the QR code now, not printed text. */
function extraCellText(row: CatalogRow): string {
  return Object.entries(row.extra)
    // buy_url: now the QR code instead of printed text. no: some catalogs
    // (the монетизация cold-pitch demos predate this table's own "No."
    // column) stash the same hotspot number here by convention — now
    // redundant with that column, so it's dropped the same way.
    .filter(([k]) => k !== "buy_url" && k !== "no")
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join(", ");
}

function buyUrlOf(row: CatalogRow | undefined | null): string {
  return row && typeof row.extra.buy_url === "string" && row.extra.buy_url.trim() ? row.extra.buy_url.trim() : "";
}

function drawTableHeader(cursor: Cursor, font: PDFFont) {
  const headerHeight = TABLE_LINE_HEIGHT + TABLE_CELL_PADDING;
  ensureRoom(cursor, headerHeight);
  cursor.page.drawRectangle({ x: MARGIN, y: cursor.y - headerHeight, width: CONTENT_WIDTH, height: headerHeight, color: rgb(0.9, 0.9, 0.9) });
  let x = MARGIN;
  for (const col of TABLE_COLUMNS) {
    cursor.page.drawText(col.header, { x: x + TABLE_CELL_PADDING, y: cursor.y - headerHeight + 3, size: TABLE_HEADER_FONT_SIZE, font });
    x += col.width;
  }
  cursor.y -= headerHeight;
}

/** Draws the shared row table for one page/section — always its own header, paginating (with the header repeated) whenever a row doesn't fit. */
function drawTableRows(cursor: Cursor, font: PDFFont, entries: TableEntry[]) {
  if (entries.length === 0) return;
  drawTableHeader(cursor, font);

  for (const { row, no } of entries) {
    const cellValues = [no, row.name, row.sku, row.description, extraCellText(row)];
    const wrapped = TABLE_COLUMNS.map((col, i) => wrapText(font, cellValues[i]!, TABLE_FONT_SIZE, col.width - TABLE_CELL_PADDING * 2));
    const lineCount = Math.max(...wrapped.map((w) => w.length));
    const rowHeight = lineCount * TABLE_LINE_HEIGHT + TABLE_CELL_PADDING;

    if (cursor.y - rowHeight < CONTENT_BOTTOM) {
      cursor.page = newPage(cursor.doc);
      cursor.y = CONTENT_TOP;
      drawTableHeader(cursor, font);
    }

    let x = MARGIN;
    for (let i = 0; i < TABLE_COLUMNS.length; i++) {
      const col = TABLE_COLUMNS[i]!;
      const lines = wrapped[i]!;
      for (let li = 0; li < lines.length; li++) {
        cursor.page.drawText(lines[li]!, { x: x + TABLE_CELL_PADDING, y: cursor.y - TABLE_LINE_HEIGHT * (li + 1) + 2, size: TABLE_FONT_SIZE, font });
      }
      x += col.width;
    }
    cursor.page.drawLine({
      start: { x: MARGIN, y: cursor.y - rowHeight },
      end: { x: MARGIN + CONTENT_WIDTH, y: cursor.y - rowHeight },
      thickness: 0.5,
      color: rgb(0.8, 0.8, 0.8),
    });
    cursor.y -= rowHeight;
  }
}

/** One hotspot's label + (if its row has a buy_url) QR, and where it naturally wants to sit before any crowding is resolved. */
interface DiagramUnit {
  link: CatalogLink;
  pointX: number;
  pointY: number;
  matrix: QrMatrix | null;
  badgeW: number;
  badgeH: number;
}

/** The badge always sits centered on its own hotspot and never moves (see findQrsToMove's own doc) — this is just that fixed box, for overlap detection. */
function badgeBounds(u: DiagramUnit) {
  return { left: u.pointX - u.badgeW / 2, right: u.pointX + u.badgeW / 2, top: u.pointY + u.badgeH / 2, bottom: u.pointY - u.badgeH / 2 };
}

/** Where this hotspot's QR would sit if nothing needed to move it (offset down-right of the point) — used only for overlap detection; the actual draw position also clamps to the image bounds. */
function naturalQrBounds(u: DiagramUnit) {
  const left = u.pointX + 8;
  const top = u.pointY - 8;
  return { left, right: left + DIAGRAM_QR_SIZE, top, bottom: top - DIAGRAM_QR_SIZE };
}

function boxesOverlap(a: { left: number; right: number; top: number; bottom: number }, b: typeof a): boolean {
  return a.left < b.right && a.right > b.left && a.bottom < b.top && a.top > b.bottom;
}

/**
 * Which hotspots' QR codes would collide with another hotspot's badge or
 * QR at their natural placement — a real risk on any diagram with several
 * closely-spaced positions (docked next to one shared printed label, per
 * the catalog-building conventions), since a QR sized for on-screen
 * viewing doesn't shrink along with the image once the whole diagram is
 * scaled down to fit one printed page. Only the QR side of a collision
 * ever relocates — the hotspot's own numbered badge always stays exactly
 * where the hotspot is; a relocated QR gets a thin leader line back to it
 * instead. Returns the offending links' own ids.
 */
function findQrsToMove(units: DiagramUnit[]): Set<number> {
  const withQr = units.filter((u) => u.matrix);
  const toMove = new Set<number>();
  for (let i = 0; i < withQr.length; i++) {
    const a = withQr[i]!;
    const aBox = naturalQrBounds(a);
    if (units.some((b) => b !== a && boxesOverlap(aBox, badgeBounds(b)))) {
      toMove.add(a.link.id);
      continue;
    }
    for (let j = i + 1; j < withQr.length; j++) {
      const b = withQr[j]!;
      if (boxesOverlap(aBox, naturalQrBounds(b))) {
        toMove.add(a.link.id);
        toMove.add(b.link.id);
      }
    }
  }
  return toMove;
}

/**
 * One "diagram" image: fills a fresh page, a QR next to every hotspot
 * whose row has a buy_url, then its row table right below. Every
 * hotspot's numbered badge always stays exactly where the hotspot is; if
 * its QR would collide with another hotspot's badge or QR at print scale,
 * that QR (and only that QR) moves out to the nearest edge of a reserved
 * margin around the image, with a thin leader line back to the badge it
 * belongs to — the printed-catalog equivalent of a map's callout labels,
 * not attempted unless something would actually overlap.
 */
async function renderDiagramPage(
  cursor: Cursor,
  doc: PDFDocument,
  font: PDFFont,
  image: CatalogImage,
  links: CatalogLink[],
  rows: CatalogRow[],
  meta: CatalogMeta,
) {
  // Uses cursor.page/cursor.y exactly as the caller left them — the caller
  // (exportCatalogPdf's own loop) decides when a fresh page is actually
  // needed. Forcing one unconditionally here used to strand a just-drawn
  // catalog-title/folder heading alone on an otherwise-blank page, since
  // this function would immediately abandon that page for a new one.
  const pdfImage = await embedCatalogImage(doc, image);
  const fullTop = cursor.y;
  const rowsByUrl = new Map(rows.map((r) => [r.url, r]));
  // Several links can share one row's url (the same part drawn at more than
  // one position on this diagram) — collect every link name pointing at
  // each url so the table's own "No." column lists all of them, not just
  // whichever happened to be visited last.
  const namesByUrl = new Map<string, string[]>();
  for (const link of links) {
    const list = namesByUrl.get(link.url);
    if (list) list.push(link.name);
    else namesByUrl.set(link.url, [link.name]);
  }

  // See detectGrid's own doc — some diagrams are really a composited grid
  // of product photos wearing one image's clothes; that layout is spaced
  // by construction, so it's never subject to the crowding check below.
  const grid = detectGrid(links);

  function computeRect(margin: number) {
    const availW = CONTENT_WIDTH - margin * 2;
    const availH = fullTop - CONTENT_BOTTOM - margin * 2;
    const scale = Math.min(availW / Math.max(1, image.width), availH / Math.max(1, image.height));
    const drawW = image.width * scale;
    const drawH = image.height * scale;
    const drawX = MARGIN + margin + (availW - drawW) / 2;
    const drawYTop = fullTop - margin;
    return { drawX, drawW, drawH, drawYTop, drawYBottom: drawYTop - drawH };
  }
  function buildUnits(rect: ReturnType<typeof computeRect>): DiagramUnit[] {
    return links.map((link) => {
      const buyUrl = buyUrlOf(rowsByUrl.get(link.url));
      return {
        link,
        pointX: rect.drawX + (link.left / image.width) * rect.drawW,
        pointY: rect.drawYTop - (link.top / image.height) * rect.drawH,
        matrix: buyUrl ? buildQrMatrix(buildInstantBuyUrl(buyUrl, meta), "L") : null,
        badgeW: link.name ? font.widthOfTextAtSize(link.name, TILE_BADGE_FONT_SIZE) + TILE_BADGE_PADDING * 2 : 0,
        badgeH: TILE_BADGE_FONT_SIZE + TILE_BADGE_PADDING * 1.5,
      };
    });
  }

  // Detected once at full size — crowding is a property of how close the
  // hotspots are relative to the label size, which doesn't change enough
  // from reserving a margin afterward to be worth re-checking.
  const toMove = grid ? new Set<number>() : findQrsToMove(buildUnits(computeRect(0)));
  const rect = toMove.size > 0 ? computeRect(LEADER_MARGIN) : computeRect(0);
  const units = buildUnits(rect);

  cursor.page.drawImage(pdfImage, { x: rect.drawX, y: rect.drawYBottom, width: rect.drawW, height: rect.drawH });

  if (grid) {
    for (const u of units) {
      // `point` is near its card's top-left corner (see GRID_MARGIN_*'s own
      // doc), not centered the way an on-screen `.hotspot`'s CSS transform
      // would suggest and not exactly AT the corner either — pull it the
      // rest of the way to the card's own true edges before treating it
      // like a real tile (label top-left, QR top-right).
      const cellWPdf = (grid.cellW / image.width) * rect.drawW;
      const cellHPdf = (grid.cellH / image.height) * rect.drawH;
      const cellLeft = u.pointX - cellWPdf * GRID_MARGIN_X_FRACTION;
      const cellTop = u.pointY + cellHPdf * GRID_MARGIN_Y_FRACTION; // "up" on the image is +y in PDF space
      const cellRight = cellLeft + cellWPdf * GRID_VISIBLE_FRACTION;
      drawTileBadge(cursor.page, u.link.name, font, cellLeft + TILE_BADGE_INSET, cellTop - TILE_BADGE_INSET);
      if (u.matrix) drawQrCode(cursor.page, u.matrix, cellRight - DIAGRAM_QR_SIZE - TILE_QR_INSET, cellTop - TILE_QR_INSET, DIAGRAM_QR_SIZE);
    }
  } else {
    // Every hotspot's own badge always renders right where the hotspot is —
    // see this function's own doc. Only a colliding QR gets relocated below.
    for (const u of units) drawBadgeCentered(cursor.page, u.link.name, font, u.pointX, u.pointY);

    const edgeGroups: Record<"top" | "bottom" | "left" | "right", DiagramUnit[]> = { top: [], bottom: [], left: [], right: [] };
    for (const u of units) {
      if (!u.matrix) continue;
      if (!toMove.has(u.link.id)) {
        // A little further from the point than the badge itself needs —
        // enough to clear it, for a typically-short hotspot label.
        const qrX = Math.min(Math.max(u.pointX + 8, rect.drawX), rect.drawX + rect.drawW - DIAGRAM_QR_SIZE);
        const qrYTop = Math.min(Math.max(u.pointY - 8, rect.drawYBottom + DIAGRAM_QR_SIZE), rect.drawYTop);
        drawQrCode(cursor.page, u.matrix, qrX, qrYTop, DIAGRAM_QR_SIZE);
        continue;
      }
      // Colliding — bucket by whichever edge of the image is closest, so
      // its relocated QR and leader line travel the shortest distance.
      const distances: [("top" | "bottom" | "left" | "right"), number][] = [
        ["top", rect.drawYTop - u.pointY],
        ["bottom", u.pointY - rect.drawYBottom],
        ["left", u.pointX - rect.drawX],
        ["right", rect.drawX + rect.drawW - u.pointX],
      ];
      distances.sort((a, b) => a[1] - b[1]);
      edgeGroups[distances[0]![0]].push(u);
    }

    /** A relocated QR, plus a thin leader line back to the badge that stayed put at the real hotspot. */
    function drawPushedQr(u: DiagramUnit, x: number, yTop: number) {
      drawQrCode(cursor.page, u.matrix!, x, yTop, DIAGRAM_QR_SIZE);
      cursor.page.drawLine({
        start: { x: x + DIAGRAM_QR_SIZE / 2, y: yTop - DIAGRAM_QR_SIZE / 2 },
        end: { x: u.pointX, y: u.pointY },
        thickness: 0.4,
        color: rgb(0.55, 0.55, 0.55),
      });
    }
    /** Spreads a group of relocated QRs evenly along one straight run (top/bottom: left-to-right; left/right: top-to-bottom) — every tag is one QR, so this is a plain even distribution, no per-item sizing to account for. */
    function layoutEdge(group: DiagramUnit[], span: number, sortKey: (u: DiagramUnit) => number, along: (pos: number) => { x: number; y: number }) {
      if (group.length === 0) return;
      group.sort((a, b) => sortKey(a) - sortKey(b));
      const gap = group.length > 1 ? Math.max(4, (span - group.length * DIAGRAM_QR_SIZE) / (group.length - 1)) : 0;
      let pos = 0;
      for (const u of group) {
        const { x, y } = along(pos);
        drawPushedQr(u, x, y);
        pos += DIAGRAM_QR_SIZE + gap;
      }
    }

    layoutEdge(edgeGroups.top, rect.drawW, (u) => u.pointX, (pos) => ({ x: rect.drawX + pos, y: fullTop }));
    layoutEdge(edgeGroups.bottom, rect.drawW, (u) => u.pointX, (pos) => ({ x: rect.drawX + pos, y: CONTENT_BOTTOM + LEADER_MARGIN }));
    layoutEdge(edgeGroups.left, rect.drawH, (u) => -u.pointY, (pos) => ({ x: MARGIN, y: rect.drawYTop - pos }));
    layoutEdge(edgeGroups.right, rect.drawH, (u) => -u.pointY, (pos) => ({ x: MARGIN + CONTENT_WIDTH - DIAGRAM_QR_SIZE, y: rect.drawYTop - pos }));
  }

  cursor.y = (toMove.size > 0 ? CONTENT_BOTTOM : rect.drawYBottom) - 10;
  drawTableRows(
    cursor,
    font,
    rows.map((row) => ({ row, no: (namesByUrl.get(row.url) ?? []).join(", ") })),
  );
}

/** One buffered "tile" image: exactly one link, so the whole picture is one buy target. */
interface TileItem {
  image: CatalogImage;
  link: CatalogLink;
  row: CatalogRow | null;
}

/** Packs buffered tile images into a grid (wrapping to new pages as needed), then the shared table for all of them right after the last one. */
async function flushTileBuffer(cursor: Cursor, doc: PDFDocument, font: PDFFont, tiles: TileItem[], entries: TableEntry[], meta: CatalogMeta) {
  if (tiles.length === 0) return;

  const cellW = (CONTENT_WIDTH - TILE_GAP * (TILE_COLUMNS - 1)) / TILE_COLUMNS;
  const cellH = cellW;
  let col = 0;

  for (const tile of tiles) {
    if (col === 0) ensureRoom(cursor, cellH);
    const x = MARGIN + col * (cellW + TILE_GAP);
    const yTop = cursor.y;
    const yBottom = yTop - cellH;

    cursor.page.drawRectangle({ x, y: yBottom, width: cellW, height: cellH, borderColor: rgb(0.75, 0.75, 0.75), borderWidth: 0.75 });

    const pdfImage = await embedCatalogImage(doc, tile.image);
    const innerW = cellW - TILE_INNER_PADDING * 2;
    const innerH = cellH - TILE_INNER_PADDING * 2;
    const scale = Math.min(innerW / Math.max(1, tile.image.width), innerH / Math.max(1, tile.image.height));
    const drawW = tile.image.width * scale;
    const drawH = tile.image.height * scale;
    cursor.page.drawImage(pdfImage, { x: x + (cellW - drawW) / 2, y: yBottom + (cellH - drawH) / 2, width: drawW, height: drawH });

    drawTileBadge(cursor.page, tile.link.name, font, x + TILE_BADGE_INSET, yTop - TILE_BADGE_INSET);

    const buyUrl = buyUrlOf(tile.row);
    if (buyUrl) {
      const matrix = buildQrMatrix(buildInstantBuyUrl(buyUrl, meta), "L");
      drawQrCode(cursor.page, matrix, x + cellW - TILE_QR_SIZE - TILE_QR_INSET, yTop - TILE_QR_INSET, TILE_QR_SIZE);
    }

    col++;
    if (col >= TILE_COLUMNS) {
      col = 0;
      cursor.y -= cellH + TILE_GAP;
    }
  }
  if (col !== 0) cursor.y -= cellH + TILE_GAP; // a partial last row still consumes a full row's height

  cursor.y += TILE_GAP - 4; // undo the trailing gap, leave a little breathing room before the table
  drawTableRows(cursor, font, entries);
}

/**
 * Builds the whole catalog's PDF and returns its bytes — hand these to a
 * Blob/download, same as exportCatalog's .ecatm bytes. `fontBytes` is the
 * caller's own fetch of assets/fonts/DejaVuSans.ttf (resolved however its
 * bundler does URLs, same split as initSqlite's wasmUrl).
 */
export async function exportCatalogPdf(db: Database, fontBytes: Uint8Array): Promise<Uint8Array> {
  const meta = readMeta(db);
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fontBytes, { subset: true });

  const cursor: Cursor = { doc, page: newPage(doc), y: CONTENT_TOP };
  cursor.page.drawText(meta.catalogName || "Catalog", { x: MARGIN, y: cursor.y - 18, size: 18, font });
  cursor.y -= 32;
  // True right after a heading/title has been drawn onto an otherwise-empty
  // page — lets a diagram share that page instead of forcing a fresh one
  // and stranding the heading alone (see renderDiagramPage's own comment).
  // Flips false the moment either a diagram or a tile grid actually draws.
  let freshPage = true;

  const groups = groupImagesByFolder(listImages(db));
  let isFirstGroup = true;
  for (const group of groups) {
    if (group.folder) {
      if (!isFirstGroup) {
        cursor.page = newPage(doc);
        cursor.y = CONTENT_TOP;
      }
      cursor.page.drawText(group.folder, { x: MARGIN, y: cursor.y - 14, size: 13, font });
      cursor.y -= 26;
      freshPage = true;
    }
    isFirstGroup = false;

    // Buffered per folder, per the user's own call — a run of tile images
    // never merges its shared table across a folder boundary, even if the
    // next folder also starts with tiles.
    let tileBuffer: TileItem[] = [];
    let tileEntries: TableEntry[] = [];
    let tileSeenUrls = new Set<string>();

    const flush = async () => {
      if (tileBuffer.length > 0) freshPage = false;
      await flushTileBuffer(cursor, doc, font, tileBuffer, tileEntries, meta);
      tileBuffer = [];
      tileEntries = [];
      tileSeenUrls = new Set();
    };

    for (const image of group.images) {
      const links = listLinksForImage(db, image.id);
      const rows = listRowsForImage(db, image.id);

      if (links.length <= 1) {
        const link = links[0];
        if (link) {
          const row = rows.find((r) => r.url === link.url) ?? null;
          tileBuffer.push({ image, link, row });
        }
        for (const r of rows) {
          if (tileSeenUrls.has(r.url)) continue;
          tileSeenUrls.add(r.url);
          tileEntries.push({ row: r, no: link?.url === r.url ? link.name : "" });
        }
        continue; // an unlinked image (0 links) has nothing to show as a tile — silently skipped
      }

      await flush();
      if (!freshPage) {
        cursor.page = newPage(doc);
        cursor.y = CONTENT_TOP;
      }
      freshPage = false;
      await renderDiagramPage(cursor, doc, font, image, links, rows, meta);
    }
    await flush();
  }

  return doc.save();
}

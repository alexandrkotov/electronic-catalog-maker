/**
 * The two choices a user makes in the "Export PDF…" options dialog before
 * exportCatalogPdf (pdfExport.ts) actually runs. Split into their own file,
 * with no pdf-lib import, so viewerEngine.ts — which every consumer of this
 * package's barrel (editor/viewer/viewer-embed) pulls in statically — can
 * reference these types/defaults directly without pulling pdf-lib into
 * every bundle that mounts the viewer (see pdfExport.ts's own top comment,
 * and index.ts's comment on why pdfExport.ts itself isn't re-exported here).
 *
 * Both only affect "diagram" images (2+ hotspots) — a "tile" image (exactly
 * one hotspot, the whole picture is one buy target) always keeps its single
 * small on-corner QR and its already-small size, regardless of either
 * setting: neither question makes sense for it (there's nowhere else to put
 * a tile's QR, and a product photo has no "real size" worth preserving the
 * way a diagram's own spatial layout does).
 */

import type { Database } from "sql.js";
import { listImages, listLinksForImage } from "./db.js";
import { isNavLink } from "./navLink.js";
import type { CatalogLink } from "./types.js";

/** Where a diagram's QR codes render. Default "table" — set by the user after live-testing found the on-image codes, however small, still visually competed with a crowded diagram's own artwork; the table column reads cleanly regardless of how busy the image is. */
export type QrPlacement = "image" | "table" | "both";

/** Not applied to a composited tile grid, which always prints at page width cut between rows (pdfExport.ts renderGridByRows). Shrink a diagram to fit one A4 page (default, existing behavior), or print it at its real on-screen size — same pixel-to-point mapping as this app's own 100% zoom — split across as many A4 sheets as that takes, for a diagram too detailed to read once shrunk to one page. */
export type DiagramPageMode = "fit" | "real-size";

/**
 * "small" (default; "large" for a tile grid, see suggestedQrSize): the smallest codes a phone still reliably reads. "large": 1.5× — with
 * several small codes on one sheet a phone camera tends to jump between them; a bigger code
 * fills more of the frame, so it locks onto the one being aimed at. Applies to every QR.
 */
export type QrSize = "small" | "large";

/** The sheet the PDF is laid out for. */
export type PdfPageSize = "a4" | "letter";

export interface PdfExportOptions {
  qrPlacement: QrPlacement;
  diagramPageMode: DiagramPageMode;
  qrSize: QrSize;
  /**
   * Default true (existing behavior, unchanged for every catalog that
   * doesn't touch this). A single composited tile grid (Grid Composer)
   * draws its own title pill right into the image — for a catalog that's
   * just one such grid, the page-1 heading repeats that same text with
   * nothing else on the page above it, worth turning off for a one-page
   * printed flyer. Left on by default since a real diagram (no baked-in
   * title) or a multi-folder catalog still needs it.
   */
  showTitle: boolean;
  /**
   * Default (also when omitted) true. The folder name printed above a folder's first image. Off
   * for a catalog whose images already carry the folder's name in their own
   * artwork (a title drawn into each image), where the heading only repeats
   * it. Each folder still starts on its own page. Not asked in the dialog.
   */
  showFolderHeadings?: boolean;
  /** Default (also when omitted) "a4". "letter" for a printout meant for US Letter paper — an A4 page comes out shrunk or cropped there. Not asked in the dialog. */
  pageSize?: PdfPageSize;
}

export const DEFAULT_PDF_EXPORT_OPTIONS: PdfExportOptions = {
  qrPlacement: "table",
  diagramPageMode: "fit",
  qrSize: "small",
  showTitle: true,
  showFolderHeadings: true,
};

/**
 * Recognizes a diagram whose hotspots sit on an evenly-spaced 2D grid —
 * the signature of a composited tile grid (Grid Composer, and the
 * hand-made tile-diagram-compose tool before it), several product photos
 * in one image with a hotspot on each (see pdfExport.ts's own top comment).
 * Lives here, not in pdfExport.ts, so the options dialog can call it
 * (suggestedQrSize) without loading pdf-lib.
 * Real exploded-view/hand-placed hotspots don't line up this precisely by
 * coincidence. Requires at least a 2×2 grid and a handful of hotspots —
 * a genuine diagram can easily have 2-3 hotspots that happen to share an
 * x or y coordinate without being a grid at all.
 *
 * Returns the inferred cell size in the image's own pixel space (same
 * units as CatalogLink.top/left), or null if this doesn't look like one.
 */
export function detectGrid(links: CatalogLink[]): { cellW: number; cellH: number } | null {
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

/**
 * The QR size the "Export PDF…" dialog starts on: "large" when the catalog has a
 * composited tile grid (a printed test found a phone jumping between the small codes
 * of neighbouring tiles), otherwise the default "small".
 */
export function suggestedQrSize(db: Database): QrSize {
  const hasGrid = listImages(db).some((image) =>
    detectGrid(listLinksForImage(db, image.id).filter((l) => !isNavLink(l))),
  );
  return hasGrid ? "large" : DEFAULT_PDF_EXPORT_OPTIONS.qrSize;
}

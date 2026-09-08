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

/** Where a diagram's QR codes render. Default "table" — set by the user after live-testing found the on-image codes, however small, still visually competed with a crowded diagram's own artwork; the table column reads cleanly regardless of how busy the image is. */
export type QrPlacement = "image" | "table" | "both";

/** Shrink a diagram to fit one A4 page (default, existing behavior), or print it at its real on-screen size — same pixel-to-point mapping as this app's own 100% zoom — split across as many A4 sheets as that takes, for a diagram too detailed to read once shrunk to one page. */
export type DiagramPageMode = "fit" | "real-size";

export interface PdfExportOptions {
  qrPlacement: QrPlacement;
  diagramPageMode: DiagramPageMode;
}

export const DEFAULT_PDF_EXPORT_OPTIONS: PdfExportOptions = {
  qrPlacement: "table",
  diagramPageMode: "fit",
};

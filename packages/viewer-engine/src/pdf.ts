import type { Database } from "sql.js";
import type { PdfExportOptions } from "../../shared/src/pdfExportOptions.js";

/** Where the PDF font comes from: a URL to fetch (e.g. the packaged fonts/DejaVuSans.ttf), the bytes, or a function that supplies them. */
export type PdfFontSource = string | URL | Uint8Array | (() => Promise<Uint8Array>);

async function loadFont(source: PdfFontSource): Promise<Uint8Array> {
  if (source instanceof Uint8Array) return source;
  if (typeof source === "function") return source();
  const res = await fetch(source);
  if (!res.ok) throw new Error(`PDF font: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * The `exportPdf` option of `mountViewer`: turns on the toolbar's "Export
 * PDF…" and the controller's `exportPdf()`. Nothing PDF-related is loaded
 * until the first export — the writer is a separate chunk of this package and
 * the font is fetched then, once. A failed attempt is retried afresh.
 */
export function createPdfExporter(font: PdfFontSource): (db: Database, options: PdfExportOptions) => Promise<Uint8Array> {
  let fontBytes: Promise<Uint8Array> | null = null;
  return async (db, options) => {
    fontBytes ??= loadFont(font);
    try {
      const [{ exportCatalogPdf }, bytes] = await Promise.all([import("../../shared/src/pdfExport.js"), fontBytes]);
      return await exportCatalogPdf(db, bytes, options);
    } catch (err) {
      fontBytes = null;
      throw err;
    }
  };
}

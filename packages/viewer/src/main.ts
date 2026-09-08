import "./style.css";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import pdfFontUrl from "@ecm/shared/assets/fonts/DejaVuSans.ttf?url";
import { mountViewer, setUpPwa, type Database } from "@ecm/shared";

// Service Worker registration + the standalone-aware GoatCounter gate —
// see packages/shared/src/pwa.ts.
setUpPwa();

// The standalone full-page app: renders into the page's own #app div (light
// DOM, no shadow root — `root` defaults to `document`), full toolbar, reads
// its initial catalog from `?src=` and keeps the address bar in sync with
// whatever gets opened afterwards. See packages/shared/src/viewerEngine.ts
// for the actual behavior — this file is just how the standalone page wires
// it up; packages/viewer-embed wires the same engine up as a Web Component.
const params = new URLSearchParams(location.search);
// The rest of a deep link (see the OneDrive backlog's QR-viewer item and
// mountViewer's own doc) — which image/hotspot to jump straight to once
// `src` has loaded, so a shared link/QR reproduces exactly what the
// sharer was looking at, not just the catalog's cover.
const initialImageId = params.has("image") ? Number(params.get("image")) : undefined;
const initialLinkId = params.has("link") ? Number(params.get("link")) : undefined;

// The font bytes are only ever needed once someone actually clicks
// "Export PDF…" — fetched lazily and cached, same reasoning as the dynamic
// import() below. mountViewer's own `exportPdf` option doc explains why
// this (pdfExport.ts + pdf-lib + @pdf-lib/fontkit) is resolved here rather
// than inside viewerEngine.ts itself.
let pdfFontBytesPromise: Promise<Uint8Array> | null = null;

async function exportPdf(db: Database): Promise<Uint8Array> {
  if (!pdfFontBytesPromise) {
    pdfFontBytesPromise = fetch(pdfFontUrl)
      .then((r) => r.arrayBuffer())
      .then((buf) => new Uint8Array(buf));
  }
  try {
    const [{ exportCatalogPdf }, fontBytes] = await Promise.all([import("../../shared/src/pdfExport.js"), pdfFontBytesPromise]);
    return await exportCatalogPdf(db, fontBytes);
  } catch (err) {
    pdfFontBytesPromise = null; // let a retry re-fetch, in case the failure was a network blip fetching the font
    throw err;
  }
}

mountViewer({
  container: document.getElementById("app")!,
  mode: "full",
  initialSrc: params.get("src") ?? undefined,
  initialImageId: Number.isFinite(initialImageId) ? initialImageId : undefined,
  initialLinkId: Number.isFinite(initialLinkId) ? initialLinkId : undefined,
  updateAddressBar: true,
  wasmUrl,
  exportPdf,
});

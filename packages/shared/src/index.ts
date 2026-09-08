export * from "./types.js";
export * from "./schema.js";
export * from "./db.js";
export * from "./theme.js";
export * from "./search.js";
export * from "./images.js";
export * from "./legacySch.js";
export * from "./qrcode.js";
export * from "./cart.js";
export * from "./pdfExportOptions.js";
// pdfExport.ts (and its pdf-lib/@pdf-lib/fontkit dependencies, well over a
// MB combined) is deliberately NOT re-exported here — every consumer of
// this barrel (editor/viewer/viewer-embed's main bundle) statically
// imports from "@ecm/shared", so a static re-export here would pull pdf-lib
// into everyone's main bundle regardless of whether they ever export a
// PDF. Reach it via a dynamic `import("./pdfExport.js")` (or, cross-package,
// a relative dynamic import straight at the file) at the point of use
// instead — see viewerEngine.ts's actionExportPdf and packages/editor/src/
// main.ts's actionExportPdf, both of which do exactly that.
export * from "./collabClient.js";
export * from "./viewerEngine.js";
export * from "./pwa.js";
// Re-exported so consumers (editor/viewer) don't need their own @types/sql.js.
export type { Database, SqlJsStatic } from "sql.js";

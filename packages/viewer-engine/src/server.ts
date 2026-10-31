// The part of the engine for a server: read a catalog without a screen, to
// index it, preview it and send a reader to the right picture and hotspot.
// No DOM, no canvas — runs in Bun and in Node. (src/index.ts is the browser side.)
export { catalogName, extractCover, extractSearchChunks, indexCatalog, openCatalog, searchCatalog } from "../../shared/src/catalogIndex.js";
export type { CatalogCover, CatalogDigest, OpenCatalogOptions, SearchChunk, SearchHit, WasmSource } from "../../shared/src/catalogIndex.js";
export { ProtectedCatalogError } from "../../shared/src/protect.js";
export type { ProtectedCatalogErrorCode } from "../../shared/src/protect.js";
export type { SearchField } from "../../shared/src/search.js";
export type { Database } from "sql.js";

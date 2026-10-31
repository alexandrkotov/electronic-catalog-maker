/**
 * Reading a catalog without a screen: what a server needs to index it for
 * full-text search, preview it, and send a reader to the right picture and
 * hotspot. No DOM, no canvas — it runs in Bun and in Node (everything here is
 * sql.js plus plain data), unlike the viewer engine.
 *
 * Search hits and chunks carry `imageId` and, where a hotspot is known,
 * `linkId`: the very ids of an `EcatmView`, so a hit opens the catalog right
 * there with `setView({ v: 1, imageId, linkId })`.
 */
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import { openCatalog as openCatalogWithSql, readMeta } from "./db.js";
import { catalogLinkTarget, isNavLink } from "./navLink.js";
import { ProtectedCatalogError, isProtectedCatalog, readProtectedInfo, unlockCatalog, type ProtectedCatalogCover } from "./protect.js";
import { searchRows, type SearchField } from "./search.js";
import type { CatalogRow } from "./types.js";

/**
 * Where sql.js finds its WASM. Bytes (a binary that embeds the file), a path or
 * URL, or sql.js's own `locateFile`. Left out, sql.js looks next to its own
 * files — which works from node_modules but not from a compiled single binary.
 * Only the first call's choice counts: the runtime is loaded once per process.
 */
export type WasmSource = Uint8Array | ArrayBuffer | string | ((file: string) => string);

export interface OpenCatalogOptions {
  wasm?: WasmSource;
  /** The password of a protected catalog. */
  key?: string;
}

let sqlPromise: Promise<SqlJsStatic> | null = null;

function loadSql(wasm?: WasmSource): Promise<SqlJsStatic> {
  if (!sqlPromise) {
    const config =
      wasm === undefined
        ? {}
        : wasm instanceof Uint8Array || wasm instanceof ArrayBuffer
          ? { wasmBinary: wasm as ArrayBuffer }
          : { locateFile: typeof wasm === "function" ? wasm : () => wasm };
    sqlPromise = initSqlJs(config).catch((err) => {
      sqlPromise = null; // a wrong path must not poison the next attempt
      throw err;
    });
  }
  return sqlPromise;
}

/**
 * Opens a catalog's bytes (`.ecatm`, as written by the editor). A protected
 * catalog needs `key`: without one this throws a `ProtectedCatalogError` with
 * code "locked", with a wrong one "wrong-password". Close the result with
 * `db.close()` when done.
 */
export async function openCatalog(bytes: Uint8Array, opts: OpenCatalogOptions = {}): Promise<Database> {
  const SQL = await loadSql(opts.wasm);
  if (isProtectedCatalog(bytes)) {
    if (opts.key === undefined) throw new ProtectedCatalogError("locked", "This catalog is password-protected and needs its key.");
    return openCatalogWithSql(SQL, await unlockCatalog(bytes, opts.key));
  }
  return openCatalogWithSql(SQL, bytes);
}

export interface CatalogCover {
  mime: string;
  bytes: Uint8Array;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * The catalog's first picture, as it is stored (the original bytes — scale it
 * for a thumbnail on your side), or null for a catalog without pictures.
 */
export function extractCover(db: Database): CatalogCover | null {
  const stmt = db.prepare("SELECT mime_type, image_data FROM images ORDER BY sort_order, id LIMIT 1");
  try {
    if (!stmt.step()) return null;
    const row = stmt.getAsObject();
    const data = String(row.image_data ?? "");
    return data ? { mime: String(row.mime_type), bytes: base64ToBytes(data) } : null;
  } finally {
    stmt.free();
  }
}

export interface SearchChunk {
  imageId: number;
  /** The hotspot to select, for a chunk about one item; absent for a chunk about a whole picture. */
  linkId?: number;
  text: string;
}

/** The catalog's name, as its author typed it. */
export function catalogName(db: Database): string {
  return readMeta(db).catalogName;
}

/** First hotspot (by id) of each item on each picture — the one a search hit selects. A navigation marker is not an item's hotspot. */
function firstLinkIds(db: Database): Map<string, number> {
  const out = new Map<string, number>();
  const stmt = db.prepare("SELECT id, image_id, url FROM links ORDER BY id");
  while (stmt.step()) {
    const r = stmt.getAsObject();
    const url = String(r.url);
    if (isNavLink({ url }) || catalogLinkTarget(url) !== null) continue;
    const key = `${Number(r.image_id)}\n${url}`;
    if (!out.has(key)) out.set(key, Number(r.id));
  }
  stmt.free();
  return out;
}

function rowText(row: CatalogRow): string {
  return [row.name, row.sku, row.description, ...Object.entries(row.extra).map(([key, value]) => `${key}: ${value}`)].filter((s) => s.trim() !== "").join("\n");
}

function allRows(db: Database): CatalogRow[] {
  const stmt = db.prepare("SELECT id, image_id, url, name, sku, description, extra FROM rows ORDER BY id");
  const out: CatalogRow[] = [];
  while (stmt.step()) {
    const r = stmt.getAsObject();
    let extra: Record<string, string> = {};
    try {
      extra = JSON.parse(String(r.extra ?? "{}"));
    } catch {
      extra = {};
    }
    out.push({ id: Number(r.id), imageId: Number(r.image_id), url: String(r.url), name: String(r.name), sku: String(r.sku), description: String(r.description), extra });
  }
  stmt.free();
  return out;
}

/**
 * The text of a catalog cut into pieces for a full-text index: one per
 * picture (its name and folder), one per item (name, sku, description and the
 * extra characteristics, with the hotspot to open). A quiz gets only the
 * picture pieces: its items are answer options, and its viewer has no search
 * for the same reason — an index must not hand out the answers.
 */
export function extractSearchChunks(db: Database): SearchChunk[] {
  const chunks: SearchChunk[] = [];
  const images = db.prepare("SELECT id, name, folder FROM images ORDER BY sort_order, id");
  while (images.step()) {
    const r = images.getAsObject();
    const text = [String(r.folder ?? ""), String(r.name)].filter((s) => s.trim() !== "").join(" / ");
    if (text) chunks.push({ imageId: Number(r.id), text });
  }
  images.free();
  if (readMeta(db).catalogMode === "quiz") return chunks;

  const links = firstLinkIds(db);
  for (const row of allRows(db)) {
    const text = rowText(row);
    if (!text) continue;
    const linkId = links.get(`${row.imageId}\n${row.url}`);
    chunks.push(linkId === undefined ? { imageId: row.imageId, text } : { imageId: row.imageId, linkId, text });
  }
  return chunks;
}

export interface SearchHit {
  imageId: number;
  linkId?: number;
  rowName: string;
  /** The piece of text the query was found in, a few words around it. */
  snippet: string;
}

const SNIPPET_SPAN = 60;

function snippetAround(text: string, query: string): string {
  const at = text.toLowerCase().indexOf(query);
  if (at < 0) return text.slice(0, SNIPPET_SPAN * 2);
  const from = Math.max(0, at - SNIPPET_SPAN);
  const to = Math.min(text.length, at + query.length + SNIPPET_SPAN);
  return `${from > 0 ? "…" : ""}${text.slice(from, to)}${to < text.length ? "…" : ""}`.replace(/\s+/g, " ");
}

/** The field values of a row a search looks in, for the snippet, in the order the search tries them. */
function searchedTexts(row: CatalogRow, field: SearchField): string[] {
  if (field === "name") return [row.name];
  if (field === "sku") return [row.sku];
  if (field === "description") return [row.description];
  if (field.startsWith("extra:")) return [String(row.extra[field.slice("extra:".length)] ?? "")];
  return [row.name, row.sku, row.description, ...Object.entries(row.extra).map(([key, value]) => `${key}: ${value}`)];
}

/**
 * The catalog's own search — the same matching as the viewer's Search box
 * (case-insensitive substring over name, sku, description and extras, or one
 * field), but each hit says where to go: the picture and the hotspot. Empty
 * query, no hits. A quiz has no search, so no hits.
 */
export function searchCatalog(db: Database, query: string, field: SearchField = "all"): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q || readMeta(db).catalogMode === "quiz") return [];
  const links = firstLinkIds(db);
  return searchRows(allRows(db), query, field).map((row) => {
    const linkId = links.get(`${row.imageId}\n${row.url}`);
    const text = searchedTexts(row, field).find((t) => t.toLowerCase().includes(q)) ?? row.name;
    return { imageId: row.imageId, ...(linkId === undefined ? {} : { linkId }), rowName: row.name, snippet: snippetAround(text, q) };
  });
}

export interface CatalogDigest {
  name: string;
  /** The file is password-protected. */
  protected: boolean;
  /** Protected, and no (or a wrong) key was given: only `name` and `cover` are the public ones, `chunks` is empty. */
  locked: boolean;
  cover: CatalogCover | ProtectedCatalogCover | null;
  chunks: SearchChunk[];
}

/**
 * Everything an indexer wants from one file, in one call that does not throw
 * for a protected catalog: with its key the whole catalog is read; without it
 * (or with a wrong one) only what the author made public — the name and the
 * cover that sit unencrypted in the file's header.
 */
export async function indexCatalog(bytes: Uint8Array, opts: OpenCatalogOptions = {}): Promise<CatalogDigest> {
  if (!isProtectedCatalog(bytes)) {
    const db = await openCatalog(bytes, opts);
    try {
      return { name: catalogName(db), protected: false, locked: false, cover: extractCover(db), chunks: extractSearchChunks(db) };
    } finally {
      db.close();
    }
  }
  if (opts.key !== undefined) {
    try {
      const db = await openCatalog(bytes, opts);
      try {
        return { name: catalogName(db), protected: true, locked: false, cover: extractCover(db), chunks: extractSearchChunks(db) };
      } finally {
        db.close();
      }
    } catch (err) {
      if (!(err instanceof ProtectedCatalogError) || err.code !== "wrong-password") throw err;
    }
  }
  const info = readProtectedInfo(bytes);
  return { name: info.name, protected: true, locked: true, cover: info.cover, chunks: [] };
}

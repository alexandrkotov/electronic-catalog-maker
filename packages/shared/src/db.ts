import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import { CATALOG_SCHEMA_META_DEFAULTS, CATALOG_SCHEMA_SQL } from "./schema.js";
import type { CatalogImage, CatalogLink, CatalogMeta, CatalogRow } from "./types.js";
import { UniquenessError } from "./types.js";

let sqlJsPromise: Promise<SqlJsStatic> | null = null;

/**
 * Loads the sql.js WASM runtime exactly once per page.
 * Callers must pass `locateFile` (or a plain wasm URL) so the .wasm asset resolves
 * correctly under their bundler — e.g. in Vite:
 *   import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
 *   await initSqlite(wasmUrl);
 */
export function initSqlite(wasmUrlOrLocateFile: string | ((file: string) => string)): Promise<SqlJsStatic> {
  if (!sqlJsPromise) {
    const locateFile =
      typeof wasmUrlOrLocateFile === "function" ? wasmUrlOrLocateFile : () => wasmUrlOrLocateFile;
    sqlJsPromise = initSqlJs({ locateFile });
  }
  return sqlJsPromise;
}

/** Creates a brand-new, empty catalog database with the schema applied. */
export function createEmptyCatalog(SQL: SqlJsStatic, catalogName = "Untitled catalog"): Database {
  const db = new SQL.Database();
  db.run(CATALOG_SCHEMA_SQL);
  const meta = { ...CATALOG_SCHEMA_META_DEFAULTS, catalog_name: catalogName, created_at: new Date().toISOString() };
  const stmt = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
  for (const [key, value] of Object.entries(meta)) {
    stmt.run([key, value]);
  }
  stmt.free();
  return db;
}

/** Opens an existing catalog file (bytes from disk/fetch). */
export function openCatalog(SQL: SqlJsStatic, bytes: Uint8Array): Database {
  return new SQL.Database(bytes);
}

/** Serializes the catalog back to bytes, ready to download or fetch elsewhere. */
export function exportCatalog(db: Database): Uint8Array {
  return db.export();
}

export function readMeta(db: Database): CatalogMeta {
  const rows = db.exec("SELECT key, value FROM meta");
  const kv = new Map<string, string>();
  if (rows[0]) {
    for (const [key, value] of rows[0].values) {
      kv.set(String(key), String(value));
    }
  }
  return {
    schemaVersion: Number(kv.get("schema_version") ?? 1),
    catalogName: kv.get("catalog_name") ?? "Untitled catalog",
    createdBy: kv.get("created_by") ?? "",
    createdAt: kv.get("created_at") ?? "",
  };
}

export function listImages(db: Database): CatalogImage[] {
  const stmt = db.prepare(
    "SELECT id, name, mime_type, image_data, width, height, sort_order FROM images ORDER BY sort_order, id",
  );
  const out: CatalogImage[] = [];
  while (stmt.step()) {
    const r = stmt.getAsObject();
    out.push({
      id: Number(r.id),
      name: String(r.name),
      mimeType: String(r.mime_type),
      imageData: String(r.image_data),
      width: Number(r.width),
      height: Number(r.height),
      sortOrder: Number(r.sort_order),
    });
  }
  stmt.free();
  return out;
}

export function listLinksForImage(db: Database, imageId: number): CatalogLink[] {
  const stmt = db.prepare(
    "SELECT id, image_id, name, url, top, left, font_size FROM links WHERE image_id = ? ORDER BY id",
  );
  stmt.bind([imageId]);
  const out: CatalogLink[] = [];
  while (stmt.step()) {
    const r = stmt.getAsObject();
    out.push({
      id: Number(r.id),
      imageId: Number(r.image_id),
      name: String(r.name),
      url: String(r.url),
      top: Number(r.top),
      left: Number(r.left),
      fontSize: Number(r.font_size),
    });
  }
  stmt.free();
  return out;
}

export function listRowsForImage(db: Database, imageId: number): CatalogRow[] {
  const stmt = db.prepare(
    "SELECT id, image_id, url, name, sku, description, extra FROM rows WHERE image_id = ? ORDER BY id",
  );
  stmt.bind([imageId]);
  const out: CatalogRow[] = [];
  while (stmt.step()) {
    out.push(rowFromRecord(stmt.getAsObject()));
  }
  stmt.free();
  return out;
}

export function findRowByUrl(db: Database, url: string): CatalogRow | null {
  const stmt = db.prepare("SELECT id, image_id, url, name, sku, description, extra FROM rows WHERE url = ?");
  stmt.bind([url]);
  const row = stmt.step() ? rowFromRecord(stmt.getAsObject()) : null;
  stmt.free();
  return row;
}

function rowFromRecord(r: Record<string, unknown>): CatalogRow {
  let extra: Record<string, string> = {};
  try {
    extra = JSON.parse(String(r.extra ?? "{}"));
  } catch {
    extra = {};
  }
  return {
    id: Number(r.id),
    imageId: Number(r.image_id),
    url: String(r.url),
    name: String(r.name),
    sku: String(r.sku),
    description: String(r.description),
    extra,
  };
}

/** Throws UniquenessError if `name` or `url` is already used by another link in the catalog. */
export function assertLinkIsUnique(db: Database, name: string, url: string, excludeLinkId?: number): void {
  const nameStmt = db.prepare("SELECT id FROM links WHERE name = ? AND id != ?");
  nameStmt.bind([name, excludeLinkId ?? -1]);
  const nameTaken = nameStmt.step();
  nameStmt.free();
  if (nameTaken) throw new UniquenessError("name", name);

  const urlStmt = db.prepare("SELECT id FROM links WHERE url = ? AND id != ?");
  urlStmt.bind([url, excludeLinkId ?? -1]);
  const urlTaken = urlStmt.step();
  urlStmt.free();
  if (urlTaken) throw new UniquenessError("url", url);
}

export interface AddImageInput {
  name: string;
  mimeType: string;
  imageData: string;
  width: number;
  height: number;
  sortOrder?: number;
}

export function addImage(db: Database, input: AddImageInput): number {
  const stmt = db.prepare(
    "INSERT INTO images (name, mime_type, image_data, width, height, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
  );
  stmt.run([input.name, input.mimeType, input.imageData, input.width, input.height, input.sortOrder ?? 0]);
  stmt.free();
  return lastInsertRowId(db);
}

export interface AddLinkInput {
  imageId: number;
  name: string;
  url: string;
  top: number;
  left: number;
  fontSize?: number;
}

/** Inserts a hotspot link. Throws UniquenessError if name/url already exist elsewhere. */
export function addLink(db: Database, input: AddLinkInput): number {
  assertLinkIsUnique(db, input.name, input.url);
  const stmt = db.prepare(
    "INSERT INTO links (image_id, name, url, top, left, font_size) VALUES (?, ?, ?, ?, ?, ?)",
  );
  stmt.run([input.imageId, input.name, input.url, input.top, input.left, input.fontSize ?? 12]);
  stmt.free();
  return lastInsertRowId(db);
}

export interface AddRowInput {
  imageId: number;
  url: string;
  name?: string;
  sku?: string;
  description?: string;
  extra?: Record<string, string>;
}

/** Inserts a data row. `url` should match an existing link's url on the same image. */
export function addRow(db: Database, input: AddRowInput): number {
  const stmt = db.prepare(
    "INSERT INTO rows (image_id, url, name, sku, description, extra) VALUES (?, ?, ?, ?, ?, ?)",
  );
  stmt.run([
    input.imageId,
    input.url,
    input.name ?? "",
    input.sku ?? "",
    input.description ?? "",
    JSON.stringify(input.extra ?? {}),
  ]);
  stmt.free();
  return lastInsertRowId(db);
}

function lastInsertRowId(db: Database): number {
  const res = db.exec("SELECT last_insert_rowid() AS id");
  return Number(res[0]?.values[0]?.[0] ?? -1);
}

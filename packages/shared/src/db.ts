import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import {
  CATALOG_SCHEMA_META_DEFAULTS,
  CATALOG_SCHEMA_SQL,
  DEFAULT_CART_CHECKOUT_BASE_URL,
  DEFAULT_CART_ID_PATTERN,
  DEFAULT_CART_ITEM_PARAM,
} from "./schema.js";
import type { CatalogImage, CatalogLink, CatalogMeta, CatalogRow, LinkConflict } from "./types.js";

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
  const db = new SQL.Database(bytes);
  migrateLegacySchema(db);
  return db;
}

/**
 * A catalog's schema is baked into the file at CREATE TABLE time — reopening
 * an old file does NOT pick up schema changes made in newer code. Each
 * migration below is independent and self-guarded (checks whether it's
 * already applied before doing anything), so opening a file from any past
 * version of the schema brings it up to date in one pass.
 */
function migrateLegacySchema(db: Database): void {
  migrateLinksUniqueConstraint(db);
  migrateImagesFolderColumn(db);
}

/**
 * Catalogs created before hotspots were allowed to share a url/name (see
 * schema.ts) still have `UNIQUE` on links.name/links.url, so adding a
 * legitimate duplicate (the same part drawn again) throws a raw SQLite
 * constraint error instead of the friendly in-app warning. Detect and
 * rebuild the table without those constraints, preserving every row's data
 * and id.
 */
function migrateLinksUniqueConstraint(db: Database): void {
  const ddlRows = db.exec("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'links'");
  const ddl = ddlRows[0]?.values[0]?.[0];
  if (typeof ddl !== "string" || !/UNIQUE/i.test(ddl)) return; // already on the current schema

  db.run(`
    ALTER TABLE links RENAME TO links_pre_migration;
    CREATE TABLE links (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      image_id  INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
      name      TEXT NOT NULL,
      url       TEXT NOT NULL,
      top       REAL NOT NULL,
      left      REAL NOT NULL,
      font_size INTEGER NOT NULL DEFAULT 12
    );
    INSERT INTO links (id, image_id, name, url, top, left, font_size)
      SELECT id, image_id, name, url, top, left, font_size FROM links_pre_migration;
    DROP TABLE links_pre_migration;
    CREATE INDEX IF NOT EXISTS idx_links_image_id ON links(image_id);
    CREATE INDEX IF NOT EXISTS idx_links_url ON links(url);
  `);
}

/** Catalogs created before folder grouping existed are missing `images.folder` entirely. */
function migrateImagesFolderColumn(db: Database): void {
  const ddlRows = db.exec("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'images'");
  const ddl = ddlRows[0]?.values[0]?.[0];
  if (typeof ddl === "string" && /\bfolder\b/i.test(ddl)) return; // already on the current schema
  db.run("ALTER TABLE images ADD COLUMN folder TEXT NOT NULL DEFAULT ''");
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
    // Both keys are simply absent in a catalog saved before this setting
    // existed — no ALTER TABLE migration needed, `meta` is already a plain
    // key/value table, so a missing key just falls back to the default here.
    storeUrl: kv.get("store_url") ?? "",
    cartMode: kv.get("cart_mode") === "instant" ? "instant" : "accumulate",
    cartIdPattern: kv.get("cart_id_pattern") ?? DEFAULT_CART_ID_PATTERN,
    cartItemParam: kv.get("cart_item_param") ?? DEFAULT_CART_ITEM_PARAM,
    cartCheckoutBaseUrl: kv.get("cart_checkout_base_url") ?? DEFAULT_CART_CHECKOUT_BASE_URL,
  };
}

export interface StoreSettingsInput {
  storeUrl: string;
  cartMode: "accumulate" | "instant";
  cartIdPattern: string;
  cartItemParam: string;
  cartCheckoutBaseUrl: string;
}

/** Writes the editor's "Store settings" modal fields into the meta table. */
export function updateStoreSettings(db: Database, input: StoreSettingsInput): void {
  const stmt = db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  stmt.run(["store_url", input.storeUrl]);
  stmt.run(["cart_mode", input.cartMode]);
  stmt.run(["cart_id_pattern", input.cartIdPattern]);
  stmt.run(["cart_item_param", input.cartItemParam]);
  stmt.run(["cart_checkout_base_url", input.cartCheckoutBaseUrl]);
  stmt.free();
}

export function listImages(db: Database): CatalogImage[] {
  const stmt = db.prepare(
    "SELECT id, name, mime_type, image_data, width, height, sort_order, folder FROM images ORDER BY sort_order, id",
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
      folder: String(r.folder ?? ""),
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

/** Every row in the catalog, across all images — for catalog-wide search. */
export function listAllRows(db: Database): CatalogRow[] {
  const stmt = db.prepare("SELECT id, image_id, url, name, sku, description, extra FROM rows ORDER BY id");
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

/**
 * Non-fatal check: does `name` or `url` already belong to a *different* hotspot
 * anywhere in the catalog? Returns the conflicts found (0, 1, or 2) instead of
 * throwing — a repeated name/url is legitimate (the same part drawn at several
 * positions), so callers surface this as a confirmable warning, not a hard block.
 */
export function findLinkConflicts(
  db: Database,
  name: string,
  url: string,
  excludeLinkId?: number,
): LinkConflict[] {
  const conflicts: LinkConflict[] = [];

  const nameStmt = db.prepare("SELECT id FROM links WHERE name = ? AND id != ?");
  nameStmt.bind([name, excludeLinkId ?? -1]);
  if (nameStmt.step()) conflicts.push({ field: "name", value: name, conflictingLinkId: Number(nameStmt.getAsObject().id) });
  nameStmt.free();

  const urlStmt = db.prepare("SELECT id FROM links WHERE url = ? AND id != ?");
  urlStmt.bind([url, excludeLinkId ?? -1]);
  if (urlStmt.step()) conflicts.push({ field: "url", value: url, conflictingLinkId: Number(urlStmt.getAsObject().id) });
  urlStmt.free();

  return conflicts;
}

export interface AddImageInput {
  name: string;
  mimeType: string;
  imageData: string;
  width: number;
  height: number;
  sortOrder?: number;
  folder?: string;
}

export function addImage(db: Database, input: AddImageInput): number {
  const stmt = db.prepare(
    "INSERT INTO images (name, mime_type, image_data, width, height, sort_order, folder) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  stmt.run([
    input.name,
    input.mimeType,
    input.imageData,
    input.width,
    input.height,
    input.sortOrder ?? 0,
    input.folder ?? "",
  ]);
  stmt.free();
  return lastInsertRowId(db);
}

export interface UpdateImageInput {
  name: string;
  /** "" clears the folder (the image becomes ungrouped). */
  folder: string;
}

/** Renames an image and/or moves it into a different (or no) folder. */
export function updateImage(db: Database, imageId: number, input: UpdateImageInput): void {
  const stmt = db.prepare("UPDATE images SET name = ?, folder = ? WHERE id = ?");
  stmt.run([input.name, input.folder, imageId]);
  stmt.free();
}

/**
 * Deletes an image along with every hotspot and data row that lives on it.
 * The schema declares ON DELETE CASCADE for both, but sql.js doesn't
 * enforce foreign keys itself (same reason deleteLink() below does its own
 * cascade), so this does it by hand. A row deleted this way may still be
 * referenced by a hotspot on a *different* image (the many-to-one design —
 * see schema.ts) — that hotspot is left in place, just unassigned from any
 * data, the same outcome deleteRow() already produces on its own.
 */
export function deleteImage(db: Database, imageId: number): void {
  db.run("DELETE FROM rows WHERE image_id = ?", [imageId]);
  db.run("DELETE FROM links WHERE image_id = ?", [imageId]);
  db.run("DELETE FROM images WHERE id = ?", [imageId]);
}

export interface AddLinkInput {
  imageId: number;
  name: string;
  url: string;
  top: number;
  left: number;
  fontSize?: number;
}

/**
 * Inserts a hotspot link. Does not enforce name/url uniqueness — call
 * findLinkConflicts() first if you want to warn the user before saving.
 */
export function addLink(db: Database, input: AddLinkInput): number {
  const stmt = db.prepare(
    "INSERT INTO links (image_id, name, url, top, left, font_size) VALUES (?, ?, ?, ?, ?, ?)",
  );
  stmt.run([input.imageId, input.name, input.url, input.top, input.left, input.fontSize ?? 12]);
  stmt.free();
  return lastInsertRowId(db);
}

export interface UpdateLinkInput {
  name: string;
  url: string;
}

/**
 * Renames a link and/or moves it to a new url. Does not enforce name/url
 * uniqueness — call findLinkConflicts() first if you want to warn the user
 * before saving. If the url actually changes, the matching data row (if any,
 * and if no *other* link still uses the old url) is repointed to the new url
 * too, so the image-row pairing never silently breaks.
 */
export function updateLink(db: Database, linkId: number, input: UpdateLinkInput): void {
  const sel = db.prepare("SELECT url FROM links WHERE id = ?");
  sel.bind([linkId]);
  const oldUrl = sel.step() ? String(sel.getAsObject().url) : null;
  sel.free();

  const stmt = db.prepare("UPDATE links SET name = ?, url = ? WHERE id = ?");
  stmt.run([input.name, input.url, linkId]);
  stmt.free();

  // Only follow the row over to the new url if this was the *last* hotspot
  // using the old one (siblings still need it where it is), and only if the
  // new url doesn't already have its own row (rows.url is unique — merging
  // two rows' data is out of scope here).
  if (oldUrl !== null && oldUrl !== input.url && !linkExistsForUrl(db, oldUrl) && !rowExistsForUrl(db, input.url)) {
    db.run("UPDATE rows SET url = ? WHERE url = ?", [input.url, oldUrl]);
  }
}

/**
 * Deletes a link. Its matching data row is deleted too, but only if no other
 * hotspot still shares that url (sql.js doesn't enforce the FK/cascade itself).
 */
export function deleteLink(db: Database, linkId: number): void {
  const sel = db.prepare("SELECT url FROM links WHERE id = ?");
  sel.bind([linkId]);
  const url = sel.step() ? String(sel.getAsObject().url) : null;
  sel.free();

  db.run("DELETE FROM links WHERE id = ?", [linkId]);

  if (url !== null && !linkExistsForUrl(db, url)) {
    db.run("DELETE FROM rows WHERE url = ?", [url]);
  }
}

function linkExistsForUrl(db: Database, url: string): boolean {
  const stmt = db.prepare("SELECT id FROM links WHERE url = ?");
  stmt.bind([url]);
  const exists = stmt.step();
  stmt.free();
  return exists;
}

/** True if a data row exists for this url — i.e. this url isn't just a bare, unassigned hotspot. */
export function rowExistsForUrl(db: Database, url: string): boolean {
  const stmt = db.prepare("SELECT id FROM rows WHERE url = ?");
  stmt.bind([url]);
  const exists = stmt.step();
  stmt.free();
  return exists;
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

export interface UpdateRowInput {
  name?: string;
  sku?: string;
  description?: string;
  extra?: Record<string, string>;
}

/**
 * Updates an existing data row's display fields (name/sku/description/extra).
 * Does not touch `url` — that's the join key against links and is only ever
 * repointed via updateLink() so the image-row pairing can't silently break.
 */
export function updateRow(db: Database, rowId: number, input: UpdateRowInput): void {
  const stmt = db.prepare("UPDATE rows SET name = ?, sku = ?, description = ?, extra = ? WHERE id = ?");
  stmt.run([
    input.name ?? "",
    input.sku ?? "",
    input.description ?? "",
    JSON.stringify(input.extra ?? {}),
    rowId,
  ]);
  stmt.free();
}

/**
 * Deletes a data row without touching its hotspot(s) — the link(s) sharing
 * its url stay on the image, just unassigned from any table data (the same
 * state a hotspot is in right after it's first created).
 */
export function deleteRow(db: Database, rowId: number): void {
  db.run("DELETE FROM rows WHERE id = ?", [rowId]);
}

/** Moves an existing hotspot to a new pixel position (e.g. after dragging it in the editor). */
export function updateLinkPosition(db: Database, linkId: number, top: number, left: number): void {
  const stmt = db.prepare("UPDATE links SET top = ?, left = ? WHERE id = ?");
  stmt.run([top, left, linkId]);
  stmt.free();
}

function lastInsertRowId(db: Database): number {
  const res = db.exec("SELECT last_insert_rowid() AS id");
  return Number(res[0]?.values[0]?.[0] ?? -1);
}

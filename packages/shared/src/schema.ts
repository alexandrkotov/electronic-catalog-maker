/**
 * SQLite schema for an Electronic Catalog Maker "semantic set" — a single .ecatm
 * file (a SQLite database under the hood) that is the entire catalog: images
 * with clickable hotspot links, and one data table of rows per image, joined
 * by `url`.
 *
 * Design notes (see project memory for the full rationale):
 * - One catalog file = many images, each image has many links (hotspots) and many rows.
 * - A hotspot's own identity is its `links.id` (always unique) — that's what a click
 *   centers the view on. Its `url` is just the join key to a `rows` entry, and is
 *   deliberately allowed to repeat: real legacy .sch catalogs routinely draw the same
 *   part at many positions on one exploded diagram (one part number, a dozen bolts),
 *   all sharing one row. `rows.url` itself stays unique — many hotspots, one row.
 * - `links.name`/`links.url` colliding with another hotspot elsewhere in the catalog is
 *   NOT blocked at the schema level — the editor warns and lets the user confirm, since
 *   the same name/url legitimately repeats for the "same part, another position" case.
 * - Per-row characteristics that vary by catalog/image (weight, material, ...) live in
 *   `rows.extra` as a JSON object rather than as dynamic columns, to keep the editor
 *   and viewer schema-agnostic.
 */

export const CATALOG_SCHEMA_VERSION = 1;

/**
 * File extension (no dot) used for catalog files — a SQLite database under the hood.
 * Deliberately not "ecat": that (and "xcat") collide with real medical-imaging PET
 * scan formats. Short extensions ending in "-cat" specifically are a landmine — CAT
 * scan terminology has claimed that suffix pattern.
 */
export const CATALOG_FILE_EXTENSION = "ecatm";

export const CATALOG_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS images (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  mime_type  TEXT NOT NULL DEFAULT 'image/jpeg',
  image_data TEXT NOT NULL, -- base64, no data: prefix
  width      INTEGER NOT NULL,
  height     INTEGER NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS links (
  id        INTEGER PRIMARY KEY AUTOINCREMENT, -- the hotspot's own unique identity
  image_id  INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  name      TEXT NOT NULL, -- not DB-unique; editor warns on collision instead of blocking
  url       TEXT NOT NULL, -- join key to a rows entry; multiple hotspots may share one
  top       REAL NOT NULL,
  left      REAL NOT NULL,
  font_size INTEGER NOT NULL DEFAULT 12
);

CREATE TABLE IF NOT EXISTS rows (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  image_id    INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  url         TEXT NOT NULL UNIQUE, -- one row per url; many links(url) may point at it
  name        TEXT NOT NULL DEFAULT '',
  sku         TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  extra       TEXT NOT NULL DEFAULT '{}' -- JSON object of free-form characteristics
);

CREATE INDEX IF NOT EXISTS idx_links_image_id ON links(image_id);
CREATE INDEX IF NOT EXISTS idx_links_url      ON links(url);
CREATE INDEX IF NOT EXISTS idx_rows_image_id  ON rows(image_id);
CREATE INDEX IF NOT EXISTS idx_rows_url       ON rows(url);
`;

export const CATALOG_SCHEMA_META_DEFAULTS: Record<string, string> = {
  schema_version: String(CATALOG_SCHEMA_VERSION),
  catalog_name: "Untitled catalog",
  created_by: "",
  created_at: "",
};

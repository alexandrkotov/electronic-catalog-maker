/**
 * SQLite schema for an Electronic Catalog Maker "semantic set" — a single .ecat
 * file (a SQLite database under the hood) that is the entire catalog: images
 * with clickable hotspot links, and one data table of rows per image, joined
 * by `url`.
 *
 * Design notes (see project memory for the full rationale):
 * - One catalog file = many images, each image has many links (hotspots) and many rows.
 * - `links.name` and `links.url` are unique across the WHOLE catalog, not just per image.
 * - `rows.url` matches a `links.url` to know which row to highlight on hotspot click.
 * - Per-row characteristics that vary by catalog/image (weight, material, ...) live in
 *   `rows.extra` as a JSON object rather than as dynamic columns, to keep the editor
 *   and viewer schema-agnostic.
 */

export const CATALOG_SCHEMA_VERSION = 1;

/** File extension (no dot) used for catalog files — a SQLite database under the hood. */
export const CATALOG_FILE_EXTENSION = "ecat";

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
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  image_id  INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  name      TEXT NOT NULL UNIQUE,
  url       TEXT NOT NULL UNIQUE,
  top       REAL NOT NULL,
  left      REAL NOT NULL,
  font_size INTEGER NOT NULL DEFAULT 12
);

CREATE TABLE IF NOT EXISTS rows (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  image_id    INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  url         TEXT NOT NULL UNIQUE REFERENCES links(url) ON DELETE CASCADE,
  name        TEXT NOT NULL DEFAULT '',
  sku         TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  extra       TEXT NOT NULL DEFAULT '{}' -- JSON object of free-form characteristics
);

CREATE INDEX IF NOT EXISTS idx_links_image_id ON links(image_id);
CREATE INDEX IF NOT EXISTS idx_rows_image_id  ON rows(image_id);
CREATE INDEX IF NOT EXISTS idx_rows_url       ON rows(url);
`;

export const CATALOG_SCHEMA_META_DEFAULTS: Record<string, string> = {
  schema_version: String(CATALOG_SCHEMA_VERSION),
  catalog_name: "Untitled catalog",
  created_by: "",
  created_at: "",
};

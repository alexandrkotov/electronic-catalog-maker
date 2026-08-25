# Electronic Catalog Maker

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-646CFF?logo=vite&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-003B57?logo=sqlite&logoColor=white)
![pnpm](https://img.shields.io/badge/pnpm-F69220?logo=pnpm&logoColor=white)
![No backend](https://img.shields.io/badge/backend-none-brightgreen)

Build and view interactive image-hotspot catalogs — a schematic picture with
clickable positions linked to a data table (name, SKU, characteristics) —
packaged as a single portable `.ecatm` file (a SQLite database under the hood). No backend, no install: open the
file in the viewer and it just works, the same way the whole lineage of tools
this project continues has worked for the last decade.

## Packages

- [`packages/shared`](packages/shared) — the catalog file format: SQLite schema,
  TypeScript types, and a thin [sql.js](https://github.com/sql-js/sql.js) (SQLite
  compiled to WASM) wrapper used by both apps below.
- [`packages/editor`](packages/editor) — web app to build a catalog: load an
  image, click to place hotspot links on it, and attach a data row to each link.
- [`packages/viewer`](packages/viewer) — web app to open a catalog file, browse
  its images, and click a hotspot to highlight the matching row in its table.

Both apps run entirely in the browser — SQLite is read/written client-side via
sql.js, so a catalog is just a file you can host anywhere static (or a local
disk file) and share.

## Catalog file format

One `.ecatm` file (a SQLite database under the hood) = one catalog ("semantic set"). Tables:

- `images` — one row per schematic picture (name, embedded image data, size)
- `links` — one row per clickable hotspot on an image (name, url, pixel
  position). **`name` and `url` are unique across the whole catalog**, not just
  per image.
- `rows` — one row of data per link, joined by `url`. Fixed columns (`name`,
  `sku`, `description`) plus a free-form `extra` JSON column for whatever
  characteristics a given catalog needs.

See [`packages/shared/src/schema.ts`](packages/shared/src/schema.ts) for the
exact DDL.

## Development

```bash
pnpm install
pnpm dev:editor   # http://localhost:5173
pnpm dev:viewer   # http://localhost:5174 (or next free port)
```

## Status

Early scaffold — functional end-to-end (create a catalog, place hotspots,
add rows, export/reopen the `.ecatm`, view + highlight-on-click), but UI and
feature parity with the legacy desktop tools (bulk link import, reverse
search, exploded-view pan/zoom, embeddable viewer as a Web Component) are not
built yet.

## License

MIT

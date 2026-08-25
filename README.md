# Electronic Catalog Maker

[![Author](https://img.shields.io/badge/Author-Alexander%20Kotov-181717?logo=github&logoColor=white)](https://github.com/alexandrkotov)
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

## Sharing a catalog via link

The viewer can load a catalog straight from a URL instead of a local file:
click **"Open remote catalog…"** and paste in a link to a `.ecatm` file, or
open the viewer directly at `https://your-viewer/?src=<url-to-a-.ecatm-file>`
(the dialog does this too — after a successful open it updates the address
bar to match, so the resulting page is itself a link you can pass along).
This needs no server of its own: host the viewer once as a static site, put
the `.ecatm` file wherever it's reachable by URL (a GitHub repo's raw
content, a public object storage bucket, etc.), and send people the link.

The one real requirement: the file's host must send a CORS header
(`Access-Control-Allow-Origin`) allowing the browser to fetch it from the
viewer's origin — `raw.githubusercontent.com` and most object storage
services (S3, R2, ...) do this by default, but some file-sharing hosts
(e.g. a plain Google Drive share link) do not, and the fetch will fail with
a CORS error rather than a clear "access denied" message.

The editor has the same idea under **"Copy remote catalog…"**, but with
different semantics: it fetches the file and opens it as an unattached
copy to start editing, not a live link back to that URL — the first Save
prompts for a location, same as it would for any catalog that didn't come
from a local file.

## Reverse search

Both apps have a **"Search…"** button that searches every row in the
catalog at once — not just the ones on the currently open image. Narrow it
to one field (Name, SKU, Description, or any key that shows up in some
row's free-form `extra` data) with the dropdown next to the search box.
Clicking a result jumps straight to the image it's on and centers the
matching hotspot; in the editor it also opens that hotspot for editing.

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

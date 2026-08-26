# Electronic Catalog Maker

[![Author](https://img.shields.io/badge/Author-Alexander%20Kotov-181717?logo=github&logoColor=white)](https://github.com/alexandrkotov)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-646CFF?logo=vite&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-003B57?logo=sqlite&logoColor=white)
![pnpm](https://img.shields.io/badge/pnpm-F69220?logo=pnpm&logoColor=white)
![No backend](https://img.shields.io/badge/backend-none-brightgreen)

Inspired by an earlier project of mine,
[auto-parts-universal-catalog](https://github.com/alexandrkotov/auto-parts-universal-catalog).

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

- `images` — one row per schematic picture (name, embedded image data, size,
  and an optional `folder` label for grouping in the image list)
- `links` — one row per clickable hotspot on an image (name, url, pixel
  position). Several hotspots may share the same `name`/`url` — that's how
  the same part gets drawn at multiple positions on one exploded diagram.
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

## Grouping images into folders

The image list on the left is two-level: images can be tagged with a
folder name to group them (e.g. separate manuals for "Wardrobe" and "Bed"
inside one catalog). In the editor, select an image and set its **Folder**
field (with autocomplete from folders already in use); leave it empty to
keep the image ungrouped. Ungrouped images always list first, folders
below them alphabetically. The viewer shows the same grouping read-only.

## Opening a legacy `.sch` catalog

Both apps can open a `.sch` file from the previous-generation desktop
software this project continues — same "Open catalog…"/"Open remote
catalog…" flow, detected automatically from the file's actual tables, not
its extension. It's converted in memory into a regular catalog (nothing is
ever written back to the `.sch` file itself), so everything else — search,
folders, themes, instance-nav — works on it exactly like a native `.ecatm`
catalog: each exploded-view diagram becomes an image (grouped into folders
by its original category), each part position becomes a hotspot labeled
with its original position number rather than its full name (the same
diagram can have 70+ hotspots — full names as labels bury the picture), and
parts with several superseding/alternate part numbers for one position keep
the extra ones in that row's `extra.alternates` field rather than losing
them.

The viewer opens it read-only, same as any catalog. The editor opens it as
an editable, unattached copy — the same "it's a copy, not opened in place"
behavior as "Copy remote catalog…" (see above): Save prompts for a location
the first time, and nothing is ever written back into the original `.sch`
file, even if the browser handed the editor a writable handle to it.

Two known limits, found from real fixture files: a diagram whose hotspot
positions reference an *external* image URL instead of one embedded in the
file is skipped (the conversion status reports how many) — the coordinate
system that positions its hotspots isn't guaranteed to match any image we
could fetch separately, and some real catalogs do use external URLs. Very
large files (tens of thousands of diagrams) take proportionally longer to
convert — a few seconds per thousand diagrams in testing — since it's all
done in the browser with no server to offload to.

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

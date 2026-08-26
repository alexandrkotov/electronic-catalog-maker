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
packaged as a single portable `.ecatm` file (a SQLite database under the
hood, read and written entirely in the browser via
[sql.js](https://github.com/sql-js/sql.js)). One file format, three ways to
use it: the **editor** builds a catalog, the **viewer** opens one as its
own full-page app, and `<ecm-viewer>` embeds that same viewer into any
other page — even a plain static HTML file with no build step of its own
(see "Embedding the viewer" below).

## Getting started

Both apps are fully client-side — no server, no database, no accounts —
but running them locally still needs two ordinary developer tools
installed once (there's no hosted version or downloadable installer yet,
see "Status" below):

- [Node.js](https://nodejs.org/) 18 or later
- [pnpm](https://pnpm.io/installation)

Then, from a terminal:

```bash
git clone https://github.com/alexandrkotov/electronic-catalog-maker.git
cd electronic-catalog-maker
pnpm install
pnpm dev:editor   # http://localhost:5173
pnpm dev:viewer   # http://localhost:5174 — run in a second terminal
```

(There's a third one, `pnpm dev:embed`, for developing the embeddable
`<ecm-viewer>` component — see "Embedding the viewer" below; most people
just want the two above.)

That's genuinely everything: no `.env` file, no database to point at,
nothing else to configure. Each command starts a local dev server and
prints its URL; leave it running and open that URL in a browser. A
catalog file lives entirely on your own disk — nothing is ever uploaded
anywhere unless you explicitly load one from a URL (see "Sharing a
catalog via link" below).

## Using the editor

1. Click **New catalog** and give it a name.
2. Click **Add image…** and pick a picture — a schematic, an exploded
   parts diagram, a product photo. It shows up in the image list on the
   left; click it to make it the active image.
3. Click anywhere on the image to place a hotspot (a red crosshair tracks
   where you're about to click, with a dashed box showing roughly how much
   room the label will take). Fill in **Link name** and **Address (url)**
   in the "New link (hotspot)" panel and click **Add link**. If this exact
   part is drawn elsewhere on the same image already, pick it from the
   "Same part as an existing hotspot?" dropdown instead of typing a new
   address — the two hotspots will share one data row.
4. Under **New table row**, pick the hotspot's address from the dropdown,
   fill in Name / SKU / Description, and optionally some free-form
   characteristics as JSON (e.g. `{"weight": "2.3 kg"}`), then click
   **Add row**. This is the data the viewer will show when someone clicks
   that hotspot.
5. Click **Save** to write the catalog to a `.ecatm` file — in Chrome/Edge
   it asks where the first time, then saves there on every later Save;
   other browsers download a fresh copy each time. **Export .ecatm** always
   downloads a copy without touching wherever you last saved.

A few other things worth knowing:

- Drag a hotspot to reposition it; click one (or its row under "Links on
  this image") to rename it, change its address, or delete it.
- Select an image to rename it or move it into a **Folder** — the image
  list becomes two-level, grouped by folder (see "Grouping images into
  folders" below).
- **Copy remote catalog…** and opening a `.sch` file both work here too
  (see the matching sections below) — either way, what you get is an
  editable, unattached copy: Save prompts for a location, and nothing is
  ever written back to wherever the data came from.

## Using the viewer

1. Click **Open catalog…** and pick a `.ecatm` file — or a legacy `.sch`
   file from the previous-generation desktop software this project
   continues (see "Opening a legacy `.sch` catalog" below).
2. The image list appears on the left (grouped into folders if the
   catalog uses them). Click an image to view it.
3. Click a hotspot on the picture to highlight its row in the table on the
   right — or click a table row to highlight and center its hotspot on the
   picture. If a part is drawn more than once on the same image, a
   **‹ N of M ›** control appears so you can step through every occurrence.
4. Click **Search…** to find something anywhere in the catalog, not just
   the current image, optionally narrowed to one field. Click a result to
   jump straight to it.
5. Zoom with **+ / − / Reset** (bottom-right) or Ctrl/Cmd+scroll over the
   image; drag the bare image to pan around it.

Someone shared a catalog with you as a link instead of a file? Click
**Open remote catalog…** and paste it in, or just open the link directly —
see "Sharing a catalog via link" below.

## Embedding the viewer

`<ecm-viewer>` is the viewer packaged as a Web Component — drop it into any
page, including a plain static HTML file with no build step of its own.
One `<script>` tag covers both the lite and full variants — just change
the attributes on `<ecm-viewer>` itself:

```html
<script src="https://cdn.jsdelivr.net/gh/alexandrkotov/electronic-catalog-maker@main/packages/viewer-embed/dist/ecm-viewer.js"></script>

<!-- Lite (default): just the picture + hotspots + table, fixed to one catalog. -->
<ecm-viewer src="https://example.com/catalog.ecatm" style="height: 500px"></ecm-viewer>

<!-- Full: the whole toolbar too (Open catalog…/Open remote catalog…/Search…/theme) —
     src is only what's shown first, a visitor can open a different catalog from there. -->
<ecm-viewer mode="full" src="https://example.com/catalog.ecatm" style="height: 600px"></ecm-viewer>
```

That's the whole setup: no `type="module"`, no npm install on your side —
the script self-registers the `<ecm-viewer>` tag once, and every
`<ecm-viewer>` element on the page (lite, full, or a mix of both) becomes
its own independent instance, each in its own Shadow DOM (styles can't
leak either direction) and each reusing the exact same catalog-viewing
code as the standalone viewer above (see
`packages/shared/src/viewerEngine.ts`) — everything on this page about
clicking hotspots, search, folders, `.sch` catalogs, and so on applies
here too.

Two attributes:

- `src` — a catalog URL to load on mount (same CORS requirement as
  "Sharing a catalog via link" above — the file's host needs to allow it).
- `mode` — `"lite"` (default) or `"full"`, as in the two examples above.

Sizing and appearance are ordinary CSS on the element itself — it defaults
to `height: 600px` with a light border, but any style/CSS rule your page
applies to `ecm-viewer` (or a matching id/class) overrides that.

## Catalog file format

One `.ecatm` file (a SQLite database under the hood) = one catalog. Tables:

- `images` — one row per picture (name, embedded image data, size, and an
  optional `folder` label for grouping in the image list)
- `links` — one row per clickable hotspot on an image (name, url, pixel
  position). Several hotspots may share the same `name`/`url` — that's how
  the same part gets drawn at multiple positions on one exploded diagram.
- `rows` — one row of data per link, joined by `url`. Fixed columns (`name`,
  `sku`, `description`) plus a free-form `extra` JSON column for whatever
  characteristics a given catalog needs.

See [`packages/shared/src/schema.ts`](packages/shared/src/schema.ts) for
the exact DDL.

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

## Packages

- [`packages/shared`](packages/shared) — the catalog file format: SQLite
  schema, TypeScript types, and the sql.js wrapper all three packages below
  import (opening/saving, search, folder grouping, legacy `.sch` import) —
  plus `viewerEngine.ts`, the viewer's actual rendering/state logic, shared
  between the standalone viewer and the embeddable one so there's exactly
  one implementation of "how the viewer behaves", not two to keep in sync.
- [`packages/editor`](packages/editor) — builds a catalog.
- [`packages/viewer`](packages/viewer) — full-page app that opens one and
  browses it; mounts `viewerEngine` into its own page.
- [`packages/viewer-embed`](packages/viewer-embed) — the same engine
  packaged as the `<ecm-viewer>` Web Component (see "Embedding the viewer"
  above), built as a single self-contained script.

All three apps render their own DOM directly — there's no UI framework,
just the shared engine/data layer above.

## Development

```bash
pnpm install
pnpm dev:editor   # http://localhost:5173
pnpm dev:viewer   # http://localhost:5174 (or next free port)
pnpm dev:embed    # http://localhost:5175 (or next free port) — <ecm-viewer> dev preview
pnpm -r build     # production build of all three -> packages/*/dist
```

For the editor/viewer, `pnpm -r build` output is genuinely everything
needed to host either app: static HTML/JS/CSS/WASM, no build-time secrets,
no server-rendering step. Serve a `dist` folder with any static file host
— `npx serve packages/viewer/dist`, GitHub Pages, Cloudflare Pages, or
similar. `packages/viewer-embed`'s build is different in one way: its
`dist/ecm-viewer.js` is committed to the repo on purpose (see "Status")
rather than gitignored, since that's the file "Embedding the viewer"
points people at directly — rebuild and recommit it after touching that
package or the shared viewer engine.

## Status

Functional end-to-end in the editor and viewer: create a catalog, place
hotspots, add data rows, save/export, group images into folders, search
the whole catalog at once, open a catalog by URL, open a legacy `.sch`
catalog (read-only in the viewer, as an editable copy in the editor),
light/dark theme. The viewer is also embeddable elsewhere as
`<ecm-viewer>` (see "Embedding the viewer"), distributed straight from
this repo via jsDelivr — its built `dist/ecm-viewer.js` is deliberately
committed (everywhere else, `dist/` is gitignored) since that file *is*
what gets served; there's no CI yet to rebuild it automatically, so it
needs rebuilding and recommitting by hand after a change to
`packages/viewer-embed` or `packages/shared/src/viewerEngine.ts`. Not yet
built: a hosted/public version of the editor/viewer apps themselves (local
dev server is the only way to run them today), bulk link import.

## License

MIT

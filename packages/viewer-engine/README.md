# @ecm/viewer-engine

The [Electronic Catalog Maker](https://github.com/alexandrkotov/electronic-catalog-maker) viewer engine as a library: open a `.ecatm` catalog from bytes or a URL, show it with its hotspots and table, and drive it from a host application — read and set the current *view* (image, hotspot, zoom, position, a highlighted area), react to events, add your own toolbar buttons.

MIT licensed. Released as a `.tgz` attached to a GitHub Release (tag `viewer-engine-vX.Y.Z`), versioned with semver:

```
bun add https://github.com/alexandrkotov/electronic-catalog-maker/releases/download/viewer-engine-v0.1.0/ecm-viewer-engine-0.1.0.tgz
```

## What is in the package

| File | What for |
| --- | --- |
| `dist/index.js` (+ `dist/chunks/`) | The ES module. No bare imports: it works straight from a folder or through any bundler. The PDF writer (pdf-lib, over a megabyte) is a separate chunk, fetched on the first export only. |
| `dist/style.css` | The stylesheet, as a file. The same text is exported as `viewerCss`. |
| `dist/sql-wasm.wasm` | SQLite for the browser. Serve it and pass its URL as `wasmUrl`. |
| `dist/fonts/DejaVuSans.ttf` | The font PDF export draws with. Serve it and pass its URL to `createPdfExporter`. |
| `dist/types/` | TypeScript declarations (`types` in `package.json`). |

## Usage

```ts
import { mountViewerInShadow, createPdfExporter, type EcatmView } from "@ecm/viewer-engine";

const viewer = mountViewerInShadow(document.getElementById("viewer")!, {
  mode: "reader",
  wasmUrl: "/assets/sql-wasm.wasm",
  exportPdf: createPdfExporter("/assets/DejaVuSans.ttf"),
  theme: "light",
  persist: false,
  analytics: false,
  toolbarActions: [{ id: "bookmark", label: "Bookmark", icon: "★", onClick: (view) => saveBookmark(view) }],
  onEvent: (type, detail) => {
    if (type === "view") rememberPosition(detail as unknown as EcatmView); // at most every 250 ms
    if (type === "region") console.log("area marked", detail);
  },
});

await viewer.openUrl("/books/42.ecatm", { fetchInit: { credentials: "include" } });
viewer.setView({ v: 1, imageId: 3, zoom: 2, cx: 0.4, cy: 0.5 });
const pdf = await viewer.exportPdf(); // Uint8Array
```

Your own search box can drive the viewer's: `viewer.search("bolt")` opens the search panel with that query (without taking the keyboard focus) and returns the number of matches, `viewer.search("bolt", { field: "sku" })` narrows it to one column, and `viewer.clearSearch()` closes it. A click on a result opens its picture and hotspot and the `"view"` event follows. In `mode: "reader"` the viewer registers no WebMCP agent tools.

A host's "Print" does not have to print the whole catalog: `viewer.exportPdf({ imageId })` prints that picture with its table, and `viewer.exportPdf({ imageId, region })` only that part of it (an `EcatmView`'s `region`, fractions of the picture) with the hotspots and rows inside it. So the page on screen prints as `exportPdf({ imageId: view.imageId, region: view.region })`. An unknown picture, a region without `imageId` or an empty region rejects.

`mountViewerInShadow` keeps the viewer's stylesheet (it restyles every `button`, `table` and `select`) apart from your page. To share the page's own DOM instead, call `mountViewer` with a `container` and add `viewerCss` or `style.css` yourself.

## On a server: `@ecm/viewer-engine/server`

For indexing and previews, a second entry point reads a catalog without a screen. No DOM, no canvas: it runs in Bun and in Node (and needs `sql.js`, which the package depends on).

```ts
import { openCatalog, extractCover, extractSearchChunks, searchCatalog, indexCatalog } from "@ecm/viewer-engine/server";

const db = await openCatalog(bytes, { wasm: wasmBytes }); // wasm: bytes, a path/URL or locateFile; optional in node_modules
const cover = extractCover(db);              // { mime, bytes } — the first picture as stored, or null
const chunks = extractSearchChunks(db);      // [{ imageId, linkId?, text }] for a full-text index
const hits = searchCatalog(db, "hinge");     // [{ imageId, linkId?, rowName, snippet }]
db.close();
```

`imageId` and `linkId` are the ids of an `EcatmView`: a hit opens the catalog right there with `setView({ v: 1, imageId, linkId })`.

- A protected (`ECMPROT`) catalog needs `key`; without it `openCatalog` throws a `ProtectedCatalogError` with code `"locked"` (`"wrong-password"` for a wrong one). `indexCatalog(bytes, { key? })` never throws for that: with the key it returns the catalog's name, cover and chunks, without it only the name and cover the author made public, and `locked: true`.
- A quiz catalog yields only its picture names and no search hits — its items are answer options, and its viewer has no search either.
- `searchCatalog` matches like the viewer's Search box (case-insensitive substring over name, sku, description and extras, or one field), over items; picture names are in the chunks.

## The view

`EcatmView` (format version `v: 1`) is a plain object you can store, put in a link or turn into a QR code:

```ts
{ v: 1, imageId: 3, linkId?: 9, zoom?: 2, cx?: 0.4, cy?: 0.5, region?: { x, y, w, h } }
```

Every position is a fraction 0..1 of the image, so a view looks the same in a window of any size. `zoom` 1 is the whole image fitted into the window (an image smaller than the window is not enlarged); `cx`/`cy` is the point of the image in the middle of the window. A `region` without a `zoom` is fitted into the window and centered.

The same view travels in a link as `image`, `link`, `zoom`, `cx`, `cy` and `rect=x,y,w,h` (`parseViewGeometry`, `setViewGeometryParams`).

## Notes for a host

- With `persist: false` nothing is read from or written to `localStorage`.
- With `analytics: false` (and no PWA/analytics code of yours) the only request the viewer makes is the catalog's own download, and the PDF chunk and font when you ask for an export.
- `fetchInit` of `openUrl` is reused for Refresh and for links to other catalogs on the same origin, and is never sent to another origin.

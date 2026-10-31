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

`mountViewerInShadow` keeps the viewer's stylesheet (it restyles every `button`, `table` and `select`) apart from your page. To share the page's own DOM instead, call `mountViewer` with a `container` and add `viewerCss` or `style.css` yourself.

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

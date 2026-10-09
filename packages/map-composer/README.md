# @ecm/map-composer — Map Composer

A static web app (like the editor, viewer and Grid Composer — no server)
that builds a catalog from a live map and the points placed on it. What it
does for the user is described in the root README ("Building a catalog from
a map"); this file is about how.

## What the catalog looks like

- The **map** is the first image: a PNG of the view as shown, fitted to the
  window when opened, and the catalog opens straight on it.
- Each **point** is a navigation hotspot on the map (`#image=<id>`, see
  `packages/shared/src/navLink.ts`) leading to that point's own image — the
  user's photo re-encoded as JPEG (longer side capped at 2000 px), or a
  generated placeholder card with the point's name.
- Every point's image carries a **"⌂"** hotspot back to the map, in the
  top-left corner at the proportions of the hand-built "Shop the look" demo
  (80 px in, 60 px font on 1536×1024), scaled to the page's shorter side.

No rows are written, and neither the schema nor the viewer changes: it is
the same catalog shape as `demo/living-room.ecatm`.

## Pipeline

1. **`main.ts`** runs the page: a MapLibre GL JS map, DOM markers for the
   points (draggable, styled and sized like the viewer's hotspots), the
   address search and the points list.
2. **`geo.ts`** is the pure part, unit-tested (`geo.test.ts`): a point's
   position on the picture, marker font sizes, the "⌂" placement, and the
   map metadata.
3. **`render.ts`** reads the map's canvas into a PNG and prints the data
   credit into its bottom-right corner; it also draws the placeholder
   cards and re-encodes photos.
4. **`build.ts`** writes the `.ecatm`.

## A picture that doesn't depend on the screen

The map's pixel ratio is set from the map's own width (`mapPixelRatio`),
never from the device's: 2 on a desktop-wide map, up to 4 on a phone, so the
picture comes out about 1784 px wide everywhere. A hotspot's position is the
point's `map.project()` position scaled by canvas size over container size
(`toImagePixels`), so it lands on its point at any ratio. The map can't be
rotated or tilted: the picture is north-up and described by a plain bbox.

The canvas is created with `preserveDrawingBuffer`, and the build waits for
the map to go idle, so the PNG holds the finished frame.

## Map data, and what must not be used

- Tiles and styles come from **OpenFreeMap** (`tiles.openfreemap.org`):
  OpenStreetMap data in the OpenMapTiles schema, no key or account,
  commercial use allowed, attribution required — including on a saved or
  printed picture, which is why the credit is drawn into the PNG.
- **Never** fetch tiles from `tile.openstreetmap.org` (its tile usage policy
  forbids bulk use) and **never** use Google Maps tiles, screenshots or
  Static Maps here: their terms forbid storing and re-hosting the content,
  which is exactly what a catalog file does.
- The address search is **Nominatim** (`search.ts`), within its usage
  policy: one request per second at most, and only on Enter or the Search
  button — no search-as-you-type.

## Metadata for a later live map

`build.ts` adds two keys to the `meta` table that today's viewers never
read:

- `map` — `{ source, attribution, style, bbox, center, zoom, imageSize }`;
- `map_points` — one `{ linkId, imageId, name, geo: { lat, lng } }` per
  point, tied to its hotspot and its page by id.

They are enough to swap the picture for a live offline map (PMTiles) later
without rebuilding the catalog.

## Handing the file to the Editor/Viewer

Same as the Grid Composer: "Open in Editor/Viewer" links to
`../editor/?src=<blob URL>`, which needs all the apps on one origin — as on
`tapalog.com` or a local `bash scripts/build-site.sh` + static server. Under
`pnpm dev:map-composer` use Download.

## Development

```bash
pnpm dev:map-composer   # from the repo root
pnpm --filter @ecm/map-composer test
```

# @ecm/composer — Grid Composer

A static web app (like the editor and viewer — no server) that builds a
finished tile catalog from a folder of numbered photos and a table. What it
does for the user is described in the root README ("Building a tile catalog
from photos and a table"); this file is about how.

## Pipeline

1. **`table.ts`** parses the table — a CSV/TSV file, or a range pasted from
   Excel / Google Sheets (the clipboard carries it as TSV). The delimiter
   is whichever of tab / `;` / `,` splits the header line into the most
   columns; quoted fields may hold delimiters, newlines and `""`. Columns
   are positional: No. · Folder · Name · SKU · Description, then every
   further header becomes an `extra` key. A file that isn't valid UTF-8
   (Excel's plain "CSV" save) is re-read as windows-1251, or windows-1252
   when the UI is in English.
2. **`plan.ts`** matches photos to rows by number (`7.jpg`, `007.png`, …)
   and lays the items out into grids — pure data, unit-tested
   (`plan.test.ts`). One grid per table folder (root first, then folders in
   the order the table first mentions them), items sorted by number. The
   row key (`rows.url`) is the SKU when it's unique, otherwise
   `item-<No.>`. The same pass produces the pre-build report: blocking
   problems (bad or duplicate numbers, no rows) and warnings.
3. **`render.ts`** draws each grid onto a canvas and encodes it as one JPEG
   (quality 0.85), returning each tile's hotspot anchor. It follows the
   repo's tile-grid conventions, worked out on the hand-built demos:
   - the canvas is 920 px wide, so a grid fits the viewer's stage at 100% on
     a 1920×1080 screen with no horizontal scroll;
   - the hotspot sits inset from the tile's top-left corner by half the
     viewer's badge footprint plus a margin, so the viewer's centered badge
     renders fully inside the tile (sized for the widest number in the
     catalog);
   - one title-pill font size for every grid — the largest at which every
     title fits.
4. **`build.ts`** writes the `.ecatm`: one image per grid (fit on open only
   while it's short), one link per tile named by its number, one row per
   item with `"No."` first in `extra` (a bare-number badge must also be
   visible in the table).

## The height ceiling

A grid is one image, so its height is capped at `MAX_GRID_HEIGHT` (16,000
px): iOS Safari refuses canvases over 16,777,216 px, the PDF export redraws
non-JPEG images through a canvas, and Chrome won't create one taller than
32,767 px anyway. `maxTilesPerGrid()` turns that into a tile count for the
current column count and caption height; `makePlan` splits a bigger folder
into equal parts of whole rows, which `build.ts` groups under an image
folder — the only case where the composer uses image folders at all.

## Handing the file to the Editor/Viewer

"Open in Editor/Viewer" links to `../editor/?src=<blob URL>` (and the
viewer's equivalent). A `blob:` URL can be fetched by any page of the same
origin while the document that created it is alive, so this needs no change
in either app — but it does need all three on one origin, as on
`tapalog.com` or a local `bash scripts/build-site.sh` + static server. Under
`pnpm dev:composer` the editor runs on another port, so use Download there.

## Development

```bash
pnpm dev:composer   # from the repo root
pnpm --filter @ecm/composer test
```

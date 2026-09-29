# @ecm/store-importer

Turns an online store into what the [Grid Composer](../composer) builds a
tile catalog from: a folder of photos named by number (`1.jpg`, `2.jpg`, …)
plus a table (`catalog.csv`: `No.`, `Folder`, `Name`, `SKU`, `Description`,
`Price`, `buy_url`). It doesn't build the catalog itself — that stays in the
composer. No account, no cloud: everything is saved on your own computer.

## How it works

1. Run this app (`pnpm dev:store-importer` from the repo root, or
   `bun run src/main.ts` here). It starts a server on `127.0.0.1:8931`
   (loopback only — nothing here is meant for other devices) and opens its
   page in your default browser — the app's whole UI, no separate window.
   Starting it again while it's already running just reopens the page.
2. On the page: the store's address, the platform (**Detect
   automatically** by default), the folder to save into (**Browse…** opens
   the OS's own folder dialog, same code as `@ecm/catalog-server`), and a
   required "this is my store, or I have the owner's permission" checkbox —
   `/import` refuses a request without it too, not just the page.
3. **Import** runs in the background and the page polls `/job.json` for
   progress, then shows a report: products, folders, and which numbers came
   without a photo, SKU, price or category. For a saved-page import (below)
   it also lists pages of the store's product list that weren't saved.
4. The result lands in `<chosen folder>/<store host>/` — `photos/` and
   `catalog.csv` (UTF-8 with BOM and CRLF, so Excel opens it cleanly too).
   A re-import of the same store replaces `photos/` whole, so a product
   removed from the store can't leave its old photo under a number that
   now belongs to another product.
5. **Quit Store Importer** at the bottom of the page exits the app —
   closing the tab doesn't.

## Presets

Each supported platform is one JSON file in [`src/presets/`](src/presets),
listed in [`src/presets.ts`](src/presets.ts) (which also documents every
field). Two kinds:

- **`json-feed`** ([`shopify.json`](src/presets/shopify.json)) — the store
  serves a public product feed and the importer pages through it itself.
  `detect` is one cheap request that tells whether a store runs this
  platform; `source` says how to page (`pageSize` — a shorter page is the
  last one; `maxPages` is a hard stop); `fields`/`price` point into one
  product with a small path language — `title`, `variants[0].sku`,
  `variants[*].price` (see [`src/jsonPath.ts`](src/jsonPath.ts)); `buyUrl`
  is a template (`{origin}/products/{handle}`); `imageQuery` is added to
  every photo URL (Shopify's CDN resizes on `width=`, so a 2.7 MB original
  arrives as ~220 KB). `price.minorUnitsPath` handles feeds that give
  prices in cents.
- **`saved-page`** ([`payhip.json`](src/presets/payhip.json)) — for
  platforms that block automated access (Payhip's store pages sit behind a
  Cloudflare challenge; it has no product-list API). The person saves the
  store's pages from their own browser and picks the files; `card` and
  `fields` are CSS selectors (matched with Bun's built-in `HTMLRewriter`,
  first match per card), `pattern` keeps one regex match of a value (the
  original S3 photo out of a `srcset`), and `pagination` lets the report
  tell which pages of the list are missing. `howToSave` is the step list
  the page shows next to the file picker.

To add a platform: add a JSON file of either kind, list it in
`PRESETS`, and add a test with a fixture of the platform's real response
or page (see [`test/`](test)).

## Being a good guest

Every request to a store goes through
[`src/politeFetch.ts`](src/politeFetch.ts): an identifying User-Agent
(`ECM-Store-Importer/… (+https://tapalog.com)`), at least 300 ms between
requests, at most 3 photo downloads in flight, and a bounded retry on
429/5xx that honors `Retry-After`. It never tries to get around a block —
a platform that refuses automated access gets the saved-page route
instead.

## Running the tests

```bash
bun test
```

Covers the path language, text/price normalization, the CSV format,
pagination and re-import against a fake Shopify store, the Payhip
saved-page extraction and page-coverage report, retries, and that the
page's inline script still parses (it lives inside a TypeScript template
literal, where a stray `\` breaks it silently).

## Building a distributable binary

```bash
bun run compile:linux-x64      # dist/ecm-store-importer-linux-x64
bun run compile:macos-arm64    # dist/ecm-store-importer-macos-arm64
bun run compile:macos-x64      # dist/ecm-store-importer-macos-x64
bun run compile:windows-x64    # dist/ecm-store-importer-windows-x64.exe (no console window)
```

One `bun build --compile` of `src/main.ts` each — the presets (JSON
imports) and the favicon (`with { type: "file" }`) are embedded, nothing
else to fetch or ship alongside.

The release workflow (`.github/workflows/store-importer-release.yml`,
`workflow_dispatch` only) builds all four, smoke-tests the Apple Silicon
binary on a real Mac runner, packages and smoke-tests a `.deb`
(Chromebook/Debian/Ubuntu), can build + publish the Snap
([`snap/snapcraft.yaml`](snap/snapcraft.yaml), `publish_snap` off by
default), and updates the rolling `store-importer-latest` GitHub Release —
the same structure as catalog-server's, see its README for the rationale of
each piece. Before the first Snap publish, the name has to be registered
once (`snapcraft register ecm-store-importer`) and the
`SNAPCRAFT_STORE_CREDENTIALS` secret has to cover this snap too. The
Microsoft Store listing, like catalog-server's, is an MSIX packaged by hand,
not by the workflow.

Inside a strictly confined snap `HOME` is the snap's own private folder,
so the default "save to" folder is built from `SNAP_REAL_HOME` instead
(see `src/config.ts`) — imports land in the real `~/Documents`.

## Releases

Direct downloads (`store-importer-latest` GitHub Release), the
[Snap Store](https://snapcraft.io/ecm-store-importer), and the
[Microsoft Store](https://apps.microsoft.com/detail/9pnmbwb503bp?hl=en-US&gl=US)
— all linked from the landing page's Store Importer tile. The app's icon
(`assets/icons/`) is its own: the project's standard icon with an "I" badge.

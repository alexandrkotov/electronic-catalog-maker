# Contributing

Thanks for looking. This is a small project and bug reports, ideas and pull
requests are all welcome. If something is unclear, open an issue and ask.

## Run it locally

You need [Node.js](https://nodejs.org/) 18 or later and
[pnpm](https://pnpm.io/installation). The server packages and some tests
also use [Bun](https://bun.sh/).

```bash
git clone https://github.com/alexandrkotov/electronic-catalog-maker.git
cd electronic-catalog-maker
pnpm install
pnpm dev:editor   # http://localhost:5173
pnpm dev:viewer   # http://localhost:5174, in a second terminal
```

No `.env` file or database is needed. The README's "Development" section
lists every `dev:*` command (embed, composer and the three optional
servers).

## Before you open a pull request

CI runs the same checks on every pull request, so it is quicker to run them
first:

```bash
pnpm typecheck
pnpm build
pnpm --filter @ecm/shared test
pnpm --filter @ecm/composer test
pnpm --filter @ecm/collab-server test      # needs Bun
pnpm --filter @ecm/store-importer test     # needs Bun
bun scripts/generate-site.ts --check
```

## Things worth knowing

- **Landing pages are generated.** Don't edit `landing/index.html`,
  `landing/schools.html` or their `ru/` and `uk/` copies by hand. Change the
  templates in `site-src/templates/` or the dictionaries in
  `site-src/i18n/`, then run `bun scripts/generate-site.ts` and commit the
  result. CI fails if the generated files are out of date.
- **`packages/viewer-embed/dist/ecm-viewer.js` is committed on purpose**; it
  is the file the CDN serves. CI rebuilds it after a push to `main`, so you
  don't need to include it in a pull request.
- **Everything runs in the browser.** The editor, viewer and composer have
  no backend, and a catalog is a single `.ecatm` file (SQLite). Please keep
  it that way: no new required server, account or upload.
- **Changes to the file format** need extra care, since people keep their
  catalogs for years. See "Catalog file format" in the README.

## Reporting a bug

A short description, what you expected, what happened, and your browser and
OS. If it involves a particular catalog, attach the `.ecatm` file (or a
cut-down version of it) if you can share it.

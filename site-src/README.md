# Localized landing pages

`landing/index.html`, `landing/schools.html`, the full toolset map
`landing/toolset.svg` (linked from the landing's short map and shown in the
repo README), the catalog-types picture `landing/catalog-types.svg` (the
landing's "What a catalog can be" section as one image, for the repo README)
and their translated copies in `landing/<lang>/` are **generated** — don't
edit them by hand. The two `.svg` files are standalone SVG (XML), so the
`toolset.*` and `types.*` messages must not use HTML-only entities like
`&nbsp;`. `templates/_catalog-type-icons.svg` is not a page: it holds the
pictograms both the landing section and `catalog-types.svg` pull in with
`{{@typeIcons}}`.

- `templates/` — one HTML template per page, shared by every language.
  `{{some.key}}` pulls a message from the dictionary; `{url_name}` an external
  link from `links.json` (also usable inside messages, so a translation can't
  silently lose a link); `{{@lang}}`, `{{@demoLang}}`, `{{@base}}`, `{{@alternates}}`,
  `{{@switch}}`, `{{@messages}}`, `{{@typeIcons}}`, `{{@jsonld}}` are per-page values (see
  `scripts/generate-site.ts`).
- `i18n/<lang>.json` — flat `key: message` dictionaries (messages are trusted
  HTML). `en.json` is the source of truth; every other language is checked
  against it (missing/extra keys, plural forms, `{placeholders}`). Keys
  starting with `js.` are handed to the page's own scripts as `T.<key>`;
  plurals there use `Intl.PluralRules` (`js.visits.one/few/many/other`).
- `links.json` — external URLs; `{hl}` becomes the language's Microsoft
  Store locale.

`landing/sitemap.xml` and `landing/robots.txt` are generated too (the list of
pages lives in `scripts/generate-site.ts`); a new page has to be added there
to be listed.

## Workflow

```
bun scripts/generate-site.ts            # regenerate landing/ (commit the result)
bun scripts/generate-site.ts --check    # what CI runs: fails if landing/ is stale
```

The output is committed on purpose: `scripts/build-site.sh` (GitHub Pages
and the disaster-recovery build) just copies `landing/`, so there is no
generator to break when it matters.

## Adding a language

1. Add it to `LANGS` and `OG_LOCALE` in `scripts/generate-site.ts`. Add it
   to `DEMO_LANGS` there only if `demo/` has the per-language catalogs
   (`fitness-<lang>.ecatm`, …) in it; otherwise the pages link to the English ones.
2. Copy `i18n/en.json` to `i18n/<lang>.json` and translate (keep every
   `{url_…}`, `{n}` and HTML tag; add the plural forms the language needs).
3. Add it to the `for lang in …` loop in `scripts/build-site.sh`.
4. Generate, commit, and add the language to the viewer/editor
   (`packages/shared/src/locales/*`) and to the two composers
   (`packages/composer/src/messages.ts`, `packages/map-composer/src/messages.ts`)
   if the embedded demos and the catalog wizard should follow.

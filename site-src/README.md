# Localized landing pages

`landing/index.html`, `landing/schools.html` and their translated copies in
`landing/<lang>/` are **generated** — don't edit them by hand.

- `templates/` — one HTML template per page, shared by every language.
  `{{some.key}}` pulls a message from the dictionary; `{url_name}` an external
  link from `links.json` (also usable inside messages, so a translation can't
  silently lose a link); `{{@lang}}`, `{{@base}}`, `{{@alternates}}`,
  `{{@switch}}`, `{{@messages}}` are per-page values (see
  `scripts/generate-site.ts`).
- `i18n/<lang>.json` — flat `key: message` dictionaries (messages are trusted
  HTML). `en.json` is the source of truth; every other language is checked
  against it (missing/extra keys, plural forms, `{placeholders}`). Keys
  starting with `js.` are handed to the page's own scripts as `T.<key>`;
  plurals there use `Intl.PluralRules` (`js.visits.one/few/many/other`).
- `links.json` — external URLs; `{hl}` becomes the language's Microsoft
  Store locale.

## Workflow

```
bun scripts/generate-site.ts            # regenerate landing/ (commit the result)
bun scripts/generate-site.ts --check    # what CI runs: fails if landing/ is stale
```

The output is committed on purpose: `scripts/build-site.sh` (GitHub Pages
and the disaster-recovery build) just copies `landing/`, so there is no
generator to break when it matters.

## Adding a language

1. Add it to `LANGS` in `scripts/generate-site.ts`.
2. Copy `i18n/en.json` to `i18n/<lang>.json` and translate (keep every
   `{url_…}`, `{n}` and HTML tag; add the plural forms the language needs).
3. Add its `cp` line to `scripts/build-site.sh`.
4. Generate, commit, and add the language to the viewer/editor
   (`packages/shared/src/locales/*`) if the embedded demos should follow.

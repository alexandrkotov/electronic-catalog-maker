/**
 * Generates the localized static pages (landing/index.html, landing/schools.html
 * and their translated copies under landing/<lang>/) from the shared
 * templates in site-src/templates/ and the per-language dictionaries in
 * site-src/i18n/. The generated files are COMMITTED (the deploy script and
 * the disaster-recovery runbook just copy landing/ — no build step to break
 * when it matters); CI runs `--check` to make sure nobody edited a generated
 * file by hand or forgot to regenerate after changing a template/dictionary.
 *
 * Template syntax:
 *   {{some.key}}   -> the dictionary message (trusted HTML), missing key = error
 *   {url_name}     -> an external URL from site-src/links.json (also usable
 *                     inside messages, so translators keep every link intact)
 *   {{@lang}} {{@base}} {{@alternates}} {{@switch}} {{@messages}} -> per-page values
 *
 * Usage: bun scripts/generate-site.ts [--check]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { checkDictionary } from "../packages/shared/src/i18n.ts";

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const SITE_ORIGIN = "https://tapalog.com";

interface LangConfig {
  /** Output directory, relative to the repo root. */
  dir: string;
  /** URL path prefix of this language's pages. */
  path: string;
  /** Prefix from a page of this language back to the site root (for shared assets/apps). */
  base: string;
  /** Language name shown in the switcher (in its own language). */
  name: string;
  /** Microsoft Store `hl` parameter. */
  storeLocale: string;
}

const LANGS: Record<string, LangConfig> = {
  en: { dir: "landing", path: "/", base: "", name: "English", storeLocale: "en-US" },
  ru: { dir: "landing/ru", path: "/ru/", base: "../", name: "Русский", storeLocale: "ru-RU" },
  uk: { dir: "landing/uk", path: "/uk/", base: "../", name: "Українська", storeLocale: "uk-UA" },
};
const DEFAULT_LANG = "en";
const PAGES = ["index.html", "schools.html"];

const readJson = (path: string) => JSON.parse(readFileSync(join(ROOT, path), "utf8")) as Record<string, string>;
const links = readJson("site-src/links.json");
const dictionaries: Record<string, Record<string, string>> = {};
for (const lang of Object.keys(LANGS)) dictionaries[lang] = readJson(`site-src/i18n/${lang}.json`);

function pageUrl(lang: string, page: string): string {
  return SITE_ORIGIN + LANGS[lang]!.path + (page === "index.html" ? "" : page);
}

function render(template: string, page: string, lang: string): string {
  const cfg = LANGS[lang]!;
  const dict = dictionaries[lang]!;
  const messagesJson = () => {
    const js: Record<string, string> = {};
    for (const [k, v] of Object.entries(dict)) if (k.startsWith("js.")) js[k.slice(3)] = v.replace(/\{url_(\w+)\}/g, (_, n) => links[n] ?? "");
    // "<" escaped so a message can never close the surrounding <script>.
    return JSON.stringify(js).replace(/</g, "\\u003c");
  };
  const special: Record<string, () => string> = {
    "@lang": () => lang,
    "@base": () => cfg.base,
    "@messages": messagesJson,
    "@alternates": () =>
      [
        ...Object.keys(LANGS).map((l) => `<link rel="alternate" hreflang="${l}" href="${pageUrl(l, page)}" />`),
        `<link rel="alternate" hreflang="x-default" href="${pageUrl(DEFAULT_LANG, page)}" />`,
        `<link rel="canonical" href="${pageUrl(lang, page)}" />`,
      ].join("\n"),
    "@switch": () =>
      Object.entries(LANGS)
        .filter(([l]) => l !== lang)
        .map(([l, c]) => {
          const rel = page === "index.html" ? "" : page;
          // Relative, so it works on any host: back to the root ("../") for
          // English, otherwise down into the language's directory ("ru/", "../uk/").
          const target = cfg.base + (l === DEFAULT_LANG ? "" : c.path.slice(1)) + rel;
          return `<a class="lang-switch" href="${target || "./"}" hreflang="${l}" lang="${l}">${c.name}</a>`;
        })
        .join(" "),
  };
  let out = template.replace(/\{\{([@\w.]+)\}\}/g, (_, key: string) => {
    if (key.startsWith("@")) {
      const fn = special[key];
      if (!fn) throw new Error(`${page}: unknown template variable {{${key}}}`);
      return fn();
    }
    const value = dict[key];
    if (value === undefined) throw new Error(`${page} [${lang}]: missing message "${key}"`);
    return value;
  });
  out = out.replace(/\{url_(\w+)\}/g, (_, name: string) => {
    const url = links[name];
    if (url === undefined) throw new Error(`${page} [${lang}]: unknown link {url_${name}}`);
    return url.replace("{hl}", cfg.storeLocale);
  });
  return out;
}

// --- validate dictionaries against the default language ---
let problems = 0;
for (const lang of Object.keys(LANGS)) {
  if (lang === DEFAULT_LANG) continue;
  for (const p of checkDictionary(dictionaries[DEFAULT_LANG]!, dictionaries[lang]!, lang)) {
    console.error(`site-src/i18n/${lang}.json: ${p}`);
    problems++;
  }
}
if (problems) process.exit(1);

// --- generate ---
const check = process.argv.includes("--check");
const stale: string[] = [];
for (const lang of Object.keys(LANGS)) {
  const cfg = LANGS[lang]!;
  for (const page of PAGES) {
    const template = readFileSync(join(ROOT, "site-src/templates", page), "utf8");
    const html = render(template, page, lang);
    const outPath = join(ROOT, cfg.dir, page);
    const current = existsSync(outPath) ? readFileSync(outPath, "utf8") : null;
    if (current === html) continue;
    if (check) {
      stale.push(join(cfg.dir, page));
    } else {
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, html);
      console.log(`wrote ${join(cfg.dir, page)}`);
    }
  }
}
if (stale.length) {
  console.error(`Generated pages are out of date:\n  ${stale.join("\n  ")}\nRun: bun scripts/generate-site.ts`);
  process.exit(1);
}

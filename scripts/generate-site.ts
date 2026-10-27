/**
 * Generates the localized static pages (landing/index.html, landing/schools.html,
 * the toolset map landing/toolset.svg, the catalog-types picture
 * landing/catalog-types.svg, and their translated copies under
 * landing/<lang>/, plus the site-wide landing/sitemap.xml and
 * landing/robots.txt) from the shared
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
 *   {{@lang}} {{@demoLang}} {{@base}} {{@q}} {{@a}} {{@alternates}} {{@switch}} {{@messages}} {{@jsonld}} -> per-page values
 *   {{@typeIcons}} -> the catalog-type pictograms (templates/_catalog-type-icons.svg)
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
  /** play.tapalog.com `?lang=`, for the languages the games are in; other pages leave it to the browser. */
  playLang?: string;
}

const LANGS: Record<string, LangConfig> = {
  en: { dir: "landing", path: "/", base: "", name: "English", storeLocale: "en-US", playLang: "en" },
  ru: { dir: "landing/ru", path: "/ru/", base: "../", name: "Русский", storeLocale: "ru-RU", playLang: "ru" },
  uk: { dir: "landing/uk", path: "/uk/", base: "../", name: "Українська", storeLocale: "uk-UA" },
  de: { dir: "landing/de", path: "/de/", base: "../", name: "Deutsch", storeLocale: "de-DE" },
};
const DEFAULT_LANG = "en";
// Languages the per-language demo catalogs (demo/fitness-<lang>.ecatm, …) exist
// in; a page in any other language links to the default language's files.
const DEMO_LANGS = ["en", "ru", "uk"];
// toolset.svg is the full toolset map the landing's short one links to (and
// README.md shows) — a standalone SVG, so its messages must stay XML-safe
// (no HTML-only entities like &nbsp;). catalog-types.svg is the same kind of
// file: the landing's "What a catalog can be" section as one picture, for README.md.
const PAGES = ["index.html", "schools.html", "toolset.svg", "catalog-types.svg"];
// One set of pictograms for both the landing section and catalog-types.svg.
const typeIcons = readFileSync(join(ROOT, "site-src/templates/_catalog-type-icons.svg"), "utf8");

const readJson = (path: string) => JSON.parse(readFileSync(join(ROOT, path), "utf8")) as Record<string, string>;
const links = readJson("site-src/links.json");
const dictionaries: Record<string, Record<string, string>> = {};
for (const lang of Object.keys(LANGS)) dictionaries[lang] = readJson(`site-src/i18n/${lang}.json`);

function pageUrl(lang: string, page: string): string {
  return SITE_ORIGIN + LANGS[lang]!.path + (page === "index.html" ? "" : page);
}

// 1200x630 cards rendered from live demo screenshots (tooling lives outside git,
// only the PNGs are committed in landing/ and copied by scripts/build-site.sh).
const OG_IMAGES: Record<string, string> = {
  "index.html": SITE_ORIGIN + "/og-default.png",
  "schools.html": SITE_ORIGIN + "/og-schools.png",
};
const OG_LOCALE: Record<string, string> = { en: "en_US", ru: "ru_RU", uk: "uk_UA", de: "de_DE" };
const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

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
    "@demoLang": () => (DEMO_LANGS.includes(lang) ? lang : DEFAULT_LANG),
    "@base": () => cfg.base,
    // Hand the page's language to the apps it links to (apps read ?lang=).
    // English pages add nothing — the apps' own detection already covers it.
    "@q": () => (lang === DEFAULT_LANG ? "" : `?lang=${lang}`),
    "@a": () => (lang === DEFAULT_LANG ? "" : `&lang=${lang}`),
    "@messages": messagesJson,
    "@typeIcons": () => typeIcons,
    "@landingUrl": () => pageUrl(lang, "index.html"),
    "@og": () => {
      const key = page === "index.html" ? "index" : "schools";
      const title = escapeAttr(dict[`${key}.title`]!);
      const description = escapeAttr(dict[key === "index" ? "index.description" : "schools.tagline"]!);
      const url = pageUrl(lang, page);
      const image = OG_IMAGES[page]!;
      return [
        // Search engines take their snippet from this one, not from og:description.
        `<meta name="description" content="${description}" />`,
        `<meta property="og:type" content="website" />`,
        `<meta property="og:site_name" content="Electronic Catalog Maker" />`,
        `<meta property="og:locale" content="${OG_LOCALE[lang]}" />`,
        `<meta property="og:url" content="${url}" />`,
        `<meta property="og:title" content="${title}" />`,
        `<meta property="og:description" content="${description}" />`,
        `<meta property="og:image" content="${image}" />`,
        `<meta property="og:image:width" content="1200" />`,
        `<meta property="og:image:height" content="630" />`,
        `<meta name="twitter:card" content="summary_large_image" />`,
        `<meta name="twitter:title" content="${title}" />`,
        `<meta name="twitter:description" content="${description}" />`,
        `<meta name="twitter:image" content="${image}" />`,
      ].join("\n");
    },
    // schema.org description of the product, for search engines' rich results.
    // The site itself (WebSite) is described once, on the default-language home page.
    "@jsonld": () => {
      const url = pageUrl(lang, page);
      const graph: object[] = [
        {
          "@type": "SoftwareApplication",
          name: "Electronic Catalog Maker",
          alternateName: "Tapalog",
          url,
          description: dict["index.description"],
          image: OG_IMAGES[page],
          inLanguage: lang,
          applicationCategory: "BusinessApplication",
          operatingSystem: "Web browser, Windows, macOS, Linux",
          offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
          license: "https://opensource.org/licenses/MIT",
          codeRepository: links.github,
          author: { "@type": "Person", name: "Alexander Kotov", sameAs: [links.linkedin, links.x] },
        },
      ];
      if (lang === DEFAULT_LANG) {
        graph.unshift({
          "@type": "WebSite",
          name: "Electronic Catalog Maker",
          alternateName: "Tapalog",
          url,
          inLanguage: Object.keys(LANGS),
        });
      }
      const json = JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c");
      return `<script type="application/ld+json">${json}</script>`;
    },
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
    return url.replace("{hl}", cfg.storeLocale).replace("{playq}", cfg.playLang ? `?lang=${cfg.playLang}` : "");
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

// --- sitemap.xml and robots.txt (site-wide, so written once, next to the default language's pages) ---
// No <lastmod>: the output has to stay the same from run to run for `--check`.
const HTML_PAGES = PAGES.filter((p) => p.endsWith(".html"));
// Pages that exist in one language only: the hand-written privacy page and the apps themselves.
const SINGLE_PAGES = ["privacy.html", "editor/", "viewer/", "composer/", "map-composer/"];

function sitemap(): string {
  const entries: string[] = [];
  for (const page of HTML_PAGES) {
    const alternates = [
      ...Object.keys(LANGS).map((l) => `    <xhtml:link rel="alternate" hreflang="${l}" href="${pageUrl(l, page)}" />`),
      `    <xhtml:link rel="alternate" hreflang="x-default" href="${pageUrl(DEFAULT_LANG, page)}" />`,
    ].join("\n");
    for (const lang of Object.keys(LANGS)) entries.push(`  <url>\n    <loc>${pageUrl(lang, page)}</loc>\n${alternates}\n  </url>`);
  }
  for (const page of SINGLE_PAGES) entries.push(`  <url>\n    <loc>${SITE_ORIGIN}/${page}</loc>\n  </url>`);
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">`,
    ...entries,
    `</urlset>`,
    ``,
  ].join("\n");
}

const robots = `User-agent: *\nAllow: /\n\nSitemap: ${SITE_ORIGIN}/sitemap.xml\n`;

// --- generate ---
const check = process.argv.includes("--check");
const stale: string[] = [];
function emit(relPath: string, content: string): void {
  const outPath = join(ROOT, relPath);
  const current = existsSync(outPath) ? readFileSync(outPath, "utf8") : null;
  if (current === content) return;
  if (check) {
    stale.push(relPath);
  } else {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, content);
    console.log(`wrote ${relPath}`);
  }
}
for (const lang of Object.keys(LANGS)) {
  const cfg = LANGS[lang]!;
  for (const page of PAGES) {
    const template = readFileSync(join(ROOT, "site-src/templates", page), "utf8");
    emit(join(cfg.dir, page), render(template, page, lang));
  }
}
emit(join(LANGS[DEFAULT_LANG]!.dir, "sitemap.xml"), sitemap());
emit(join(LANGS[DEFAULT_LANG]!.dir, "robots.txt"), robots);
if (stale.length) {
  console.error(`Generated pages are out of date:\n  ${stale.join("\n  ")}\nRun: bun scripts/generate-site.ts`);
  process.exit(1);
}

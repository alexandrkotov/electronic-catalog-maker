import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toCsv } from "./csv";
import { selectAll, selectText } from "./jsonPath";
import { mapProduct, type ImportedItem } from "./normalize";
import { mapLimit, type PoliteFetch } from "./politeFetch";
import { PRESETS, getPreset, savedPagePresetForHost, type JsonFeedPreset, type SavedPagePreset } from "./presets";
import { extractCards, savedPageUrl, type PageLink } from "./savedPage";

export type Progress =
  | { stage: "detecting" }
  | { stage: "listing"; page: number; products: number }
  | { stage: "photos"; done: number; total: number }
  | { stage: "writing" };

export interface ImportReport {
  platform: string;
  origin: string;
  products: number;
  folders: string[];
  noPhoto: number[];
  photoFailed: number[];
  noSku: number[];
  /** The SKU column was left empty on purpose (ImportOptions.skipSku). */
  skuSkipped: boolean;
  noPrice: number[];
  /** Products the store gave no type/category, put in UNSORTED_FOLDER. */
  noFolder: number[];
  /** Saved-page imports only: which pages of the store's product list made it in. */
  pages: PageCoverage | null;
  outDir: string;
  csvPath: string;
  photosDir: string;
}

/**
 * Folder "" means Composer's root grid, titled with the catalog's own name.
 * When the store sorts most products into types but leaves a few untyped,
 * those few would form a stray root grid (confirmed live 2026-09-27: one
 * untyped tumbler showed up as its own grid named after the catalog) — so
 * they're gathered into this folder instead. A store with no types at all
 * keeps everything in the root, one grid.
 */
export const UNSORTED_FOLDER = "Other";

export function fillMissingFolders(items: ImportedItem[]): number[] {
  if (!items.some((it) => it.folder)) return [];
  const filled: number[] = [];
  items.forEach((it, i) => {
    if (!it.folder) {
      it.folder = UNSORTED_FOLDER;
      filled.push(i + 1);
    }
  });
  return filled;
}

/** "kith.com", "https://kith.com/collections/x?y" -> "https://kith.com". */
export function normalizeStoreUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Enter the store's address.");
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`"${input}" doesn't look like a web address.`);
  }
  if (!url.hostname.includes(".")) throw new Error(`"${input}" doesn't look like a web address.`);
  return url.origin;
}

/**
 * Folder name for one store's output: its host, filesystem-safe on every
 * OS — plus the path for a store that lives under a shared host
 * (payhip.com/ECMDemoStore -> "payhip.com-ECMDemoStore"), or every Payhip
 * store would overwrite the same folder.
 */
export function outputFolderName(storeUrl: string): string {
  const url = new URL(storeUrl);
  const path = url.pathname.split("/").filter(Boolean).join("-");
  return [url.hostname.replace(/^www\./, ""), path].filter(Boolean).join("-").replace(/[^a-z0-9.-]/gi, "_");
}

async function readJson(res: Response): Promise<unknown> {
  if (!res.ok) return undefined;
  try {
    return await res.json();
  } catch {
    return undefined; // an HTML page (store's 404, a login wall) instead of JSON
  }
}

function arrayAt(body: unknown, path: string): unknown[] | null {
  const v = path === "" ? body : selectAll(body, path)[0];
  return Array.isArray(v) ? v : null;
}

/** On a site whose store pages can only be guessed at, no more sections than this are asked for a feed. */
const MAX_GUESSED_STORES = 20;

/** The store pages a platform's feed lives under — [""] when it's one fixed address per site. */
async function discoverStores(origin: string, preset: JsonFeedPreset, pf: PoliteFetch): Promise<string[]> {
  const d = preset.discover;
  if (!d) return [""];
  const res = await pf(origin + d.path);
  if (!res.ok) return [];
  const text = await res.text();
  const captures = (pattern: string) => [...new Set([...text.matchAll(new RegExp(pattern, "g"))].flatMap((m) => (m[1] ? [m[1]] : [])))];
  const found = captures(d.pattern);
  if (found.length > 0 || !d.fallbackPattern) return found;
  return captures(d.fallbackPattern).slice(0, MAX_GUESSED_STORES);
}

/** The response's product array, or null when it isn't a product list at all. */
function productsIn(body: unknown, preset: JsonFeedPreset, path: string): unknown[] | null {
  const only = preset.source.only;
  if (only && selectText(body, only.path) !== only.equals) return null;
  return arrayAt(body, path);
}

export async function detectPreset(origin: string, pf: PoliteFetch): Promise<JsonFeedPreset | null> {
  for (const preset of PRESETS) {
    if (preset.kind !== "json-feed") continue;
    try {
      for (const store of await discoverStores(origin, preset, pf)) {
        const body = await readJson(await pf(origin + preset.detect.path.replace("{store}", store)));
        if (productsIn(body, preset, preset.detect.expectArray)) return preset;
      }
    } catch {
      // unreachable or timed out for this probe — try the next platform
    }
  }
  return null;
}

/** Adds one response's category tree to `names` (id -> name of its top-level category). */
function collectFolderNames(body: unknown, rule: NonNullable<JsonFeedPreset["folderNames"]>, names: Map<string, string>) {
  const walk = (nodes: unknown[], top: string | null) => {
    for (const node of nodes) {
      const name = top ?? selectText(node, rule.name);
      const id = selectText(node, rule.id);
      if (id) names.set(id, name);
      walk(selectAll(node, rule.children), name);
    }
  };
  walk(selectAll(body, rule.path), null);
}

export interface Feed {
  products: unknown[];
  /** Category id -> folder name; empty unless the preset has a `folderNames` rule. */
  folderNames: Map<string, string>;
  /** Per product, the title of the store page it came from — "" unless the site has several (see `source.storeTitle`). */
  storeTitles: string[];
}

export async function fetchAllProducts(origin: string, preset: JsonFeedPreset, pf: PoliteFetch, onProgress: (p: Progress) => void): Promise<Feed> {
  const s = preset.source;
  const all: unknown[] = [];
  const folderNames = new Map<string, string>();
  const titles: string[] = [];
  let stores = 0;
  let pageNo = 0;
  for (const store of await discoverStores(origin, preset, pf)) {
    let cursor = "";
    for (let i = 0; i < s.maxPages; i++) {
      const url = new URL(origin + s.path.replace("{store}", store));
      for (const [k, v] of Object.entries(s.query)) url.searchParams.set(k, v);
      if (!("cursor" in s)) url.searchParams.set(s.pageParam, String(s.firstPage + i));
      else if (cursor) url.searchParams.set(s.cursor.param, cursor);
      const res = await pf(url.toString());
      const body = await readJson(res);
      const items = productsIn(body, preset, s.itemsPath);
      if (!items) {
        if (i === 0 && !preset.discover) throw new Error(`The store didn't return a product list (HTTP ${res.status}) — it may have its public feed turned off.`);
        break; // not a store page after all, or a platform that answers past-the-end pages with an error instead of an empty list
      }
      if (i === 0) stores++;
      all.push(...items);
      titles.push(...items.map(() => (s.storeTitle ? selectText(body, s.storeTitle) : "")));
      if (preset.folderNames) collectFolderNames(body, preset.folderNames, folderNames);
      onProgress({ stage: "listing", page: ++pageNo, products: all.length });
      if ("cursor" in s) {
        const next = selectText(body, s.cursor.path);
        if (!next || next === cursor) break;
        cursor = next;
      } else if (items.length < s.pageSize) break;
    }
  }
  if (stores === 0) throw new Error(`Couldn't find a store page with products on this site — is it a ${preset.name} store?`);
  return { products: all, folderNames, storeTitles: stores > 1 ? titles : titles.map(() => "") };
}

/** Detection and listing ask for some of the same addresses — each is fetched once. */
function rememberResponses(pf: PoliteFetch): PoliteFetch {
  const seen = new Map<string, Promise<Response>>();
  return async (url) => {
    let first = seen.get(url);
    if (!first) seen.set(url, (first = pf(url)));
    return (await first).clone() as Response;
  };
}

const EXT_BY_TYPE: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif" };

function photoExtension(res: Response, url: string): string | null {
  const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (EXT_BY_TYPE[type]) return EXT_BY_TYPE[type]!;
  const m = /\.(jpe?g|png|webp|gif|avif)(?:$|\?)/i.exec(new URL(url).pathname);
  return m ? m[1]!.toLowerCase().replace("jpeg", "jpg") : null;
}

export interface ImportOptions {
  /** Store address; for a saved-page import it may be empty (the page says where it came from). */
  input: string;
  /** A preset id, or "auto" to probe each platform in turn. */
  presetId: string;
  /** The saved store pages, for a "saved-page" preset — one per page of the product list. */
  savedHtml?: string[];
  /** Parent folder; the store's own subfolder is created inside it. */
  outputRoot: string;
  /**
   * Leave the SKU column empty. Some stores fill the SKU field with
   * something else (stock counts, weights) that shouldn't show up in the
   * catalog as an article number.
   */
  skipSku?: boolean;
  pf: PoliteFetch;
  photoConcurrency: number;
  onProgress: (p: Progress) => void;
}

export interface PageCoverage {
  saved: number[];
  /** Pages known to exist (linked from a saved page) that weren't saved. */
  missing: PageLink[];
  /**
   * The highest saved page still has a "Next" link: more pages exist past
   * it, but the pagination only shows a window of numbers, so how many
   * isn't knowable from the saved files.
   */
  moreAfter: number | null;
}

interface Collected {
  platform: string;
  /** The store's address — its origin, or the full page URL for a store under a shared host. */
  storeUrl: string;
  items: ImportedItem[];
  pages: PageCoverage | null;
}

async function collectFromFeed(input: string, presetId: string, politeFetch: PoliteFetch, onProgress: (p: Progress) => void): Promise<Collected> {
  const pf = rememberResponses(politeFetch);
  const origin = normalizeStoreUrl(input);
  const hostPreset = savedPagePresetForHost(new URL(origin).hostname);
  if (hostPreset) throw new Error(`${hostPreset.name} store — choose ${hostPreset.name} as the platform and pick the saved page instead.`);
  let preset: JsonFeedPreset | null;
  if (presetId === "auto") {
    onProgress({ stage: "detecting" });
    preset = await detectPreset(origin, pf);
    if (!preset) throw new Error("Couldn't recognize the store's platform — none of the supported product feeds answered. Try picking the platform by hand.");
  } else {
    const p = getPreset(presetId);
    if (!p || p.kind !== "json-feed") throw new Error(`Unknown platform "${presetId}".`);
    preset = p;
  }
  const { products: raw, folderNames, storeTitles } = await fetchAllProducts(origin, preset, pf, onProgress);
  if (raw.length === 0) throw new Error("The store's product feed is empty.");
  const feed = preset;
  const items = raw.map((p, i) => {
    const item = mapProduct(p, feed, origin, folderNames);
    if (!item.folder) item.folder = storeTitles[i] ?? "";
    return item;
  });
  return { platform: feed.name, storeUrl: origin, items, pages: null };
}

async function collectFromSavedPage(pages: string[], preset: SavedPagePreset, input: string): Promise<Collected> {
  if (pages.length === 0) throw new Error(`Pick the saved ${preset.name} page (or pages) first.`);
  // The store's own address is the shortest saved-from URL — page 1 is
  // payhip.com/Store, later pages payhip.com/Store/collection/all?page=16,
  // and the files can be picked in any order.
  const savedFrom = pages.map(savedPageUrl).filter((u): u is string => !!u).sort((a, b) => new URL(a).pathname.length - new URL(b).pathname.length);
  const firstUrl = savedFrom[0] ?? (input.trim() ? normalizeStoreUrl(input) : null);
  if (!firstUrl) throw new Error("Couldn't tell which store these pages were saved from — enter the store's address too.");
  const base = new URL(firstUrl);
  const absolute = (u: string | undefined, pageUrl: URL) => {
    if (!u) return "";
    try {
      return new URL(u, pageUrl).toString();
    } catch {
      return "";
    }
  };

  const items: ImportedItem[] = [];
  const seen = new Set<string>();
  const linked = new Map<number, string>();
  const saved = new Map<number, boolean>(); // page number -> has a "Next" link
  for (const html of pages) {
    const pageUrl = new URL(savedPageUrl(html) ?? base.toString());
    const { cards, pageLinks, current, hasNext } = await extractCards(html, preset);
    saved.set(current ?? 1, hasNext);
    for (const l of pageLinks) linked.set(l.number, absolute(l.href, pageUrl));
    for (const c of cards) {
      const buyUrl = absolute(c.buyUrl, pageUrl);
      const key = buyUrl || `${c.name}|${c.image}`;
      if (seen.has(key)) continue; // the same page picked twice, or a product shown on two pages
      seen.add(key);
      items.push({
        name: c.name ?? "",
        sku: c.sku ?? "",
        description: c.description ?? "",
        folder: c.folder ?? "",
        price: c.price ?? "",
        buyUrl,
        imageUrl: absolute(c.image, pageUrl) || null,
      });
    }
  }
  if (items.length === 0) throw new Error(`No ${preset.name} products found in those files — are they the store's product pages, saved as "Webpage, HTML only"?`);

  const savedNumbers = [...saved.keys()].sort((a, b) => a - b);
  const highest = savedNumbers[savedNumbers.length - 1]!;
  const known = Math.max(highest, ...linked.keys());
  const missing: PageLink[] = [];
  for (let n = 1; n <= known; n++) if (!saved.has(n)) missing.push({ number: n, href: linked.get(n) ?? "" });
  const coverage: PageCoverage = { saved: savedNumbers, missing, moreAfter: saved.get(highest) && known === highest ? highest : null };
  return { platform: preset.name, storeUrl: `${base.origin}${base.pathname.replace(/\/+$/, "")}`, items, pages: coverage };
}

export async function runImport(opts: ImportOptions): Promise<ImportReport> {
  const chosen = opts.presetId === "auto" ? undefined : getPreset(opts.presetId);
  const { platform, storeUrl, items, pages } =
    chosen?.kind === "saved-page"
      ? await collectFromSavedPage(opts.savedHtml ?? [], chosen, opts.input)
      : await collectFromFeed(opts.input, opts.presetId, opts.pf, opts.onProgress);
  const noFolder = fillMissingFolders(items);
  const skuSkipped = opts.skipSku === true;
  if (skuSkipped) for (const it of items) it.sku = "";

  const outDir = join(opts.outputRoot, outputFolderName(storeUrl));
  const photosDir = join(outDir, "photos");
  // A re-import replaces the previous snapshot whole: a product removed
  // from the store must not keep its old photo under a number that now
  // belongs to a different product.
  rmSync(photosDir, { recursive: true, force: true });
  mkdirSync(photosDir, { recursive: true });

  const noPhoto: number[] = [];
  const photoFailed: number[] = [];
  let done = 0;
  const withPhoto = items.filter((it) => it.imageUrl).length;
  opts.onProgress({ stage: "photos", done: 0, total: withPhoto });
  await mapLimit(items, opts.photoConcurrency, async (it, i) => {
    const no = i + 1;
    if (!it.imageUrl) {
      noPhoto.push(no);
      return;
    }
    try {
      const res = await opts.pf(it.imageUrl);
      const ext = res.ok ? photoExtension(res, it.imageUrl) : null;
      if (!ext) photoFailed.push(no);
      else writeFileSync(join(photosDir, `${no}.${ext}`), new Uint8Array(await res.arrayBuffer()));
    } catch {
      photoFailed.push(no);
    }
    opts.onProgress({ stage: "photos", done: ++done, total: withPhoto });
  });

  opts.onProgress({ stage: "writing" });
  const csvPath = join(outDir, "catalog.csv");
  writeFileSync(csvPath, toCsv(items));

  const nos = (pred: (it: ImportedItem) => boolean) => items.flatMap((it, i) => (pred(it) ? [i + 1] : []));
  return {
    platform,
    origin: storeUrl,
    products: items.length,
    folders: [...new Set(items.map((it) => it.folder))],
    noPhoto: noPhoto.sort((a, b) => a - b),
    photoFailed: photoFailed.sort((a, b) => a - b),
    noSku: skuSkipped ? [] : nos((it) => !it.sku),
    skuSkipped,
    noPrice: nos((it) => !it.price),
    noFolder,
    pages,
    outDir,
    csvPath,
    photosDir,
  };
}

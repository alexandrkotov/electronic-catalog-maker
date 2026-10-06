import { select, selectAll, selectText } from "./jsonPath";
import type { JsonFeedPreset } from "./presets";

/** One product, ready to become one Grid Composer row. */
export interface ImportedItem {
  name: string;
  sku: string;
  description: string;
  folder: string;
  price: string;
  buyUrl: string;
  /** null = the store has no photo for it (Composer then draws a "No photo" tile). */
  imageUrl: string | null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/** Product descriptions are shop-authored HTML: keep the words and paragraph breaks, drop everything else. */
export function stripHtml(html: string): string {
  const text = html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(text)
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/** Cuts at a word boundary and marks the cut, so a tile's description never ends mid-word. */
export function truncate(text: string, max: number): string {
  if (max <= 0 || text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function toNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function formatAmount(n: number): string {
  return n.toFixed(2);
}

export function extractPrice(product: unknown, rule: JsonFeedPreset["price"]): string {
  let raw = selectAll(product, rule.path);
  if (rule.sale) {
    const flags = selectAll(product, rule.sale.flag);
    const sale = selectAll(product, rule.sale.path);
    if (flags.length === raw.length && sale.length === raw.length) raw = raw.map((v, i) => (flags[i] === true ? sale[i] : v));
  }
  let values = raw.map(toNumber).filter((n): n is number => n !== null);
  if (rule.minorUnitsPath) {
    const minor = toNumber(select(product, rule.minorUnitsPath)) ?? 0;
    values = values.map((n) => n / 10 ** minor);
  }
  if (values.length === 0) return "";
  if (rule.mode === "first") return formatAmount(values[0]!);
  const min = Math.min(...values);
  const max = Math.max(...values);
  return min === max ? formatAmount(min) : `${formatAmount(min)}–${formatAmount(max)}`;
}

export function buildUrl(template: string, product: unknown, origin: string): string {
  let missing = false;
  const url = template.replace(/\{(\w+)\}/g, (_, key: string) => {
    if (key === "origin") return origin;
    const v = selectText(product, key);
    if (!v) missing = true;
    return encodeURIComponent(v).replace(/%2F/gi, "/").replace(/%3A/gi, ":");
  });
  return missing ? "" : url;
}

/** Makes a feed's photo URL absolute (Shopify's are sometimes protocol-relative) and applies the preset's resize query. */
export function resolveImageUrl(raw: string, origin: string, query: Record<string, string>): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw.startsWith("//") ? `https:${raw}` : raw, origin);
  } catch {
    return null;
  }
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return url.toString();
}

/** `folderNames`: category id -> name, for a preset with a `folderNames` rule (see collectFolderNames in importer.ts). */
export function mapProduct(product: unknown, preset: JsonFeedPreset, origin: string, folderNames?: Map<string, string>): ImportedItem {
  const f = preset.fields;
  const rawDescription = selectText(product, f.description);
  const clean = preset.clean.description;
  const description = truncate(clean.stripHtml ? stripHtml(rawDescription) : rawDescription.trim(), clean.maxLength);
  const names = preset.folderNames;
  const rawFolder = selectText(product, f.folder);
  const folder = names ? (folderNames?.get(rawFolder) ?? (names.fallback ? selectText(product, names.fallback) : "")) : rawFolder;
  return {
    name: decodeEntities(selectText(product, f.name)),
    sku: selectText(product, f.sku),
    description,
    folder: decodeEntities(folder),
    price: extractPrice(product, preset.price),
    buyUrl: buildUrl(preset.buyUrl, product, origin),
    imageUrl: resolveImageUrl(selectText(product, f.image), origin, preset.imageQuery),
  };
}

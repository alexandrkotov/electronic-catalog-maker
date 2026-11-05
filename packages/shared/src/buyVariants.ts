import type { CatalogRow } from "./types.js";

/**
 * Several store products behind ONE table row — "buy variants".
 *
 * One part number sold in several conditions — new, overhauled, used
 * serviceable, as removed — each with its own store listing. A single
 * `buy_url` would have to pick one for the visitor. Instead the row's extra
 * holds `buy_variants`: a JSON array (stored as a string, like every extra
 * value) of
 *
 *     { "sku": "A-100-OH", "name": "...", "description": "...", "buy_url": "https://..." }
 *
 * Different part numbers at one position of the drawing (by model, power or
 * serial number) are callout rows instead (callout.ts): each number gets a
 * row of its own, so it is searched, printed and looked up in Where to buy.
 *
 * The viewer then shows "Choose variant (N)" in place of Add to cart and lets
 * the visitor pick one explicitly; nothing is ever selected automatically. A
 * chosen variant goes into the cart as its own item (see variantCartKey) and
 * checks out through the same buy_url rules as any other row.
 */

export const BUY_VARIANTS_KEY = "buy_variants";

export interface BuyVariant {
  sku: string;
  name: string;
  description: string;
  buyUrl: string;
}

/** Whether `value` is an absolute http(s) link — a variant without one has nowhere to go and is dropped. */
function isWebUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/** The row's variants, or [] when it has none or the value is not what is documented above. A repeated sku keeps its first entry. */
export function parseBuyVariants(extra: Record<string, string>): BuyVariant[] {
  const raw = extra[BUY_VARIANTS_KEY];
  if (typeof raw !== "string" || raw.trim() === "") return [];
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: BuyVariant[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const v = item as Record<string, unknown>;
    if (typeof v.sku !== "string" || v.sku.trim() === "" || typeof v.buy_url !== "string" || !isWebUrl(v.buy_url)) continue;
    if (seen.has(v.sku)) continue;
    seen.add(v.sku);
    out.push({
      sku: v.sku,
      name: typeof v.name === "string" ? v.name : "",
      description: typeof v.description === "string" ? v.description : "",
      buyUrl: v.buy_url,
    });
  }
  return out;
}

/** The cart item key of one variant. The same sku listed on several rows is one item (the cart holds products, not positions). */
export function variantCartKey(sku: string): string {
  return `variant:${sku}`;
}

/**
 * The rows the cart is made of: every row without variants as it is, and each
 * row with variants replaced by one row per variant — `url` is its cart key,
 * `sku`/`name`/`description` are the variant's (the row's own name when the
 * variant has none) and `extra.buy_url` is the variant's link. A sku seen
 * twice appears once.
 */
export function expandVariantRows(rows: CatalogRow[]): CatalogRow[] {
  const out: CatalogRow[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const variants = parseBuyVariants(row.extra);
    if (variants.length === 0) {
      out.push(row);
      continue;
    }
    const { [BUY_VARIANTS_KEY]: _dropped, ...rest } = row.extra;
    for (const v of variants) {
      const key = variantCartKey(v.sku);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...row, url: key, sku: v.sku, name: v.name || row.name, description: v.description, extra: { ...rest, buy_url: v.buyUrl } });
    }
  }
  return out;
}

/** Whether the row has a store link of its own or variants to choose between. */
export function rowHasBuyTarget(row: CatalogRow): boolean {
  return (typeof row.extra.buy_url === "string" && row.extra.buy_url.trim() !== "") || parseBuyVariants(row.extra).length > 0;
}

/** Whether anything in the catalog can be added to a cart — a row's buy_url, or a row's variants. */
export function catalogHasAnyBuyTarget(rows: CatalogRow[]): boolean {
  return rows.some(rowHasBuyTarget);
}

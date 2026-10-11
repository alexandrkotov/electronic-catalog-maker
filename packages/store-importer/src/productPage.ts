import { decodeEntities, stripHtml, truncate, type ImportedItem } from "./normalize";
import type { ProductPagesPreset } from "./presets";

/**
 * Reads one product out of its own page in the store, from the schema.org
 * markup shops put there for search engines (a `Product` in a
 * `<script type="application/ld+json">` block). That markup is the same on
 * every platform, so a "product-pages" preset only has to say where the
 * product addresses are listed.
 */

type Ld = Record<string, unknown>;

function isType(node: Ld, type: string): boolean {
  const t = node["@type"];
  return t === type || (Array.isArray(t) && t.includes(type));
}

/** The first Product in a parsed block: the block itself, one of a list, or inside its `@graph`. */
function findProduct(value: unknown): Ld | null {
  if (Array.isArray(value)) {
    for (const v of value) {
      const found = findProduct(v);
      if (found) return found;
    }
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const node = value as Ld;
  return isType(node, "Product") ? node : findProduct(node["@graph"]);
}

/** The page's schema.org Product, or null when it has none (a removed product's page, a login wall). */
export function productMarkup(html: string): unknown {
  for (const m of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const product = findProduct(JSON.parse(m[1]!));
      if (product) return product;
    } catch {
      // a block that isn't valid JSON — some themes print one; the product is usually in another
    }
  }
  return null;
}

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

function text(v: unknown): string {
  return typeof v === "string" || typeof v === "number" ? decodeEntities(String(v)).trim() : "";
}

function amount(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v.replace(/,/g, "")) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Every price the markup names: one per offer, or an AggregateOffer's lowest and highest. */
function prices(product: Ld): number[] {
  return list(product.offers).flatMap((o) => {
    if (o === null || typeof o !== "object") return [];
    const offer = o as Ld;
    const own = [offer.price, offer.lowPrice, offer.highPrice].map(amount).filter((n): n is number => n !== null);
    // newer markup keeps the price one level down, in a priceSpecification
    const spec = list(offer.priceSpecification).map((s) => amount((s as Ld | null)?.price)).filter((n): n is number => n !== null);
    return own.length > 0 ? own : spec;
  });
}

/** A photo is a plain address or an ImageObject; the first one is the product's main photo. */
function firstImage(product: Ld): string {
  for (const img of list(product.image)) {
    if (typeof img === "string") return img;
    if (img && typeof img === "object") {
      const o = img as Ld;
      const url = text(o.contentUrl) || text(o.url);
      if (url) return url;
    }
  }
  return "";
}

export function mapPageProduct(markup: unknown, preset: ProductPagesPreset, pageUrl: string): ImportedItem {
  const product = markup as Ld;
  const offers = list(product.offers) as (Ld | null)[];
  const values = prices(product);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const clean = preset.clean.description;
  const rawDescription = typeof product.description === "string" ? product.description : "";
  let imageUrl: string | null = null;
  try {
    const raw = firstImage(product);
    if (raw) {
      const absolute = new URL(raw.startsWith("//") ? `https:${raw}` : raw, pageUrl).toString();
      imageUrl = preset.imageSize ? absolute.replace(new RegExp(preset.imageSize.pattern), preset.imageSize.replace) : absolute;
    }
  } catch {
    // an address that can't be read as one — the product goes in without a photo
  }
  return {
    name: text(product.name),
    sku: text(product.sku) || text(offers[0]?.sku),
    description: truncate(clean.stripHtml ? stripHtml(rawDescription) : decodeEntities(rawDescription).trim(), clean.maxLength),
    folder: text(product.category),
    price: values.length === 0 ? "" : min === max ? min.toFixed(2) : `${min.toFixed(2)}–${max.toFixed(2)}`,
    buyUrl: pageUrl,
    imageUrl,
  };
}

import type { CatalogMeta, CatalogRow } from "./types.js";

/**
 * Pulls an item id out of a row's buy_url using the catalog's own
 * cart_id_pattern (see schema.ts DEFAULT_CART_ID_PATTERN and CatalogMeta),
 * so several rows can be combined into one multi-item checkout — see
 * buildCartCheckoutUrl. Returns null for anything that doesn't match (a
 * different/unrecognized store, no buy_url at all, or a malformed saved
 * pattern), which is the signal for that row to fall back to a single-item
 * instant-navigate Buy button instead.
 */
export function parseCartItemId(buyUrl: string, cartIdPattern: string): string | null {
  let re: RegExp;
  try {
    re = new RegExp(cartIdPattern);
  } catch {
    return null; // malformed regex saved via the editor's Store settings dialog
  }
  const m = re.exec(buyUrl);
  return m?.[1] ?? null;
}

/**
 * Builds the combined checkout URL for several cart item ids, using the
 * catalog's own cart_item_param/cart_checkout_base_url (see schema.ts).
 */
export function buildCartCheckoutUrl(ids: string[], cartItemParam: string, cartCheckoutBaseUrl: string): string {
  const itemsParams = ids.map((id) => cartItemParam.replaceAll("{id}", encodeURIComponent(id))).join("&");
  return `${cartCheckoutBaseUrl}${itemsParams}`;
}

/**
 * The "instant, single item" checkout link for one row's buy_url — used by
 * the PDF export's QR codes (see pdfExport.ts), which must always jump
 * straight to a one-item checkout regardless of the catalog's own
 * cart_mode: a printed QR code has no "keep shopping" cart to add to, so
 * there's nothing to accumulate into. A buy_url that matches the catalog's
 * cart_id_pattern gets run through the same combine logic the toolbar Cart
 * button uses, just with a single id; anything that doesn't match is
 * already a direct single-item link (same fallback rowHtml/actionOpenCart
 * use), so it's returned unchanged.
 */
export function buildInstantBuyUrl(
  buyUrl: string,
  meta: Pick<CatalogMeta, "cartIdPattern" | "cartItemParam" | "cartCheckoutBaseUrl">,
): string {
  const id = parseCartItemId(buyUrl, meta.cartIdPattern);
  if (id === null) return buyUrl;
  return buildCartCheckoutUrl([id], meta.cartItemParam, meta.cartCheckoutBaseUrl);
}

/**
 * Whether any row in the catalog has a buy_url at all — used by the "Export
 * PDF…" options dialog (see pdfExportOptions.ts) to gray out its QR
 * placement question entirely when there's nothing for it to affect: a
 * catalog with no store links anywhere gets no QR codes no matter which
 * placement is picked, on-image or in the table.
 */
export function catalogHasAnyBuyUrl(rows: CatalogRow[]): boolean {
  return rows.some((r) => typeof r.extra.buy_url === "string" && r.extra.buy_url.trim());
}

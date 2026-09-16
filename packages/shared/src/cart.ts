import type { CatalogMeta, CatalogRow } from "./types.js";

/**
 * Pulls an item id out of a row's buy_url using the catalog's own
 * cart_id_pattern (see schema.ts DEFAULT_CART_ID_PATTERN and CatalogMeta),
 * so several rows can be combined into one multi-item checkout — see
 * buildCartCheckoutUrl. Returns null for anything that doesn't match (a
 * different/unrecognized store, no buy_url at all, or a malformed saved
 * pattern) — under cart_mode "accumulate" that row still goes into the
 * cart, it just opens on its own instead of being merged (see
 * actionOpenCart in viewerEngine.ts).
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

/**
 * Identifies "this catalog" for cart persistence (see loadPersistedCart/
 * savePersistedCart) — combines the source name (the URL/file basename it
 * was opened from, see openBytes' `sourceName` param in viewerEngine.ts)
 * with the catalog's own display name, so two different catalogs saved
 * under a generic filename don't collide, and opening a different catalog
 * doesn't surface someone else's saved cart. Not a cryptographic identity,
 * just enough to keep casual per-catalog carts from leaking into each other
 * in the same browser.
 */
export function cartStorageKey(sourceName: string, catalogName: string): string {
  return `ecm-viewer-cart:${sourceName}::${catalogName}`;
}

/**
 * Loads a previously saved cart for this catalog (see cartStorageKey) —
 * this is what lets a cart survive closing the tab/app entirely, e.g.
 * someone adding parts to the cart while completely offline (no signal at
 * all) who won't check out until they're back in range. Never throws: an
 * unavailable or corrupted localStorage entry just means starting from an
 * empty cart, same as before this feature existed.
 */
export function loadPersistedCart(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) return new Set(parsed);
    }
  } catch {
    // Unavailable or corrupted storage (privacy mode, etc.) — start from an empty cart instead.
  }
  return new Set();
}

/** Saves the current cart for this catalog (see cartStorageKey) — called after every add/remove. */
export function savePersistedCart(key: string, items: Set<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...items]));
  } catch {
    // Cart still works for this session, just won't survive a reload.
  }
}

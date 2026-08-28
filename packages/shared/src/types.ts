export interface CatalogImage {
  id: number;
  name: string;
  mimeType: string;
  /** base64-encoded image bytes, no `data:` prefix */
  imageData: string;
  width: number;
  height: number;
  sortOrder: number;
  /** Free-form grouping label for the two-level image list; "" = ungrouped. */
  folder: string;
}

export interface CatalogLink {
  /** the hotspot's own identity — always unique, this is what a click centers on */
  id: number;
  imageId: number;
  /** label shown on the image at the hotspot; not required to be unique */
  name: string;
  /**
   * join key against CatalogRow.url. Not required to be unique — multiple hotspots
   * legitimately share one url when the same part is drawn at several positions on
   * one exploded diagram (common in the legacy .sch catalogs this format succeeds).
   */
  url: string;
  top: number;
  left: number;
  fontSize: number;
}

export interface CatalogRow {
  id: number;
  imageId: number;
  /** matches a CatalogLink.url on the same image */
  url: string;
  name: string;
  sku: string;
  description: string;
  /** free-form characteristics that vary per catalog/image, e.g. { "weight": "2.3 kg" } */
  extra: Record<string, string>;
}

export interface CatalogMeta {
  schemaVersion: number;
  catalogName: string;
  createdBy: string;
  createdAt: string;
  /** Free-form, for the catalog author's own reference — not parsed or validated. */
  storeUrl: string;
  /**
   * How the viewer's Buy button behaves for rows whose extra.buy_url can be
   * combined into one multi-item checkout (currently: Payhip direct-checkout
   * links) — "accumulate" (default): Buy adds to a shared cart, a toolbar
   * button opens one combined checkout. "instant": Buy always opens that
   * row's own buy_url right away, same as any other/unrecognized store link,
   * and never turns into a green "In cart" state. Rows whose buy_url can't be
   * combined always behave as instant, regardless of this setting.
   */
  cartMode: "accumulate" | "instant";
  /** See schema.ts DEFAULT_CART_ID_PATTERN for what these three describe. */
  cartIdPattern: string;
  cartItemParam: string;
  cartCheckoutBaseUrl: string;
}

/**
 * A non-fatal heads-up that a link's name/url matches another hotspot elsewhere in
 * the catalog. Not an error — this is legitimate (see CatalogLink.url), so callers
 * surface it as a confirmable warning rather than blocking the save.
 */
export interface LinkConflict {
  field: "name" | "url";
  value: string;
  /** id of the other, already-existing link that shares this name/url */
  conflictingLinkId: number;
}

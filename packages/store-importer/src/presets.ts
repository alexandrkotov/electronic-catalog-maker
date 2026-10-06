import payhip from "./presets/payhip.json";
import shopify from "./presets/shopify.json";
import squarespace from "./presets/squarespace.json";

/**
 * A preset is plain JSON (src/presets/*.json), so adding a platform is a
 * data change an outside contributor can make without touching the engine.
 * Two kinds:
 *  - "json-feed": the store serves a public product feed the importer
 *    pages through itself — Shopify, Squarespace (paths are jsonPath.ts paths, relative to one
 *    product; `source.itemsPath`/`detect.expectArray` to a whole page).
 *  - "saved-page": the platform blocks automated access, so the person
 *    saves their store page from their own browser and the importer reads
 *    the product cards out of that HTML with CSS selectors.
 */
export interface JsonFeedPreset {
  id: string;
  name: string;
  kind: "json-feed";
  /**
   * For a platform whose feed lives on the store page rather than at a fixed
   * address (Squarespace: /shop on one site, /store on another): `pattern`
   * is run over the text at `path`, and every distinct first capture group
   * is one store page — the `{store}` in `detect.path`/`source.path`. A site
   * with several store pages gets them all imported.
   *
   * `fallbackPattern` is tried when `pattern` finds nothing (older Squarespace
   * sites have no "/p/" in a product's address, so a store page looks like
   * any other section there): its captures are only guesses, each asked for
   * its feed and kept if `source.only` holds.
   */
  discover?: { path: string; pattern: string; fallbackPattern?: string };
  /** One cheap request that tells whether a store runs this platform. */
  detect: { path: string; expectArray: string };
  source: {
    /** Appended to the store's origin. */
    path: string;
    query: Record<string, string>;
    /** Where the page's product array sits ("" = the response itself). */
    itemsPath: string;
    /** Hard stop, so a feed that ignores the page parameter can't loop forever. */
    maxPages: number;
    /** A response counts as a product list only if the value at `path` is `equals` (a Squarespace blog answers `?format=json` with `items` too). */
    only?: { path: string; equals: string };
    /**
     * Where a response names its store page ("Stickers", "Gift bags"). On a
     * site with several store pages, a product without a category takes this
     * as its folder; with a single store page it's left alone.
     */
    storeTitle?: string;
  } & (
    | {
        pageParam: string;
        firstPage: number;
        /** A page shorter than this is the last one. */
        pageSize: number;
      }
    /** The response itself says where the next page starts: the value at `path` goes into `param`; no value = last page. */
    | { cursor: { param: string; path: string } }
  );
  /** `imageFallback`: where to look when `image` has nothing (a Squarespace product's photos are its gallery; one without a gallery has only its own, sometimes blank, asset). */
  fields: { name: string; sku: string; description: string; folder: string; image: string; imageFallback?: string };
  /**
   * For a feed whose products carry a category id rather than its name:
   * `fields.folder` then points at the id, and the names come from a
   * category tree in the same response (`path` = every top-level category).
   * A nested category resolves to its top-level ancestor — one Composer grid
   * per main category, not one per leaf. `fallback` is where a product
   * carries the category's name directly, for feeds without the tree.
   */
  folderNames?: { path: string; id: string; name: string; children: string; fallback?: string };
  /**
   * A product with variants still gets one tile. "range" shows "19.00–35.00"
   * when variant prices differ, "first" only the first variant's price.
   */
  price: {
    path: string;
    mode: "range" | "first";
    minorUnitsPath?: string;
    /** Discounted variants: `flag` and `path` run parallel to `path` (one value per variant); where the flag is true, the sale price replaces the regular one. */
    sale?: { flag: string; path: string };
  };
  /** `{origin}` = the store's origin, `{field}` = that top-level product field. */
  buyUrl: string;
  /** Added to every photo URL — e.g. Shopify's CDN resizes on `width=`. */
  imageQuery: Record<string, string>;
  clean: { description: { stripHtml: boolean; maxLength: number } };
}

/** Where one value sits inside a product card: the first element matching `selector` (relative to the card; "" = the card itself). */
export interface CardField {
  selector: string;
  /** Take the element's text... */
  text?: boolean;
  /** ...or this attribute. */
  attr?: string;
  /** Keep only the first match of this regex (e.g. the original photo URL out of a srcset). */
  pattern?: string;
}

export interface SavedPagePreset {
  id: string;
  name: string;
  kind: "saved-page";
  /** A store address on one of these hosts goes straight to this preset. */
  hosts: string[];
  /** Shown next to the file picker, as a numbered list. */
  howToSave: { intro: string; steps: string[] };
  /** CSS selector of one product card. */
  card: string;
  /**
   * The page links under the product list ("First ‹ 2 3 4 Next ›"), so an
   * import can tell when the person saved only some of the pages. `link`
   * selects every link; the current page's own link points at "#";
   * `nextIcon` (inside a link) marks "Next" without relying on its wording.
   */
  pagination?: { link: string; nextIcon: string };
  fields: Partial<Record<"name" | "sku" | "description" | "folder" | "price" | "image" | "buyUrl", CardField>>;
}

export type Preset = JsonFeedPreset | SavedPagePreset;

export const PRESETS: Preset[] = [shopify as JsonFeedPreset, squarespace as JsonFeedPreset, payhip as SavedPagePreset];

export function getPreset(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}

/** The saved-page preset that owns this host, if any (payhip.com/... -> Payhip). */
export function savedPagePresetForHost(host: string): SavedPagePreset | undefined {
  const h = host.replace(/^www\./, "").toLowerCase();
  return PRESETS.find((p): p is SavedPagePreset => p.kind === "saved-page" && p.hosts.includes(h));
}

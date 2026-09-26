/**
 * Turns rendered grids into a .ecatm catalog: one image per grid, one
 * numbered hotspot per tile, one table row per item. Bare-number badges
 * mean the number goes into the table too (extra "No.", catalog-building
 * conventions rule 2).
 */
import {
  addImage,
  addLink,
  addRow,
  createEmptyCatalog,
  DEFAULT_CART_CHECKOUT_BASE_URL,
  DEFAULT_CART_ID_PATTERN,
  DEFAULT_CART_ITEM_PARAM,
  exportCatalog,
  updateStoreSettings,
  type SqlJsStatic,
} from "@ecm/shared";
import type { GridPlan } from "./plan.js";
import type { RenderedGrid } from "./render.js";

export interface BuiltGrid {
  plan: GridPlan;
  title: string;
  rendered: RenderedGrid;
}

/** Fitted whole on open only while it's short enough to stay legible that way. */
const FIT_ON_OPEN_MAX_HEIGHT = 1000;

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export async function buildCatalog(SQL: SqlJsStatic, catalogName: string, grids: BuiltGrid[]): Promise<Uint8Array> {
  const db = createEmptyCatalog(SQL, catalogName);
  updateStoreSettings(db, {
    catalogMode: "commercial",
    storeUrl: "",
    cartMode: "accumulate",
    cartIdPattern: DEFAULT_CART_ID_PATTERN,
    cartItemParam: DEFAULT_CART_ITEM_PARAM,
    cartCheckoutBaseUrl: DEFAULT_CART_CHECKOUT_BASE_URL,
    // A single grid needs no image list to pick from.
    defaultView: grids.length === 1 ? "diagram" : "images",
  });

  let sortOrder = 0;
  for (const { plan, title, rendered } of grids) {
    const imageId = addImage(db, {
      name: title,
      mimeType: "image/jpeg",
      imageData: await blobToBase64(rendered.jpeg),
      width: rendered.width,
      height: rendered.height,
      sortOrder: ++sortOrder,
      // Flat list in table order; a folder only groups the parts of a split one.
      folder: plan.parts > 1 ? plan.folder || catalogName : "",
      fitOnOpen: rendered.height <= FIT_ON_OPEN_MAX_HEIGHT,
    });
    plan.items.forEach(({ item, url }, i) => {
      const anchor = rendered.anchors[i]!;
      addLink(db, {
        imageId,
        name: String(item.no),
        url,
        top: anchor.top,
        left: anchor.left,
        fontSize: rendered.badgeFont,
      });
      addRow(db, {
        imageId,
        url,
        name: item.name,
        sku: item.sku,
        description: item.description,
        extra: { "No.": String(item.no), ...item.extra },
      });
    });
  }
  const bytes = exportCatalog(db);
  db.close();
  return bytes;
}

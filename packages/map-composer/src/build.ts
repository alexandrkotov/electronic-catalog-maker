/**
 * Turns the map picture and the points' pages into a .ecatm catalog: the
 * map is the first image, each point is a navigation hotspot on it leading
 * to that point's own image, and every point's image carries a "⌂" hotspot
 * back to the map. The map's geography goes into meta ("map", "map_points")
 * for a later live-map viewer; today's viewers never read those keys.
 */
import {
  addImage,
  addLink,
  createEmptyCatalog,
  DEFAULT_CART_CHECKOUT_BASE_URL,
  DEFAULT_CART_ID_PATTERN,
  DEFAULT_CART_ITEM_PARAM,
  exportCatalog,
  navLinkUrl,
  updateStoreSettings,
  type SqlJsStatic,
} from "@ecm/shared";
import { homeMarker, pointGeo, type MapMeta, type MapPoint, type MapPointMeta } from "./geo.js";
import type { RenderedImage } from "./render.js";

export interface BuiltPoint {
  point: MapPoint;
  /** Hotspot text on the map. */
  label: string;
  /** Hotspot position on the map picture, in its pixels. */
  left: number;
  top: number;
  page: RenderedImage;
}

export interface BuildInput {
  catalogName: string;
  map: RenderedImage;
  mapMeta: MapMeta;
  labelFont: number;
  points: BuiltPoint[];
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export async function buildCatalog(SQL: SqlJsStatic, input: BuildInput): Promise<Uint8Array> {
  const db = createEmptyCatalog(SQL, input.catalogName);
  updateStoreSettings(db, {
    catalogMode: "commercial",
    storeUrl: "",
    cartMode: "accumulate",
    cartIdPattern: DEFAULT_CART_ID_PATTERN,
    cartItemParam: DEFAULT_CART_ITEM_PARAM,
    cartCheckoutBaseUrl: DEFAULT_CART_CHECKOUT_BASE_URL,
    // Straight to the map: it is the catalog's menu.
    defaultView: "diagram",
  });

  let sortOrder = 0;
  const mapImageId = addImage(db, {
    name: input.catalogName,
    mimeType: input.map.mimeType,
    imageData: await blobToBase64(input.map.blob),
    width: input.map.width,
    height: input.map.height,
    sortOrder: ++sortOrder,
    fitOnOpen: true,
  });

  const pointsMeta: MapPointMeta[] = [];
  for (const { point, label, left, top, page } of input.points) {
    const name = point.name.trim() || label;
    const imageId = addImage(db, {
      name,
      mimeType: page.mimeType,
      imageData: await blobToBase64(page.blob),
      width: page.width,
      height: page.height,
      sortOrder: ++sortOrder,
      fitOnOpen: true,
    });
    const linkId = addLink(db, { imageId: mapImageId, name: label, url: navLinkUrl(imageId), top, left, fontSize: input.labelFont });
    const home = homeMarker(page);
    addLink(db, { imageId, name: "⌂", url: navLinkUrl(mapImageId), top: home.top, left: home.left, fontSize: home.fontSize });
    pointsMeta.push({ linkId, imageId, name, geo: pointGeo(point) });
  }

  const stmt = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  stmt.run(["map", JSON.stringify(input.mapMeta)]);
  stmt.run(["map_points", JSON.stringify(pointsMeta)]);
  stmt.free();

  const bytes = exportCatalog(db);
  db.close();
  return bytes;
}

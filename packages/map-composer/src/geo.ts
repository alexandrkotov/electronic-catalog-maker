/**
 * The map composer's pure geometry: where a map point lands on the exported
 * picture, where the "⌂" back marker sits on a point's page, and the map
 * metadata stored in the catalog for a later live-map viewer.
 */

export interface MapPoint {
  id: number;
  name: string;
  lng: number;
  lat: number;
}

/** A point's position on the map as shown, in CSS pixels of the map's container. */
export interface ScreenPosition {
  x: number;
  y: number;
}

export interface ImageSize {
  width: number;
  height: number;
}

export type LabelKind = "name" | "number";
export type LabelSize = "small" | "medium" | "large";

const LABEL_SCALE: Record<LabelSize, number> = { small: 0.75, medium: 1, large: 1.35 };

/** Hotspot text of the n-th point (1-based) on the map. */
export function pointLabel(point: MapPoint, n: number, kind: LabelKind): string {
  return kind === "number" ? String(n) : point.name.trim() || String(n);
}

/**
 * Hotspot font size in picture pixels: 22px on a 1536px-wide picture at
 * "medium", the size of the hand-built "Shop the look" demo's markers.
 */
export function labelFontSize(imageWidth: number, size: LabelSize): number {
  return Math.max(10, Math.round((imageWidth / 1536) * 22 * LABEL_SCALE[size]));
}

/**
 * Picture pixels of a point shown at `pos` in a `container`-sized map whose
 * canvas is `image` pixels — the canvas is the container times the map's
 * pixel ratio, so the hotspot stays on its point at any ratio.
 */
export function toImagePixels(pos: ScreenPosition, container: ImageSize, image: ImageSize): { left: number; top: number } {
  return {
    left: Math.round((pos.x / container.width) * image.width),
    top: Math.round((pos.y / container.height) * image.height),
  };
}

/**
 * Pixel ratio the map is drawn at: 2 on a desktop-wide map, more on a narrow
 * (phone) one, so the picture comes out about `targetWidth` wide on any
 * screen. Depends on the map's size only, never on the device's own ratio.
 */
export function mapPixelRatio(containerWidth: number, targetWidth = 1784): number {
  if (containerWidth <= 0) return 2;
  return Math.min(4, Math.max(2, Math.round((targetWidth / containerWidth) * 100) / 100));
}

/**
 * CSS font size of a marker previewed on a `containerWidth`-wide map, for a
 * hotspot of `fontSize` picture pixels: the viewer shrinks the hotspot with
 * the picture but scales it back up to 1.8x (viewerEngine's --marker-scale).
 */
export function previewFontSize(fontSize: number, containerWidth: number, imageWidth: number): number {
  if (containerWidth <= 0 || imageWidth <= 0) return fontSize;
  const zoom = containerWidth / imageWidth;
  return fontSize * zoom * Math.max(1, Math.min(1 / zoom, 1.8));
}

export function isInside(pos: ScreenPosition, container: ImageSize): boolean {
  return pos.x >= 0 && pos.y >= 0 && pos.x <= container.width && pos.y <= container.height;
}

/**
 * The "⌂" back-to-the-map marker of a point's page: top-left corner, same
 * proportions as on the "Shop the look" demo (80px in, 60px font on a
 * 1536x1024 picture), scaled to the page's shorter side.
 */
export function homeMarker(page: ImageSize): { left: number; top: number; fontSize: number } {
  const scale = Math.min(page.width, page.height) / 1024;
  const inset = Math.round(80 * scale);
  return { left: inset, top: inset, fontSize: Math.max(14, Math.round(60 * scale)) };
}

/** Size a photo is stored at: its own, or scaled down so the longer side is `maxSide`. */
export function fitWithin(size: ImageSize, maxSide: number): ImageSize {
  const longer = Math.max(size.width, size.height);
  if (longer <= maxSide) return { width: size.width, height: size.height };
  const k = maxSide / longer;
  return { width: Math.max(1, Math.round(size.width * k)), height: Math.max(1, Math.round(size.height * k)) };
}

export const MAP_ATTRIBUTION = "© OpenStreetMap contributors · © OpenMapTiles · OpenFreeMap";

/** meta "map": what the exported picture shows, enough to rebuild it as a live map. */
export interface MapMeta {
  source: "osm";
  attribution: string;
  style: string;
  /** [minLng, minLat, maxLng, maxLat] */
  bbox: [number, number, number, number];
  center: [number, number];
  zoom: number;
  imageSize: [number, number];
}

/** meta "map_points": one entry per point, tied to its hotspot and its page. */
export interface MapPointMeta {
  linkId: number;
  imageId: number;
  name: string;
  geo: { lat: number; lng: number };
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export function mapMeta(input: {
  style: string;
  west: number;
  south: number;
  east: number;
  north: number;
  centerLng: number;
  centerLat: number;
  zoom: number;
  image: ImageSize;
}): MapMeta {
  return {
    source: "osm",
    attribution: MAP_ATTRIBUTION,
    style: input.style,
    bbox: [round6(input.west), round6(input.south), round6(input.east), round6(input.north)],
    center: [round6(input.centerLng), round6(input.centerLat)],
    zoom: Math.round(input.zoom * 100) / 100,
    imageSize: [input.image.width, input.image.height],
  };
}

export function pointGeo(point: MapPoint): { lat: number; lng: number } {
  return { lat: round6(point.lat), lng: round6(point.lng) };
}

export function fileStem(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, " ").trim() || "catalog";
}

/**
 * The "view" of a catalog: which image is shown, which hotspot is selected,
 * how far it is zoomed and where it is scrolled, and an optional highlighted
 * rectangle. One plain object that a host application can store (bookmarks,
 * links, QR codes), hand back to the viewer (`setView`) and receive from it
 * (`getView`, the "view" event). Format version `v: 1`.
 *
 * Everything geometric is a fraction of the image, never pixels, so the same
 * view reproduces in a window of any size. No DOM in here — the math is pure
 * so it can be tested and reused on a server.
 */
export interface EcatmView {
  v: 1;
  imageId: number;
  /** The selected hotspot. */
  linkId?: number;
  /**
   * 1 = the whole image fitted into the window (what the Fit button shows;
   * an image smaller than the window is never enlarged, so for it 1 is its
   * natural size). 2 = twice that. Values below 1 are treated as 1.
   */
  zoom?: number;
  /** The point of the image in the middle of the window, as fractions 0..1 of its width/height. */
  cx?: number;
  cy?: number;
  /** A highlighted rectangle, fractions 0..1 of the image's width/height. */
  region?: ViewRegion;
}

export interface ViewRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The highest real scale the viewer zooms to (400%). */
export const MAX_ABSOLUTE_ZOOM = 4;
/** Sanity cap for a view's relative zoom; the real scale is limited by MAX_ABSOLUTE_ZOOM anyway. */
const MAX_VIEW_ZOOM = 100;
/** Margin kept around a region that is fitted into the window, in window pixels. */
export const REGION_PADDING = 24;
/** Margin kept around the whole image when it is fitted (markers stick out of the image edge by up to this much). */
export const FIT_PADDING = 14;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
/** Four decimals are plenty for a fraction and keep links short. */
const round4 = (n: number) => Math.round(n * 10000) / 10000;

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/** A region with finite numbers, clipped into the image and not empty; otherwise undefined. */
export function normalizeRegion(r: Partial<ViewRegion> | null | undefined): ViewRegion | undefined {
  if (!r || !finite(r.x) || !finite(r.y) || !finite(r.w) || !finite(r.h)) return undefined;
  const x = clamp01(r.x);
  const y = clamp01(r.y);
  const w = Math.min(1 - x, r.w);
  const h = Math.min(1 - y, r.h);
  if (w <= 0 || h <= 0) return undefined;
  return { x: round4(x), y: round4(y), w: round4(w), h: round4(h) };
}

/**
 * Cleans a view that came from outside (a bookmark, a link, a host call):
 * drops what is not a finite number, clamps fractions into 0..1 and zoom into
 * 1..MAX. Null when there is no usable `imageId` — the one required field.
 */
export function normalizeView(view: unknown): EcatmView | null {
  if (!view || typeof view !== "object") return null;
  const raw = view as Record<string, unknown>;
  if (!finite(raw.imageId) || !Number.isInteger(raw.imageId)) return null;
  const out: EcatmView = { v: 1, imageId: raw.imageId };
  if (finite(raw.linkId) && Number.isInteger(raw.linkId)) out.linkId = raw.linkId;
  if (finite(raw.zoom)) out.zoom = round4(Math.min(MAX_VIEW_ZOOM, Math.max(1, raw.zoom)));
  if (finite(raw.cx)) out.cx = round4(clamp01(raw.cx));
  if (finite(raw.cy)) out.cy = round4(clamp01(raw.cy));
  const region = normalizeRegion(raw.region as Partial<ViewRegion> | undefined);
  if (region) out.region = region;
  return out;
}

/** Stable text for comparing two views (the "view" event is only sent when it changes). */
export function viewKey(view: EcatmView): string {
  return JSON.stringify([view.imageId, view.linkId ?? null, view.zoom ?? null, view.cx ?? null, view.cy ?? null, view.region ? [view.region.x, view.region.y, view.region.w, view.region.h] : null]);
}

// --- Address-bar parameters: image, link, zoom, cx, cy, rect=x,y,w,h ---

/** The geometry part of a view — what a link carries besides image and link. */
export type ViewGeometry = Pick<EcatmView, "zoom" | "cx" | "cy" | "region">;

/** Reads zoom/cx/cy/rect out of a link's query; anything malformed is ignored. */
export function parseViewGeometry(params: URLSearchParams): ViewGeometry {
  const out: ViewGeometry = {};
  const num = (key: string): number | undefined => {
    const raw = params.get(key);
    if (raw === null || raw.trim() === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  const zoom = num("zoom");
  if (zoom !== undefined) out.zoom = round4(Math.min(MAX_VIEW_ZOOM, Math.max(1, zoom)));
  const cx = num("cx");
  if (cx !== undefined) out.cx = round4(clamp01(cx));
  const cy = num("cy");
  if (cy !== undefined) out.cy = round4(clamp01(cy));
  const rect = params.get("rect");
  if (rect) {
    const [x, y, w, h] = rect.split(",").map((s) => (s.trim() === "" ? NaN : Number(s)));
    const region = normalizeRegion({ x, y, w, h });
    if (region) out.region = region;
  }
  return out;
}

/** Writes the geometry into a link's query (the inverse of parseViewGeometry); absent fields are left out. */
export function setViewGeometryParams(params: URLSearchParams, geometry: ViewGeometry): void {
  for (const key of ["zoom", "cx", "cy", "rect"]) params.delete(key);
  if (geometry.zoom !== undefined) params.set("zoom", String(round4(geometry.zoom)));
  if (geometry.cx !== undefined) params.set("cx", String(round4(geometry.cx)));
  if (geometry.cy !== undefined) params.set("cy", String(round4(geometry.cy)));
  if (geometry.region) {
    const { x, y, w, h } = geometry.region;
    params.set("rect", [x, y, w, h].map(round4).join(","));
  }
}

// --- Geometry: view <-> real scale and scroll position ---

export interface Size {
  w: number;
  h: number;
}

/**
 * The scale that fits the whole image into the window (the "zoom 1" of a
 * view). Never above 100%: a small image is not blown up and blurred. Null
 * while the window or the image has no size yet.
 */
export function fitScale(image: Size, box: Size): number | null {
  if (!(image.w > 0 && image.h > 0 && box.w > 0 && box.h > 0)) return null;
  return Math.min(1, (box.w - 2 * FIT_PADDING) / image.w, (box.h - 2 * FIT_PADDING) / image.h);
}

/** What the engine has to do to show a view: the real scale, and where the window sits on the scaled image. */
export interface ViewPlacement {
  /** Real scale of the image (1 = natural size). */
  scale: number;
  /** True when this is the fitted-whole state — the engine then centers the image itself and `scrollLeft/Top` do not apply. */
  fitted: boolean;
  scrollLeft: number;
  scrollTop: number;
}

/**
 * Turns a view into a real scale and scroll offset for this window. A region
 * without a zoom picks the scale at which the rectangle just fits (with a
 * margin) and is centered; with a zoom, `cx`/`cy` win, and failing those the
 * region's own center, and failing that the middle of the image.
 */
export function placeView(view: Pick<EcatmView, "zoom" | "cx" | "cy" | "region">, image: Size, box: Size): ViewPlacement | null {
  const fit = fitScale(image, box);
  if (fit === null) return null;
  const region = view.region;

  let scale: number;
  if (view.zoom !== undefined) {
    scale = fit * Math.max(1, view.zoom);
  } else if (region) {
    const sx = (box.w - 2 * REGION_PADDING) / (region.w * image.w);
    const sy = (box.h - 2 * REGION_PADDING) / (region.h * image.h);
    scale = Math.min(sx, sy);
  } else {
    scale = fit;
  }
  scale = Math.min(MAX_ABSOLUTE_ZOOM, Math.max(fit, scale));

  if (scale <= fit * 1.001) return { scale: fit, fitted: true, scrollLeft: 0, scrollTop: 0 };

  const cx = view.cx ?? (region ? region.x + region.w / 2 : 0.5);
  const cy = view.cy ?? (region ? region.y + region.h / 2 : 0.5);
  return {
    scale,
    fitted: false,
    scrollLeft: Math.max(0, cx * image.w * scale - box.w / 2),
    scrollTop: Math.max(0, cy * image.h * scale - box.h / 2),
  };
}

/**
 * The inverse of placeView: the zoom/cx/cy of what the window shows now. At
 * the fitted scale (or below) there is nothing to report but zoom 1. An axis
 * on which the scaled image is smaller than the window has no scroll to
 * speak of — its center is the middle of the image.
 */
export function readView(scroll: { left: number; top: number }, scale: number, image: Size, box: Size): Pick<EcatmView, "zoom" | "cx" | "cy"> | null {
  const fit = fitScale(image, box);
  if (fit === null || !(scale > 0)) return null;
  if (scale <= fit * 1.001) return { zoom: 1 };
  const sw = image.w * scale;
  const sh = image.h * scale;
  return {
    zoom: round4(scale / fit),
    cx: round4(sw <= box.w ? 0.5 : clamp01((scroll.left + box.w / 2) / sw)),
    cy: round4(sh <= box.h ? 0.5 : clamp01((scroll.top + box.h / 2) / sh)),
  };
}

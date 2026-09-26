/**
 * Draws one grid (a folder's items) into a single JPEG — the catalog image
 * the viewer shows, with a numbered hotspot badge per tile. Follows the
 * tile-grid conventions worked out on the hand-built demos (Abilene,
 * Worthington, Cupidone): the grid is narrow enough to fit the viewer's
 * stage at 100% on a 1920x1080 screen, badges sit fully inside their tile's
 * top-left corner, and one title-pill font size is shared by every grid.
 */
import type { GridPlan } from "./plan.js";

/** Canvas width: the viewer's stage is ~948px wide on a maximized 1920x1080 window. */
export const GRID_W = 920;
const MARGIN = 20;
const GAP = 16;
const TOP = 100;
const PILL_H = 56;
const RADIUS = 14;
const FONT = '"Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/**
 * Tallest grid image the composer makes; a bigger folder is split into
 * parts. iOS Safari refuses canvases over 16,777,216 px (4096²) — and the
 * PDF export redraws non-JPEG images through a canvas — so 920 × 16,000
 * (14.7 MP) stays under it with a margin. Chrome's own cap is 32,767 px tall.
 */
export const MAX_GRID_HEIGHT = 16000;

export type PhotoFit = "contain" | "cover";

export interface GridStyle {
  columns: number;
  fit: PhotoFit;
  accent: string;
  /** Shared across the catalog — see titleFontSize(). */
  titleFont: number;
  /** Extra key shown under the name, "sku" for the SKU, "" for nothing. */
  subtitleKey: string;
  noPhotoLabel: string;
  /** Widest badge text in the catalog, e.g. "128" — sizes the corner inset. */
  widestNumber: string;
}

export interface GridAnchor {
  url: string;
  no: number;
  left: number;
  top: number;
}

export interface RenderedGrid {
  jpeg: Blob;
  width: number;
  height: number;
  anchors: GridAnchor[];
  badgeFont: number;
}

export function tileSize(columns: number): number {
  return Math.floor((GRID_W - 2 * MARGIN - (columns - 1) * GAP) / columns);
}

interface CaptionMetrics {
  capFont: number;
  subFont: number;
  pad: number;
  lineH: number;
  /** Caption strip height below the photo. */
  cap: number;
}

function captionMetrics(columns: number, withSubtitle: boolean): CaptionMetrics {
  const capFont = Math.max(12, Math.min(18, Math.round(tileSize(columns) / 14)));
  const subFont = capFont - 2;
  const pad = Math.round(capFont * 0.75);
  const lineH = Math.round(capFont * 1.3);
  return { capFont, subFont, pad, lineH, cap: pad + 2 * lineH + (withSubtitle ? Math.round(subFont * 1.5) : 0) + pad };
}

function gridHeight(rows: number, columns: number, withSubtitle: boolean): number {
  return TOP + rows * (tileSize(columns) + captionMetrics(columns, withSubtitle).cap) + (rows - 1) * GAP + MARGIN;
}

/** Most tiles one grid image holds without going over MAX_GRID_HEIGHT. */
export function maxTilesPerGrid(columns: number, withSubtitle: boolean): number {
  let rows = 1;
  while (gridHeight(rows + 1, columns, withSubtitle) <= MAX_GRID_HEIGHT) rows++;
  return rows * columns;
}

/** Hotspot badge font for a tile width: 24px on Cupidone's 4-column tiles, scaled from there. */
export function badgeFontSize(columns: number): number {
  return Math.max(16, Math.min(28, Math.round(tileSize(columns) * 0.115)));
}

/**
 * Where the viewer's centered badge must sit so it renders fully inside the
 * tile: half its own footprint plus a margin. The viewer draws the badge as
 * `padding: 1px 5px` + 1px border around the text (viewer style.css .hotspot).
 */
export function badgeInset(font: number, widestNumber: string): { x: number; y: number } {
  const halfW = (widestNumber.length * font * 0.6 + 12) / 2;
  const halfH = (font * 1.25 + 4) / 2;
  return { x: Math.round(halfW + 8), y: Math.round(halfH + 8) };
}

/** Largest pill font (30..16) at which every grid title fits the canvas. */
export function titleFontSize(ctx: CanvasRenderingContext2D, titles: string[]): number {
  for (let size = 30; size > 16; size--) {
    ctx.font = `bold ${size}px ${FONT}`;
    if (titles.every((t) => ctx.measureText(t).width + 60 <= GRID_W - 2 * MARGIN)) return size;
  }
  return 16;
}

function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + "…").width > maxW) s = s.slice(0, -1);
  return s.trimEnd() + "…";
}

/** Word-wraps into at most `maxLines`, ellipsizing the last one. */
function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  const lines: string[] = [];
  let current = "";
  const words = text.split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const candidate = current ? `${current} ${words[i]}` : words[i]!;
    if (ctx.measureText(candidate).width <= maxW || !current) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = words[i]!;
    if (lines.length === maxLines - 1) {
      current = words.slice(i).join(" ");
      break;
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, maxLines).map((l) => ellipsize(ctx, l, maxW));
}

export function newCanvasContext(width: number, height: number): CanvasRenderingContext2D {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas.getContext("2d")!;
}

export async function renderGrid(
  grid: GridPlan,
  title: string,
  style: GridStyle,
  photo: (fileName: string) => Promise<ImageBitmap | null>,
): Promise<RenderedGrid> {
  const cols = style.columns;
  const tile = tileSize(cols);
  const { capFont, subFont, pad, lineH, cap } = captionMetrics(cols, style.subtitleKey !== "");
  const width = GRID_W;
  const height = gridHeight(Math.ceil(grid.items.length / cols), cols, style.subtitleKey !== "");
  const badgeFont = badgeFontSize(cols);
  const inset = badgeInset(badgeFont, style.widestNumber);

  const ctx = newCanvasContext(width, height);
  ctx.fillStyle = "#eef1f5";
  ctx.fillRect(0, 0, width, height);

  // Title pill
  ctx.font = `bold ${style.titleFont}px ${FONT}`;
  const shown = ellipsize(ctx, title, width - 2 * MARGIN - 60);
  const pillW = ctx.measureText(shown).width + 60;
  ctx.fillStyle = style.accent;
  ctx.beginPath();
  ctx.roundRect((width - pillW) / 2, 22, pillW, PILL_H, PILL_H / 2);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(shown, width / 2, 22 + PILL_H / 2 + 1);

  const anchors: GridAnchor[] = [];
  for (let i = 0; i < grid.items.length; i++) {
    const { item, photo: file, url } = grid.items[i]!;
    const x = MARGIN + (i % cols) * (tile + GAP);
    const y = TOP + Math.floor(i / cols) * (tile + cap + GAP);

    // Card
    ctx.save();
    ctx.shadowColor = "rgba(15, 23, 42, 0.18)";
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.roundRect(x, y, tile, tile + cap, RADIUS);
    ctx.fill();
    ctx.restore();

    // Photo, normalized to the square tile whatever its own proportions
    const bitmap = file ? await photo(file) : null;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, tile, tile, [RADIUS, RADIUS, 0, 0]);
    ctx.clip();
    if (bitmap) {
      if (style.fit === "cover") {
        const s = Math.max(tile / bitmap.width, tile / bitmap.height);
        const sw = tile / s;
        const sh = tile / s;
        ctx.drawImage(bitmap, (bitmap.width - sw) / 2, (bitmap.height - sh) / 2, sw, sh, x, y, tile, tile);
      } else {
        const inner = tile - 16;
        const s = Math.min(inner / bitmap.width, inner / bitmap.height);
        const dw = bitmap.width * s;
        const dh = bitmap.height * s;
        ctx.drawImage(bitmap, x + (tile - dw) / 2, y + (tile - dh) / 2, dw, dh);
      }
      bitmap.close();
    } else {
      ctx.fillStyle = "#e2e8f0";
      ctx.fillRect(x, y, tile, tile);
      ctx.fillStyle = "#64748b";
      ctx.font = `${capFont}px ${FONT}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(ellipsize(ctx, style.noPhotoLabel, tile - 16), x + tile / 2, y + tile / 2);
    }
    ctx.restore();

    // Caption: name (up to 2 lines), then the subtitle
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#0f172a";
    ctx.font = `bold ${capFont}px ${FONT}`;
    wrap(ctx, item.name || `#${item.no}`, tile - 2 * pad, 2).forEach((line, k) => {
      ctx.fillText(line, x + pad, y + tile + pad + capFont + k * lineH);
    });
    const sub = style.subtitleKey === "sku" ? item.sku : style.subtitleKey ? (item.extra[style.subtitleKey] ?? "") : "";
    if (sub) {
      ctx.fillStyle = style.subtitleKey === "sku" ? "#64748b" : style.accent;
      ctx.font = `${style.subtitleKey === "sku" ? "" : "bold "}${subFont}px ${FONT}`;
      ctx.fillText(ellipsize(ctx, sub, tile - 2 * pad), x + pad, y + tile + cap - pad);
    }

    anchors.push({ url, no: item.no, left: x + inset.x, top: y + inset.y });
  }

  const jpeg = await new Promise<Blob>((resolve, reject) =>
    ctx.canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/jpeg", 0.85),
  );
  return { jpeg, width, height, anchors, badgeFont };
}

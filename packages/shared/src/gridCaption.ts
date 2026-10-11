/**
 * Captions of a composed tile grid (Grid Composer and its wizard). The name
 * and the line under it are painted into the grid's JPEG, so a later edit
 * of the table would leave the picture showing the old text. The composer
 * therefore records where every caption sits (`meta`, one key per image),
 * and the editor repaints the strips whose row no longer says what the
 * picture does — see syncGridCaptions().
 *
 * Catalogs composed before this existed carry no layout and are left alone.
 */
import type { Database } from "sql.js";

export const GRID_FONT = '"Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

const META_PREFIX = "grid_layout:";

export interface GridTile {
  /** rows.url of the item this tile shows. */
  url: string;
  no: number;
  /** Top-left corner of the tile's card. */
  x: number;
  y: number;
  /** What the picture currently says, to tell a stale caption from a fresh one. */
  name: string;
  sub: string;
}

export interface GridLayout {
  v: 1;
  /** Guards against a layout outliving its picture (the image was replaced). */
  width: number;
  height: number;
  /** Tile side; the caption strip of height `cap` hangs below it. */
  tile: number;
  cap: number;
  capFont: number;
  subFont: number;
  pad: number;
  lineH: number;
  radius: number;
  accent: string;
  /** Extra key shown under the name, "sku" for the SKU, "" for nothing. */
  subtitleKey: string;
  tiles: GridTile[];
}

export interface CaptionSource {
  name: string;
  sku: string;
  extra: Record<string, unknown>;
}

/** The two caption lines an item gets: its name (or "#7" without one) and the chosen subtitle. */
export function captionText(layout: Pick<GridLayout, "subtitleKey">, no: number, row: CaptionSource | null): { name: string; sub: string } {
  const key = layout.subtitleKey;
  const sub = !row || !key ? "" : key === "sku" ? row.sku : String(row.extra[key] ?? "");
  return { name: row?.name.trim() || `#${no}`, sub: sub.trim() };
}

export function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
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

/**
 * Paints one tile's caption strip: the card's white first (so a repaint
 * covers the old text), then the name on up to two lines and the subtitle.
 */
export function drawTileCaption(ctx: CanvasRenderingContext2D, layout: GridLayout, tile: GridTile, text: { name: string; sub: string }): void {
  const { tile: size, cap, capFont, subFont, pad, lineH, radius } = layout;
  const top = tile.y + size;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(tile.x, top, size, cap, [0, 0, radius, radius]);
  ctx.clip();
  ctx.fillStyle = "#fff";
  ctx.fillRect(tile.x, top, size, cap);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#0f172a";
  ctx.font = `bold ${capFont}px ${GRID_FONT}`;
  wrap(ctx, text.name, size - 2 * pad, 2).forEach((line, k) => {
    ctx.fillText(line, tile.x + pad, top + pad + capFont + k * lineH);
  });
  if (text.sub) {
    const sku = layout.subtitleKey === "sku";
    ctx.fillStyle = sku ? "#64748b" : layout.accent;
    ctx.font = `${sku ? "" : "bold "}${subFont}px ${GRID_FONT}`;
    ctx.fillText(ellipsize(ctx, text.sub, size - 2 * pad), tile.x + pad, top + cap - pad);
  }
  ctx.restore();
}

export function writeGridLayout(db: Database, imageId: number, layout: GridLayout): void {
  db.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [
    META_PREFIX + imageId,
    JSON.stringify(layout),
  ]);
}

/** Every recorded layout whose image is still there at the recorded size. */
export function listGridLayouts(db: Database): Array<{ imageId: number; layout: GridLayout }> {
  const found: Array<{ imageId: number; layout: GridLayout }> = [];
  const res = db.exec(
    `SELECT m.key, m.value, i.width, i.height FROM meta m JOIN images i ON i.id = CAST(substr(m.key, ${META_PREFIX.length + 1}) AS INTEGER) WHERE m.key LIKE '${META_PREFIX}%'`,
  );
  for (const [key, value, width, height] of res[0]?.values ?? []) {
    try {
      const layout = JSON.parse(String(value)) as GridLayout;
      if (layout.v === 1 && layout.width === width && layout.height === height && Array.isArray(layout.tiles)) {
        found.push({ imageId: Number(String(key).slice(META_PREFIX.length)), layout });
      }
    } catch {
      // not ours to repaint
    }
  }
  return found;
}

function rowsByUrl(db: Database): Map<string, CaptionSource> {
  const map = new Map<string, CaptionSource>();
  const res = db.exec("SELECT url, name, sku, extra FROM rows");
  for (const [url, name, sku, extra] of res[0]?.values ?? []) {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(String(extra)) as Record<string, unknown>;
    } catch {
      // a row with unreadable extras still has a name
    }
    map.set(String(url), { name: String(name), sku: String(sku), extra: parsed });
  }
  return map;
}

/** Tiles whose picture no longer matches their row, per image. Pure data — no canvas. */
export function staleGridCaptions(db: Database): Array<{ imageId: number; layout: GridLayout; stale: Array<{ tile: GridTile; text: { name: string; sub: string } }> }> {
  const layouts = listGridLayouts(db);
  if (layouts.length === 0) return [];
  const rows = rowsByUrl(db);
  return layouts
    .map(({ imageId, layout }) => ({
      imageId,
      layout,
      stale: layout.tiles
        .map((tile) => ({ tile, text: captionText(layout, tile.no, rows.get(tile.url) ?? null) }))
        .filter(({ tile, text }) => text.name !== tile.name || text.sub !== tile.sub),
    }))
    .filter((entry) => entry.stale.length > 0);
}

async function base64ToBlob(base64: string, mimeType: string): Promise<Blob> {
  return (await fetch(`data:${mimeType};base64,${base64}`)).blob();
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * Repaints every stale caption and stores the pictures back. Resolves to
 * true when at least one image changed (the caller re-renders). Browser-only
 * (canvas). Each repaint re-encodes the JPEG, which is why nothing is
 * touched unless a caption's text really differs.
 */
export async function syncGridCaptions(db: Database): Promise<boolean> {
  let changed = false;
  for (const { imageId, layout, stale } of staleGridCaptions(db)) {
    const res = db.exec("SELECT mime_type, image_data FROM images WHERE id = ?", [imageId]);
    const record = res[0]?.values[0];
    if (!record) continue;
    const bitmap = await createImageBitmap(await base64ToBlob(String(record[1]), String(record[0])));
    const canvas = document.createElement("canvas");
    canvas.width = layout.width;
    canvas.height = layout.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) continue;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    for (const { tile, text } of stale) {
      drawTileCaption(ctx, layout, tile, text);
      tile.name = text.name;
      tile.sub = text.sub;
    }
    const jpeg = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    if (!jpeg) continue;
    db.run("UPDATE images SET mime_type = 'image/jpeg', image_data = ? WHERE id = ?", [await blobToBase64(jpeg), imageId]);
    writeGridLayout(db, imageId, layout);
    changed = true;
  }
  return changed;
}

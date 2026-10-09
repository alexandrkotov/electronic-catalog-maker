/**
 * Draws the catalog's pictures: the map as shown (with the data credit
 * printed into its corner — the picture travels without the live map's own
 * attribution control) and one page per point, the user's photo or a
 * generated placeholder card.
 */
import { fitWithin, MAP_ATTRIBUTION, type ImageSize } from "./geo.js";

const FONT = '"Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/** Longer side a point's photo is stored at; a phone photo is 2-3x that. */
const MAX_PHOTO_SIDE = 2000;
const PLACEHOLDER: ImageSize = { width: 1536, height: 1024 };

export interface RenderedImage {
  blob: Blob;
  mimeType: string;
  width: number;
  height: number;
}

function newCanvas(size: ImageSize): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  return { canvas, ctx: canvas.getContext("2d")! };
}

function toBlob(canvas: HTMLCanvasElement, mimeType: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not encode the picture"))), mimeType, quality),
  );
}

/** The map canvas as a PNG, credit in the bottom-right corner. */
export async function renderMap(mapCanvas: HTMLCanvasElement): Promise<RenderedImage> {
  const { canvas, ctx } = newCanvas(mapCanvas);
  ctx.drawImage(mapCanvas, 0, 0);

  // Still readable when the viewer fits the whole map into a narrow stage.
  const font = Math.max(11, Math.round(canvas.width / 80));
  const padX = Math.round(font * 0.6);
  const boxH = Math.round(font * 1.7);
  ctx.font = `${font}px ${FONT}`;
  // On a narrow picture the full credit would run off its left edge.
  const text = ctx.measureText(MAP_ATTRIBUTION).width + 2 * padX <= canvas.width ? MAP_ATTRIBUTION : MAP_ATTRIBUTION.split(" · ")[0]!;
  const boxW = Math.ceil(ctx.measureText(text).width) + 2 * padX;
  ctx.fillStyle = "rgb(255 255 255 / 0.82)";
  ctx.fillRect(canvas.width - boxW, canvas.height - boxH, boxW, boxH);
  ctx.fillStyle = "#333333";
  ctx.textBaseline = "middle";
  ctx.fillText(text, canvas.width - boxW + padX, canvas.height - boxH / 2);

  return { blob: await toBlob(canvas, "image/png"), mimeType: "image/png", width: canvas.width, height: canvas.height };
}

/** A point's photo re-encoded as JPEG, scaled down if it's larger than a page needs. Null if the browser can't decode it. */
export async function renderPhoto(file: File): Promise<RenderedImage | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null; // e.g. HEIC outside Safari
  }
  const size = fitWithin(bitmap, MAX_PHOTO_SIDE);
  const { canvas, ctx } = newCanvas(size);
  // JPEG has no transparency: a cut-out PNG gets a white page, not a black one.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size.width, size.height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, size.width, size.height);
  bitmap.close();
  return { blob: await toBlob(canvas, "image/jpeg", 0.9), mimeType: "image/jpeg", ...size };
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (!line || ctx.measureText(next).width <= maxWidth) line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] += "…";
  }
  return lines;
}

/** The page of a point that has no photo yet: its name on a plain card, and what to do about it. */
export async function renderPlaceholder(name: string, hint: string, accent: string): Promise<RenderedImage> {
  const { canvas, ctx } = newCanvas(PLACEHOLDER);
  const { width: w, height: h } = PLACEHOLDER;
  ctx.fillStyle = "#eef1f6";
  ctx.fillRect(0, 0, w, h);

  // Map pin: a circle over a downward point, with a hole.
  const cx = w / 2;
  const cy = 300;
  const r = 78;
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI * 0.85, Math.PI * 0.15);
  ctx.lineTo(cx, cy + r * 2.1);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#eef1f6";
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.38, 0, Math.PI * 2);
  ctx.fill();

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#1a1a1a";
  ctx.font = `600 84px ${FONT}`;
  const lines = wrapLines(ctx, name, w - 240, 3);
  lines.forEach((line, i) => ctx.fillText(line, cx, 590 + i * 104));

  ctx.fillStyle = "#5f6673";
  ctx.font = `34px ${FONT}`;
  ctx.fillText(hint, cx, h - 90, w - 160);

  return { blob: await toBlob(canvas, "image/jpeg", 0.9), mimeType: "image/jpeg", ...PLACEHOLDER };
}

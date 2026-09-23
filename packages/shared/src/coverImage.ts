import { PROTECT_MAX_COVER_BYTES, type ProtectedCatalogCover } from "./protect.js";

// Tried in order until the JPEG fits: the lock screen shows the cover at ~22rem,
// so 720 px is already sharp on a retina phone; the later steps only exist for
// a very detailed picture that still overshoots the limit.
const STEPS = [
  { side: 720, quality: 0.85 },
  { side: 720, quality: 0.7 },
  { side: 600, quality: 0.65 },
  { side: 480, quality: 0.55 },
  { side: 360, quality: 0.5 },
];

/**
 * Turns any picture the browser can decode into the small public cover of a
 * protected catalog: scaled down, flattened onto white (a transparent PNG
 * would otherwise turn black in JPEG) and re-encoded as JPEG. Re-encoding also
 * drops metadata (EXIF, GPS position) that the seller never meant to publish
 * with an unprotected cover. Browser-only (canvas). Rejects if the source is
 * not an image or cannot be brought under `maxBytes`.
 */
export async function makeCoverThumbnail(
  source: Blob,
  maxBytes: number = PROTECT_MAX_COVER_BYTES,
): Promise<ProtectedCatalogCover> {
  const bitmap = await createImageBitmap(source);
  try {
    for (const step of STEPS) {
      const scale = Math.min(1, step.side / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas is not available");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", step.quality));
      if (blob && blob.size <= maxBytes) {
        return { mime: "image/jpeg", bytes: new Uint8Array(await blob.arrayBuffer()) };
      }
    }
  } finally {
    bitmap.close();
  }
  throw new Error("the picture is too detailed to fit the cover size limit");
}

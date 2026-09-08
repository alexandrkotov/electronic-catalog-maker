/**
 * QR code rendering, shared by anything that needs to hand a URL to a phone
 * camera — the editor's collaboration share dialog, the viewer's "Share
 * view…", and the PDF export's per-item codes (see pdfExport.ts).
 */

import qrcodeGenerator from "qrcode-generator";

export interface QrMatrix {
  /** Modules per side, not counting the quiet zone. */
  moduleCount: number;
  /** Modules of white margin required around the code on every side. */
  quietZone: number;
  /** moduleCount + quietZone * 2 — the side length to lay the matrix out in, quiet zone included. */
  size: number;
  isDark(row: number, col: number): boolean;
}

/**
 * Encodes `text` and returns its module matrix, without committing to any
 * particular output format (SVG here, vector rects in pdfExport.ts).
 * Type number 0 lets qrcode-generator pick the smallest QR version that
 * fits `text` on its own. Error correction defaults to "M" (existing
 * on-screen behavior); pdfExport.ts asks for "L" instead — the lowest
 * level the spec defines — since a printed code has no glare/scratch
 * resilience need a screen doesn't, and every bit of error-correction
 * overhead is one more module pushing the printed size up.
 */
export function buildQrMatrix(text: string, errorCorrectionLevel: "L" | "M" | "Q" | "H" = "M"): QrMatrix {
  const qr = qrcodeGenerator(0, errorCorrectionLevel);
  qr.addData(text);
  qr.make();

  const moduleCount = qr.getModuleCount();
  const quietZone = 4; // modules of white margin — standard QR requirement for reliable scanning
  return {
    moduleCount,
    quietZone,
    size: moduleCount + quietZone * 2,
    isDark: (row, col) => qr.isDark(row, col),
  };
}

/**
 * Renders a QR code encoding `text` as a self-contained inline SVG string
 * (a single `<path>` of unit squares, not one `<rect>` per module — cheap
 * to build and cheap for the browser to paint) — no canvas, no external
 * image request, crisp at any CSS size via `width`/`height: 100%`.
 *
 * Colors are fixed black-on-white regardless of the app's light/dark theme
 * — a QR code needs reliable contrast for a phone camera to scan, not to
 * match the surrounding UI.
 */
export function renderQrCodeSvg(text: string): string {
  const matrix = buildQrMatrix(text, "M");

  let path = "";
  for (let row = 0; row < matrix.moduleCount; row++) {
    for (let col = 0; col < matrix.moduleCount; col++) {
      if (matrix.isDark(row, col)) path += `M${col + matrix.quietZone} ${row + matrix.quietZone}h1v1h-1z`;
    }
  }

  return `<svg viewBox="0 0 ${matrix.size} ${matrix.size}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="QR code"><rect width="${matrix.size}" height="${matrix.size}" fill="#fff" /><path d="${path}" fill="#000" /></svg>`;
}

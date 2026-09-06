/**
 * QR code rendering, shared by anything that needs to hand a URL to a phone
 * camera — the editor's collaboration share dialog today, the viewer's
 * planned "Share for viewing" (see the OneDrive backlog) later.
 */

import qrcodeGenerator from "qrcode-generator";

/**
 * Renders a QR code encoding `text` as a self-contained inline SVG string
 * (a single `<path>` of unit squares, not one `<rect>` per module — cheap
 * to build and cheap for the browser to paint) — no canvas, no external
 * image request, crisp at any CSS size via `width`/`height: 100%`.
 *
 * Colors are fixed black-on-white regardless of the app's light/dark theme
 * — a QR code needs reliable contrast for a phone camera to scan, not to
 * match the surrounding UI. Type number 0 lets qrcode-generator pick the
 * smallest QR version that fits `text` on its own, so this scales from a
 * short id up to a full share URL without the caller thinking about it.
 */
export function renderQrCodeSvg(text: string): string {
  const qr = qrcodeGenerator(0, "M");
  qr.addData(text);
  qr.make();

  const moduleCount = qr.getModuleCount();
  const quietZone = 4; // modules of white margin — standard QR requirement for reliable scanning
  const size = moduleCount + quietZone * 2;

  let path = "";
  for (let row = 0; row < moduleCount; row++) {
    for (let col = 0; col < moduleCount; col++) {
      if (qr.isDark(row, col)) path += `M${col + quietZone} ${row + quietZone}h1v1h-1z`;
    }
  }

  return `<svg viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="QR code"><rect width="${size}" height="${size}" fill="#fff" /><path d="${path}" fill="#000" /></svg>`;
}

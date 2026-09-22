function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Served at /preview/<relPath> — embeds the catalog viewer web component
 * (packages/viewer-embed, this server serves its own copy at
 * /ecm-viewer.js) pointed at /files/<relPath> on this same server. Same
 * origin as the file it's viewing, so it works with zero CORS setup and
 * zero mixed-content risk, LAN or Internet, online or fully offline — see
 * README "Embedding the viewer" for what the component itself supports.
 */
export function renderPreviewPage(relPath: string, fileUrl: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(relPath)}</title>
<style>
  :root { color-scheme: light dark; }
  html, body { height: 100%; margin: 0; }
  ecm-viewer { display: block; width: 100%; height: 100%; border: none; border-radius: 0; }
</style>
<script src="/ecm-viewer.js"></script>
</head>
<body>
  <ecm-viewer mode="full" src="${escapeHtml(fileUrl)}"></ecm-viewer>
</body>
</html>`;
}

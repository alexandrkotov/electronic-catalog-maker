/**
 * The other half of the editor's Local-Network-Access workaround
 * (`detectLocalCollabServerViaBridge` in packages/editor/src/main.ts).
 *
 * Chrome 142+'s Local Network Access (LNA) blocks a public https:// page's
 * plain `fetch()` to a loopback address like `http://127.0.0.1:8787`
 * outright — the editor's normal auto-detect probe — unless the user has
 * separately granted that origin permission, which nothing in this flow
 * ever prompts for. LNA doesn't restrict two things this page relies on
 * instead: a *same-address-space* fetch (this page, itself served from
 * 127.0.0.1, fetching its own `/status.json`) and `postMessage` between
 * windows (unrelated to fetch/XHR/WebSocket, which is all LNA actually
 * gates). So: the editor opens this in a popup instead of fetching it
 * directly; this page does the fetch on the server's own side of the
 * boundary, then hands the answer back across that boundary the one way
 * LNA doesn't block, and closes itself either way.
 *
 * Deliberately not the real status page (`statusPage.ts`) — a status page
 * with a working Stop button flashing open and shut on every "Start
 * collaboration" click would be alarming ("did that just stop my
 * session?"); this is a blank, momentary, single-purpose page instead.
 */
export function renderBridgePage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Connecting…</title>
</head>
<body>
<script>
(function () {
  var returnOrigin = new URLSearchParams(location.search).get("returnOrigin");
  function done() {
    try { window.close(); } catch {}
  }
  if (!window.opener || !returnOrigin) { done(); return; }
  fetch("/status.json")
    .then(function (res) { return res.json(); })
    .then(function (data) {
      window.opener.postMessage(
        { source: "ecm-collab-server-bridge", publicUrl: data.publicUrl, tunnelError: data.tunnelError, port: data.port },
        returnOrigin
      );
    })
    .catch(function () {})
    .then(done);
})();
</script>
</body>
</html>`;
}

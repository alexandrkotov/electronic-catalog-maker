import "./style.css";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import { mountViewer, setUpPwa } from "@ecm/shared";

// Service Worker registration + the standalone-aware GoatCounter gate —
// see packages/shared/src/pwa.ts.
setUpPwa();

// The standalone full-page app: renders into the page's own #app div (light
// DOM, no shadow root — `root` defaults to `document`), full toolbar, reads
// its initial catalog from `?src=` and keeps the address bar in sync with
// whatever gets opened afterwards. See packages/shared/src/viewerEngine.ts
// for the actual behavior — this file is just how the standalone page wires
// it up; packages/viewer-embed wires the same engine up as a Web Component.
const params = new URLSearchParams(location.search);
// The rest of a deep link (see the OneDrive backlog's QR-viewer item and
// mountViewer's own doc) — which image/hotspot to jump straight to once
// `src` has loaded, so a shared link/QR reproduces exactly what the
// sharer was looking at, not just the catalog's cover.
const initialImageId = params.has("image") ? Number(params.get("image")) : undefined;
const initialLinkId = params.has("link") ? Number(params.get("link")) : undefined;

mountViewer({
  container: document.getElementById("app")!,
  mode: "full",
  initialSrc: params.get("src") ?? undefined,
  initialImageId: Number.isFinite(initialImageId) ? initialImageId : undefined,
  initialLinkId: Number.isFinite(initialLinkId) ? initialLinkId : undefined,
  updateAddressBar: true,
  wasmUrl,
});

import "./style.css";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import { mountViewer } from "@ecm/shared";

// The standalone full-page app: renders into the page's own #app div (light
// DOM, no shadow root — `root` defaults to `document`), full toolbar, reads
// its initial catalog from `?src=` and keeps the address bar in sync with
// whatever gets opened afterwards. See packages/shared/src/viewerEngine.ts
// for the actual behavior — this file is just how the standalone page wires
// it up; packages/viewer-embed wires the same engine up as a Web Component.
const params = new URLSearchParams(location.search);

mountViewer({
  container: document.getElementById("app")!,
  mode: "full",
  initialSrc: params.get("src") ?? undefined,
  updateAddressBar: true,
  wasmUrl,
});

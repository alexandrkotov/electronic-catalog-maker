// The viewer engine mounted straight from its source, the way a host application
// (Tapalog Reader) embeds it: no standalone page around it, the controller on
// `window.ctrl` and every event the engine reports in `window.__events`.
// Driven by engine.mjs; ?src= is the catalog to open.
import "../../viewer/src/style.css";
import wasmUrl from "../../viewer/node_modules/sql.js/dist/sql-wasm.wasm?url";
import { mountViewer } from "../../shared/src/index.ts";

const w = window as any;
w.__events = [];
w.ctrl = mountViewer({
  container: document.getElementById("app")!,
  mode: "full",
  regionSelect: true,
  wasmUrl,
  initialSrc: new URLSearchParams(location.search).get("src") ?? undefined,
  onEvent: (type, detail) => {
    w.__events.push({ at: performance.now(), type, detail });
  },
});

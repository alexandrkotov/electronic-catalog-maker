// The viewer engine mounted straight from its source, the way a host application
// (Tapalog Reader) embeds it: no standalone page around it, the controller on
// `window.ctrl` and every event the engine reports in `window.__events`.
// Driven by engine.mjs: ?src= is the catalog to open, ?opts= is a JSON object
// merged into the mount options (toolbarActions: [{id, label, icon}] get an
// onClick that records the view it was called with in `window.__actionCalls`).
import "../../viewer/src/style.css";
import wasmUrl from "../../viewer/node_modules/sql.js/dist/sql-wasm.wasm?url";
import { mountViewer } from "../../shared/src/index.ts";

const w = window as any;
w.__events = [];
w.__actionCalls = [];
const query = new URLSearchParams(location.search);
const extra = JSON.parse(query.get("opts") ?? "{}");
const toolbarActions = (extra.toolbarActions ?? []).map((a: any) => ({ ...a, onClick: (view: unknown) => w.__actionCalls.push({ id: a.id, view }) }));
w.ctrl = mountViewer({
  container: document.getElementById("app")!,
  mode: "full",
  regionSelect: true,
  wasmUrl,
  initialSrc: query.get("src") ?? undefined,
  onEvent: (type, detail) => {
    w.__events.push({ at: performance.now(), type, detail });
  },
  ...extra,
  toolbarActions,
});

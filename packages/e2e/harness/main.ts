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
// `hostBookmarks` stands for a host's own store: asynchronous, and every call is recorded in `window.__bookmarkCalls`.
w.__bookmarkCalls = [];
let hostBookmarks: any;
if (extra.hostBookmarks) {
  const saved: any[] = [];
  const later = <T>(value: T) => new Promise<T>((done) => setTimeout(() => done(value), 40));
  hostBookmarks = {
    list: () => (w.__bookmarkCalls.push("list"), later([...saved])),
    add: (view: unknown, label: string) => {
      w.__bookmarkCalls.push(`add:${label}`);
      const bookmark = { id: `host-${saved.length + 1}`, label, view };
      saved.push(bookmark);
      return later(bookmark);
    },
    remove: (id: string) => {
      w.__bookmarkCalls.push(`remove:${id}`);
      saved.splice(0, saved.length, ...saved.filter((b) => b.id !== id));
      return later(undefined);
    },
  };
  delete extra.hostBookmarks;
}
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
  ...(hostBookmarks ? { bookmarks: hostBookmarks } : {}),
  toolbarActions,
});

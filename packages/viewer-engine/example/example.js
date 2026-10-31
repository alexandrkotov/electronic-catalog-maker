// A host application around @ecm/viewer-engine, in plain files: no bundler, no
// framework. Everything here is what a host does — the viewer is one element, and
// the buttons, the search box, the bookmarks and the share link are the host's own.
//
// Serve the package folder over HTTP (a module cannot load from file://), e.g.
//   npx serve node_modules/@ecm/viewer-engine
// and open /example/index.html, optionally with ?src=<catalog url>&view=<EcatmView as JSON>.
import { createPdfExporter, mountViewerInShadow, normalizeView } from "../dist/index.js";

const $ = (id) => document.getElementById(id);
const status = (text) => ($("status").textContent = text);

// The host owns bookmarks: where they are kept and what they are called. The viewer draws the
// "Bookmarks" button and panel; this object is the whole contract. Every method may be
// asynchronous — here a server call is imitated by the localStorage read.
const BOOKMARKS_KEY = "example-bookmarks";
const readBookmarks = () => {
  try {
    return JSON.parse(localStorage.getItem(BOOKMARKS_KEY) ?? "[]");
  } catch {
    return []; // storage may be blocked or damaged
  }
};
const writeBookmarks = (list) => localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(list));
const bookmarks = {
  list: async () => readBookmarks(),
  add: async (view, label) => {
    const bookmark = { id: crypto.randomUUID(), label, view };
    writeBookmarks([...readBookmarks(), bookmark]);
    return bookmark;
  },
  remove: async (id) => writeBookmarks(readBookmarks().filter((b) => b.id !== id)),
};

function download(bytes, name, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const viewer = mountViewerInShadow($("viewer"), {
  mode: "reader", // the full viewer without the controls a host provides itself
  wasmUrl: new URL("../dist/sql-wasm.wasm", import.meta.url).href,
  exportPdf: createPdfExporter(new URL("../dist/fonts/DejaVuSans.ttf", import.meta.url).href), // the PDF code loads on first use
  persist: false, // the viewer writes nothing to localStorage
  analytics: false, // and links to nothing outside the catalog's own
  bookmarks, // adds the "Bookmarks" button and panel to the toolbar
  toolbarActions: [
    {
      id: "share",
      label: "Share view",
      onClick: (view) => {
        const link = new URL(location.href);
        link.searchParams.set("view", JSON.stringify(view));
        navigator.clipboard?.writeText(link.href).catch(() => {});
        status("Link with the current view copied");
        history.replaceState(null, "", link);
      },
    },
    {
      id: "print",
      label: "Print",
      onClick: async (view) => {
        // The picture on screen, or only the marked area of it — not the whole catalog.
        status("Making the PDF…");
        try {
          download(await viewer.exportPdf({ imageId: view.imageId, region: view.region }), "view.pdf", "application/pdf");
          status("");
        } catch (err) {
          status(String(err.message ?? err));
        }
      },
    },
  ],
  onEvent: (type, detail) => {
    if (type === "view") $("view").textContent = JSON.stringify(detail, null, 1); // at most every 250 ms
    if (type === "region") $("region").textContent = JSON.stringify(detail, null, 1);
  },
});
window.viewer = viewer; // for the console

async function guarded(promise) {
  status("");
  try {
    await promise;
  } catch (err) {
    status(String(err.message ?? err)); // not a catalog, a failed download, a wrong key…
  }
}

const startView = (() => {
  try {
    return normalizeView(JSON.parse(new URLSearchParams(location.search).get("view") ?? "null"));
  } catch {
    return null;
  }
})();

// 1. From memory: the host already has the bytes.
$("file").addEventListener("change", async (evt) => {
  const file = evt.target.files?.[0];
  if (file) await guarded(viewer.openBytes(new Uint8Array(await file.arrayBuffer()), file.name));
});

// 2. From a URL, with the visitor's cookies (or any other fetch options) for a catalog behind a login.
const openUrl = (url, view) => guarded(viewer.openUrl(url, { view: view ?? undefined, fetchInit: $("credentials").checked ? { credentials: "include" } : undefined }));
$("open-url").addEventListener("click", () => $("url").value && openUrl($("url").value));

// The host's own search box drives the viewer's search.
$("query").addEventListener("input", (evt) => (evt.target.value.trim() ? viewer.search(evt.target.value) : viewer.clearSearch()));

let dark = false;
$("theme").addEventListener("click", () => viewer.setTheme((dark = !dark) ? "dark" : "light"));

const src = new URLSearchParams(location.search).get("src");
if (src) {
  $("url").value = src;
  openUrl(src, startView);
}

// End-to-end test of @ecm/viewer-engine as a package: pack it the way the
// release does, check what is in the tarball, compile a consumer against its
// type declarations (with library checking on), then load the ES module
// straight from the unpacked folder in a browser — no bundler — and drive it.
//
//   pnpm --filter @ecm/viewer-engine build && pnpm --filter @ecm/e2e exec node library.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, "../viewer-engine");
const say = (msg) => console.log(`  ok  ${msg}`);
assert.ok(existsSync(join(pkgDir, "dist/index.js")), "build the package first: pnpm --filter @ecm/viewer-engine build");

const work = mkdtempSync(join(tmpdir(), "ecm-library-"));
const version = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version;

// 1. Pack it, as the release workflow does.
execFileSync("pnpm", ["pack", "--pack-destination", work], { cwd: pkgDir, stdio: "pipe" });
const tgz = join(work, `ecm-viewer-engine-${version}.tgz`);
assert.ok(existsSync(tgz), `the tarball is named ecm-viewer-engine-${version}.tgz`);
const listing = execFileSync("tar", ["-tzf", tgz], { encoding: "utf8" }).split("\n").filter(Boolean);
for (const wanted of ["package/package.json", "package/README.md", "package/dist/index.js", "package/dist/style.css", "package/dist/sql-wasm.wasm", "package/dist/fonts/DejaVuSans.ttf", "package/dist/LICENSE", "package/dist/types/viewer-engine/src/index.d.ts"]) {
  assert.ok(listing.includes(wanted), `the tarball has ${wanted}`);
}
assert.ok(listing.some((f) => /^package\/dist\/chunks\/pdfExport-.*\.js$/.test(f)), "the PDF writer is its own chunk");
assert.ok(!listing.some((f) => f.startsWith("package/src/") || f.endsWith(".map")), "no sources or source maps in the tarball");
say(`tarball ecm-viewer-engine-${version}.tgz: ${listing.length} files, PDF writer is a separate chunk`);

execFileSync("tar", ["-xzf", tgz, "-C", work]);
const installed = join(work, "site/node_modules/@ecm/viewer-engine");
mkdirSync(dirname(installed), { recursive: true });
execFileSync("mv", [join(work, "package"), installed]);

// 2. The server half runs in Bun and in Node, with no DOM, straight from the package.
// A real install brings the package's dependency (sql.js) next to it.
symlinkSync(join(pkgDir, "node_modules/sql.js"), join(work, "site/node_modules/sql.js"));
writeFileSync(
  join(work, "site/server-check.mjs"),
  `import { readFileSync } from "node:fs";
import { extractCover, extractSearchChunks, indexCatalog, openCatalog, searchCatalog, ProtectedCatalogError } from "@ecm/viewer-engine/server";
const [catalogPath, wasmPath] = process.argv.slice(2);
const bytes = new Uint8Array(readFileSync(catalogPath));
const opts = wasmPath ? { wasm: new Uint8Array(readFileSync(wasmPath)) } : {};
const db = await openCatalog(bytes, opts);
const chunks = extractSearchChunks(db);
const item = chunks.find((c) => c.linkId !== undefined);
const hits = searchCatalog(db, item.text.split(/\\s+/)[0]);
const digest = await indexCatalog(bytes, opts);
let lockedCode = null;
try { await openCatalog(new Uint8Array([69, 67, 77, 80, 82, 79, 84, 0, 1, 0, 0, 0]), opts); } catch (e) { lockedCode = e instanceof ProtectedCatalogError ? e.code : String(e); }
console.log(JSON.stringify({
  dom: typeof document + "/" + typeof window,
  cover: extractCover(db)?.mime,
  chunks: chunks.length,
  hit: hits.some((h) => h.imageId === item.imageId && h.linkId === item.linkId),
  digestName: digest.name,
  lockedCode,
}));
db.close();`,
);
const furniture = resolve(here, "../../demo/furniture.ecatm");
const wasmFile = join(installed, "dist/sql-wasm.wasm");
const serverBundle = readFileSync(join(installed, "dist/server.js"), "utf8");
assert.ok(!/\b(document|window|HTMLElement|createImageBitmap)\b/.test(serverBundle), "the server bundle never touches the DOM");
assert.ok(!serverBundle.includes("mountViewer"), "and carries no viewer");
for (const [runtime, args] of [
  ["bun", [furniture, wasmFile]], // a compiled binary hands the WASM over as bytes
  ["node", [furniture, wasmFile]],
  ["node", [furniture]], // from node_modules, sql.js finds its own WASM
]) {
  const out = JSON.parse(execFileSync(runtime, [join(work, "site/server-check.mjs"), ...args], { cwd: join(work, "site"), encoding: "utf8" }));
  assert.equal(out.dom, "undefined/undefined", `${runtime}: no DOM`);
  assert.match(out.cover, /^image\//, `${runtime}: a cover`);
  assert.ok(out.chunks > 0 && out.hit, `${runtime}: chunks, and a search finds an item's picture and hotspot`);
  assert.equal(out.lockedCode, "locked", `${runtime}: a protected catalog without a key says so`);
}
say("@ecm/viewer-engine/server: runs in Bun and Node from the package, no DOM, search hits carry imageId and linkId");

// 3. A consumer compiles against the declarations, library checking on.
const consumer = join(work, "consumer");
mkdirSync(join(consumer, "node_modules/@ecm"), { recursive: true });
symlinkSync(installed, join(consumer, "node_modules/@ecm/viewer-engine"));
// A real install puts the package's dependency (@types/sql.js) next to it.
mkdirSync(join(work, "site/node_modules/@types"), { recursive: true });
symlinkSync(join(pkgDir, "node_modules/@types/sql.js"), join(work, "site/node_modules/@types/sql.js"));
writeFileSync(
  join(consumer, "tsconfig.json"),
  JSON.stringify({ compilerOptions: { strict: true, module: "ESNext", moduleResolution: "Bundler", target: "ES2022", lib: ["ES2022", "DOM"], noEmit: true, skipLibCheck: false, types: [] }, files: ["main.ts"] }),
);
writeFileSync(
  join(consumer, "main.ts"),
  `import { mountViewer, mountViewerInShadow, createPdfExporter, normalizeView, viewerCss, type EcatmView, type ViewerController } from "@ecm/viewer-engine";
const view: EcatmView = { v: 1, imageId: 1, zoom: 2, region: { x: 0, y: 0, w: 0.5, h: 0.5 } };
const viewer: ViewerController = mountViewerInShadow(document.body, {
  mode: "reader",
  wasmUrl: "/sql-wasm.wasm",
  exportPdf: createPdfExporter("/DejaVuSans.ttf"),
  toolbarActions: [{ id: "a", label: "A", onClick: (v) => void v.imageId }],
  onEvent: (type, detail) => void [type, detail],
});
void viewer.openBytes(new Uint8Array(), "x", { view });
void viewer.openUrl("/x.ecatm", { fetchInit: { credentials: "include" } });
const current: EcatmView | null = viewer.getView();
void viewer.exportPdf({ showTitle: false });
void [mountViewer, normalizeView(view), viewerCss.length, current];
// @ts-expect-error  the view has a fixed version
const bad: EcatmView = { v: 2, imageId: 1 };
void bad;
import { openCatalog, searchCatalog, indexCatalog, extractSearchChunks, extractCover, type SearchHit } from "@ecm/viewer-engine/server";
async function server(bytes: Uint8Array): Promise<SearchHit[]> {
  const db = await openCatalog(bytes, { wasm: bytes, key: "k" });
  void [extractCover(db)?.mime, extractSearchChunks(db)[0]?.linkId, (await indexCatalog(bytes)).locked];
  return searchCatalog(db, "x", "name");
}
void server;
`,
);
execFileSync(join(pkgDir, "node_modules/.bin/tsc"), ["-p", join(consumer, "tsconfig.json")], { stdio: "pipe", encoding: "utf8" });
say("a consumer compiles against the declarations with skipLibCheck off");

// 4. The ES module, served as plain files, in a browser.
const site = join(work, "site");
writeFileSync(
  join(site, "index.html"),
  `<!doctype html><meta charset="utf-8"><button id="plain">Plain page button</button><div id="viewer" style="width:1100px;height:700px"></div>
<script type="module" src="/main.js"></script>`,
);
writeFileSync(
  join(site, "main.js"),
  `import { mountViewerInShadow, createPdfExporter, viewerCss } from "/node_modules/@ecm/viewer-engine/dist/index.js";
window.__events = [];
window.viewerCss = viewerCss;
window.ctrl = mountViewerInShadow(document.getElementById("viewer"), {
  mode: "reader",
  wasmUrl: "/node_modules/@ecm/viewer-engine/dist/sql-wasm.wasm",
  exportPdf: createPdfExporter("/node_modules/@ecm/viewer-engine/dist/fonts/DejaVuSans.ttf"),
  persist: false,
  analytics: false,
  onEvent: (type, detail) => window.__events.push({ type, detail }),
});
window.ready = true;`,
);
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".ttf": "font/ttf" };
const requested = [];
const catalog = readFileSync(resolve(here, "../../demo/furniture.ecatm"));
const server = createServer((req, res) => {
  const asked = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname));
  const path = asked === "/" ? "/index.html" : asked;
  if (path === "/furniture.ecatm") return void res.writeHead(200).end(catalog);
  const file = join(site, path);
  if (!file.startsWith(site) || !existsSync(file) || statSync(file).isDirectory()) return void res.writeHead(404).end();
  requested.push(path);
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.on("pageerror", (err) => assert.fail(`page error: ${err.message}`));
  page.on("console", (m) => m.type() === "error" && console.log("console error:", m.text()));
  const failedRequests = [];
  page.on("response", (r) => r.status() >= 400 && failedRequests.push(`${r.status()} ${r.url()}`));
  const plainBefore = await (async () => {
    await page.goto(`${origin}/`);
    await page.waitForFunction(() => window.ready);
    return page.$eval("#plain", (el) => getComputedStyle(el).borderRadius);
  })();
  await page.evaluate((url) => window.ctrl.openUrl(url, { view: { v: 1, imageId: 1, zoom: 3, cx: 0.3, cy: 0.6 } }), `${origin}/furniture.ecatm`);
  await page.waitForTimeout(500);
  const view = await page.evaluate(() => window.ctrl.getView());
  assert.ok(Math.abs(view.zoom - 3) < 0.01 && Math.abs(view.cx - 0.3) < 0.01, `the module loaded without a bundler and shows the view: ${JSON.stringify(view)}`);
  assert.ok(requested.includes("/node_modules/@ecm/viewer-engine/dist/sql-wasm.wasm"), "the wasm came from the package's file");
  assert.ok(!requested.some((p) => p.includes("pdfExport")), "the PDF writer has not been fetched yet");
  assert.ok(!requested.some((p) => p.endsWith(".ttf")), "nor the font");
  const plainAfter = await page.$eval("#plain", (el) => getComputedStyle(el).borderRadius);
  assert.equal(plainAfter, plainBefore, "the viewer's stylesheet does not touch the page's own buttons");
  assert.deepEqual(
    await page.evaluate(() => [document.querySelector(".toolbar"), document.getElementById("viewer").shadowRoot.querySelector(".toolbar")].map((el) => !!el)),
    [false, true],
    "the viewer lives in a shadow root, not the page's DOM",
  );
  assert.ok(await page.evaluate(() => window.viewerCss.includes(".ecm-viewer-app")), "viewerCss is the stylesheet");
  say("loaded from plain files: opens a catalog, shows the view, the page's own buttons are untouched, no PDF code fetched");

  const pdf = await page.evaluate(async () => {
    const bytes = await window.ctrl.exportPdf();
    return { head: String.fromCharCode(...bytes.slice(0, 5)), size: bytes.length };
  });
  assert.equal(pdf.head, "%PDF-", "exportPdf returns a PDF");
  assert.ok(pdf.size > 1000);
  assert.ok(requested.some((p) => /pdfExport-.*\.js$/.test(p)), "the PDF chunk was fetched for the export");
  assert.ok(requested.some((p) => p.endsWith("DejaVuSans.ttf")), "and the font");
  say(`exportPdf: ${pdf.size} bytes, the PDF chunk and font loaded only then`);

  // printing one picture, or part of one
  const { PDFDocument } = createRequire(resolve(here, "../shared/package.json"))("pdf-lib");
  const exportBytes = async (options) => new Uint8Array(await page.evaluate(async (o) => Array.from(await window.ctrl.exportPdf(o)), options));
  const pagesOf = async (bytes) => (await PDFDocument.load(bytes)).getPageCount();
  const whole = await exportBytes({});
  const onePicture = await exportBytes({ imageId: 1 });
  const wholePages = await pagesOf(whole);
  const onePages = await pagesOf(onePicture);
  assert.ok(onePages >= 1 && onePages < wholePages, `imageId prints that picture only: ${onePages} page(s) of ${wholePages}`);
  const part = await exportBytes({ imageId: 1, region: { x: 0.1, y: 0.1, w: 0.4, h: 0.4 } });
  assert.equal(String.fromCharCode(...part.slice(0, 5)), "%PDF-", "a region print is a PDF");
  assert.ok((await pagesOf(part)) <= onePages, "an area is no longer than its picture");
  assert.ok(part.length < onePicture.length, `and smaller than the whole picture: ${part.length} < ${onePicture.length}`);
  const reject = (options) => page.evaluate((o) => window.ctrl.exportPdf(o).then(() => null, (e) => String(e.message)), options);
  assert.match(await reject({ imageId: 99999 }), /no picture/, "an unknown picture is an error");
  assert.match(await reject({ region: { x: 0, y: 0, w: 0.5, h: 0.5 } }), /imageId/, "a region without its picture is an error");
  assert.match(await reject({ imageId: 1, region: { x: 2, y: 0, w: 0.5, h: 0.5 } }), /empty/, "an empty region is an error");
  say(`exportPdf: imageId ${onePages}/${wholePages} pages, region ${await pagesOf(part)} page(s), ${part.length} bytes; bad input rejects`);

  assert.deepEqual(failedRequests, [], "no failed requests");
} catch (err) {
  failed = true;
  console.error(err);
}
await browser.close();
server.close();
process.exit(failed ? 1 : 0);

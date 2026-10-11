// End-to-end smoke test: the editor creates a catalog, saves it, opens it
// again, edits it (including undo/redo) and saves; the viewer then opens the
// result. Runs against the production builds (packages/editor/dist and
// packages/viewer/dist), the same bytes that get deployed, in a real Chromium
// — so it catches what typecheck and unit tests can't: a bundle that doesn't
// boot, sql.js/WASM not loading, the save and open paths drifting apart, the
// viewer not reading what the editor wrote.
//
//   pnpm --filter @ecm/editor build && pnpm --filter @ecm/viewer build && pnpm --filter @ecm/e2e test
//
// Needs a browser once: pnpm --filter @ecm/e2e exec playwright install chromium
import assert from "node:assert/strict";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, crc32 } from "node:zlib";
import { chromium } from "playwright";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

/** Serves a built app's dist folder on a free local port; resolves to its URL. */
async function serve(app) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), `../${app}/dist`);
  if (!existsSync(join(root, "index.html"))) {
    console.error(`No build at ${root} — run: pnpm --filter @ecm/${app} build`);
    process.exit(2);
  }
  const server = createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^([/\\])+/, "");
    let file = join(root, path);
    if (!file.startsWith(root)) return void res.writeHead(403).end();
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}/`;
}
const servers = [];
const editorUrl = await serve("editor");
const viewerUrl = await serve("viewer");

const work = mkdtempSync(join(tmpdir(), "ecm-smoke-"));
const imagePath = join(work, "plan.png");
writeFileSync(imagePath, solidPng(400, 300));

const browser = await chromium.launch();
let failed = false;
try {
  // 1. A new catalog with one image, saved to a file.
  let page = await freshPage(editorUrl, "Smoke catalog");
  await page.click("#btn-new");
  await page.waitForSelector("#btn-add-image:not([disabled])");
  await page.setInputFiles("#file-image", imagePath);
  await page.waitForSelector("#stage-img");
  const first = join(work, "first.ecatm");
  await saveTo(page, first);
  assertSqlite(first);
  await page.context().close();
  step("created a catalog with an image and saved it");

  // 2. Open that file, edit it (a hotspot and its table row), save it again.
  page = await freshPage(editorUrl);
  await page.setInputFiles("#file-open", first);
  await page.waitForSelector("#stage-img");
  assert.equal((await page.$$(".image-list-name")).length, 1, "the saved image is listed after opening");
  assert.ok(!(await page.title()).startsWith("●"), "a freshly opened catalog has no unsaved changes");
  const box = await (await page.$("#stage-img")).boundingBox();
  await page.mouse.click(box.x + 120, box.y + 90);
  await page.waitForSelector("#form-link");
  await page.fill("#form-link input[name=name]", "Bolt");
  await page.fill("#form-link input[name=url]", "p-100");
  await page.click("#form-link button[type=submit]");
  await page.waitForSelector("#form-row");
  await page.fill("#form-row input[name=name]", "Hex bolt M8");
  await page.fill("#form-row input[name=sku]", "HB-M8");
  await page.click("#form-row button[type=submit]");
  await page.waitForSelector("tr[data-row-id]");
  assert.ok((await page.title()).startsWith("●"), "editing marks the catalog as unsaved");

  // Undo takes the row away and redo brings it back with its data.
  const rowCount = async () => (await page.$$("tr[data-row-id]")).length;
  await page.keyboard.press("Control+z");
  await page.waitForFunction(() => document.querySelectorAll("tr[data-row-id]").length === 0);
  await page.keyboard.press("Control+Shift+z");
  await page.waitForSelector("tr[data-row-id]");
  const redone = await page.$$eval("tr[data-row-id] td", (tds) => tds.map((td) => td.textContent));
  assert.ok(redone.includes("Hex bolt M8") && redone.includes("HB-M8"), `redo restored the row's data: ${redone.join(" | ")}`);
  assert.equal(await rowCount(), 1);

  // A second hotspot, undone with the toolbar button, must not reach the file.
  const box2 = await (await page.$("#stage-img")).boundingBox();
  await page.mouse.click(box2.x + 260, box2.y + 180);
  await page.waitForSelector("#form-link");
  await page.fill("#form-link input[name=name]", "Nut");
  await page.fill("#form-link input[name=url]", "p-200");
  await page.click("#form-link button[type=submit]");
  await page.waitForFunction(() => document.querySelectorAll("#stage-inner .hotspot:not(.pending)").length === 2);
  await page.click("#btn-undo");
  await page.waitForFunction(() => document.querySelectorAll("#stage-inner .hotspot:not(.pending)").length === 1);
  const second = join(work, "second.ecatm");
  await saveTo(page, second);
  assert.ok(!(await page.title()).startsWith("●"), "saving clears the unsaved mark");
  await page.context().close();
  step("opened it, added a hotspot and a row, undid and redid, undid a second hotspot, saved");

  // 3. Open the saved result in a clean tab: the edit must have made it to disk.
  page = await freshPage(editorUrl);
  await page.setInputFiles("#file-open", second);
  await page.waitForSelector("#stage-img");
  const hotspots = await page.$$eval("#stage-inner .hotspot:not(.pending)", (els) => els.map((e) => e.textContent));
  assert.deepEqual(hotspots, ["Bolt"], "the saved hotspot survived the round trip and the undone one did not");
  const cells = await page.$$eval("tr[data-row-id] td", (tds) => tds.map((td) => td.textContent));
  assert.ok(cells.includes("p-100") && cells.includes("Hex bolt M8") && cells.includes("HB-M8"), `the row survived: ${cells.join(" | ")}`);
  await page.context().close();
  step("reopened the saved file in the editor: hotspot and row are there, the undone hotspot is not");

  // 4. The viewer reads what the editor wrote: picture, hotspot, table row.
  page = await freshPage(viewerUrl);
  await page.setInputFiles("#file-open", second);
  await page.waitForSelector("#stage-img");
  const viewerHotspots = await page.$$eval(".hotspot[data-id]", (els) => els.map((e) => e.textContent.trim()));
  assert.deepEqual(viewerHotspots, ["Bolt"], "the viewer shows the hotspot");
  const viewerRow = await page.$eval("tr[data-url='p-100']", (tr) => tr.textContent);
  assert.ok(viewerRow.includes("Hex bolt M8") && viewerRow.includes("HB-M8"), `the viewer lists the row: ${viewerRow}`);
  await page.click(".hotspot[data-id]");
  await page.waitForFunction(() => document.querySelector("tr[data-url='p-100']")?.classList.contains("selected"));
  await page.context().close();
  step("opened the saved file in the viewer: hotspot shown, row listed, clicking the hotspot selects its row");
} catch (err) {
  failed = true;
  console.error("\nSMOKE TEST FAILED\n", err);
} finally {
  await browser.close();
  for (const server of servers) server.close();
}
process.exit(failed ? 1 : 0);

/** A tab on an app with the picker APIs removed, so Save downloads and Open uses the file input. */
async function freshPage(url, catalogName = "Untitled") {
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(() => {
    delete window.showSaveFilePicker;
    delete window.showOpenFilePicker;
  });
  page.on("dialog", (d) => void d.accept(catalogName));
  page.on("pageerror", (e) => {
    failed = true;
    console.error("page error:", e.message);
  });
  await page.goto(url);
  await page.waitForSelector("#btn-open");
  return page;
}

async function saveTo(page, path) {
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#btn-save")]);
  assert.match(download.suggestedFilename(), /\.ecatm$/, "Save downloads a .ecatm file");
  await download.saveAs(path);
}

function assertSqlite(path) {
  assert.equal(readFileSync(path).subarray(0, 15).toString("latin1"), "SQLite format 3", `${path} is a SQLite file`);
}

function step(message) {
  console.log(`ok  ${message}`);
}

/** A solid-colour PNG — enough of an "image" to hang hotspots on, with no fixture file in the repo. */
function solidPng(width, height) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0xd0)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

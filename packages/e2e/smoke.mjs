// End-to-end smoke test: the editor creates a catalog, saves it, opens it
// again, edits it (including undo/redo) and saves; the viewer then opens the
// result. Runs against the production builds (packages/editor/dist and
// packages/viewer/dist), the same bytes that get deployed — so it catches what
// typecheck and unit tests can't: a bundle that doesn't boot, sql.js/WASM not
// loading, the save and open paths drifting apart, the viewer not reading what
// the editor wrote.
//
// The whole flow runs three times: desktop Chromium, desktop WebKit, and
// WebKit with an iPhone's screen, touch and mobile tab layout — about half of
// the real visitors are on Safari/iOS, which Chromium alone says nothing about.
// It also checks that the editor's anonymous analytics events fire (the
// counter script is blocked and replaced by a recorder, so nothing is sent).
//
//   pnpm --filter @ecm/editor build && pnpm --filter @ecm/viewer build && pnpm --filter @ecm/e2e test
//
// Needs the browsers once: pnpm --filter @ecm/e2e exec playwright install chromium webkit
// (on Linux add --with-deps for the system libraries WebKit needs).
// SMOKE_BROWSERS=chromium,webkit,webkit-phone,chromium-phone picks which to run.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, devices, webkit } from "playwright";
import { serve, solidPng } from "./lib.mjs";

const servers = [];
const editorUrl = await serve("editor", servers);
const viewerUrl = await serve("viewer", servers);

const work = mkdtempSync(join(tmpdir(), "ecm-smoke-"));
const imagePath = join(work, "plan.png");
writeFileSync(imagePath, solidPng(400, 300));

const DESKTOP = { viewport: { width: 1400, height: 900 } };
// iPhone 13: 390x664 viewport, touch, mobile user agent. Real Safari on iOS is WebKit.
const { defaultBrowserType: _ignored, ...IPHONE } = devices["iPhone 13"];
const CONFIGS = {
  chromium: { name: "Chromium, desktop", type: chromium, context: DESKTOP },
  webkit: { name: "WebKit, desktop", type: webkit, context: DESKTOP },
  "webkit-phone": { name: "WebKit, iPhone 13", type: webkit, context: IPHONE },
  // Same phone layout in Chromium: for machines where WebKit can't be installed.
  "chromium-phone": { name: "Chromium, iPhone 13 screen", type: chromium, context: IPHONE },
};
const selected = (process.env.SMOKE_BROWSERS ?? "chromium,webkit,webkit-phone").split(",").map((k) => k.trim());
for (const key of selected) assert.ok(CONFIGS[key], `unknown SMOKE_BROWSERS entry "${key}"`);

let failed = false;
for (const key of selected) {
  const config = CONFIGS[key];
  try {
    await runScenario(config);
  } catch (err) {
    failed = true;
    console.error(`\nSMOKE TEST FAILED [${config.name}]\n`, err);
  }
}
for (const server of servers) server.close();
process.exit(failed ? 1 : 0);

async function runScenario(config) {
  const mobile = !!config.context.isMobile;
  const browser = await config.type.launch();
  const events = [];
  const pageErrors = [];
  const say = (message) => console.log(`ok  [${config.name}] ${message}`);
  try {
    // 1. A new catalog with one image, saved to a file.
    let page = await freshPage("Smoke catalog", editorUrl);
    await page.click("#btn-new");
    await page.waitForSelector("#btn-add-image:not([disabled])");
    await page.setInputFiles("#file-image", imagePath);
    await page.waitForSelector("#stage-img", { state: "attached" });
    const first = join(work, `${config.name}-first.ecatm`);
    await saveTo(page, first);
    assertSqlite(first);
    await closePage(page);
    say("created a catalog with an image and saved it");

    // 2. Open that file, edit it (a hotspot and its table row), save it again.
    page = await freshPage("Untitled", editorUrl);
    await page.setInputFiles("#file-open", first);
    await page.waitForSelector("#stage-img", { state: "attached" });
    assert.equal((await page.$$(".image-list-name")).length, 1, "the saved image is listed after opening");
    assert.ok(!(await page.title()).startsWith("●"), "a freshly opened catalog has no unsaved changes");
    await tapStage(page, 120, 90);
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

    // Undo takes the row away and redo brings it back with its data
    // (keyboard on a computer, the toolbar buttons on a phone).
    const undo = () => (mobile ? page.click("#btn-undo") : page.keyboard.press("Control+z"));
    const redo = () => (mobile ? page.click("#btn-redo") : page.keyboard.press("Control+Shift+z"));
    await undo();
    await page.waitForFunction(() => document.querySelectorAll("tr[data-row-id]").length === 0);
    await redo();
    await page.waitForSelector("tr[data-row-id]");
    const redone = await page.$$eval("tr[data-row-id] td", (tds) => tds.map((td) => td.textContent));
    assert.ok(redone.includes("Hex bolt M8") && redone.includes("HB-M8"), `redo restored the row's data: ${redone.join(" | ")}`);

    // A second hotspot, undone with the toolbar button, must not reach the file.
    await tapStage(page, 260, 180);
    await page.waitForSelector("#form-link");
    await page.fill("#form-link input[name=name]", "Nut");
    await page.fill("#form-link input[name=url]", "p-200");
    await page.click("#form-link button[type=submit]");
    await page.waitForFunction(() => document.querySelectorAll("#stage-inner .hotspot:not(.pending)").length === 2);
    await page.click("#btn-undo");
    await page.waitForFunction(() => document.querySelectorAll("#stage-inner .hotspot:not(.pending)").length === 1);
    // Zoomed out, the image sits in the middle of the stage and nothing scrolls
    // (it used to hug the left edge of a still full-size box, scrollbars and all).
    await showTab(page, "stage");
    await page.click("#btn-zoom-out");
    await page.click("#btn-zoom-out");
    const stage = await page.evaluate(() => {
      const scroll = document.getElementById("stage-scroll");
      const box = scroll.getBoundingClientRect();
      const img = document.getElementById("stage-img").getBoundingClientRect();
      return { left: img.left - box.left, right: box.right - img.right, overflowX: scroll.scrollWidth - scroll.clientWidth };
    });
    assert.ok(Math.abs(stage.left - stage.right) <= 1, `zoomed-out image is centered (gaps ${stage.left} / ${stage.right})`);
    assert.ok(stage.left > 1, "zoomed-out image has room around it");
    assert.equal(stage.overflowX, 0, "a zoomed-out image does not scroll sideways");
    const second = join(work, `${config.name}-second.ecatm`);
    await saveTo(page, second);
    assert.ok(!(await page.title()).startsWith("●"), "saving clears the unsaved mark");
    await closePage(page);
    say("opened it, added a hotspot and a row, undid and redid, undid a second hotspot, saved");

    // 3. Open the saved result in a clean tab: the edit must have made it to disk.
    page = await freshPage("Untitled", editorUrl);
    await page.setInputFiles("#file-open", second);
    await page.waitForSelector("#stage-img", { state: "attached" });
    const hotspots = await page.$$eval("#stage-inner .hotspot:not(.pending)", (els) => els.map((e) => e.textContent));
    assert.deepEqual(hotspots, ["Bolt"], "the saved hotspot survived the round trip and the undone one did not");
    const cells = await page.$$eval("tr[data-row-id] td", (tds) => tds.map((td) => td.textContent));
    assert.ok(cells.includes("p-100") && cells.includes("Hex bolt M8") && cells.includes("HB-M8"), `the row survived: ${cells.join(" | ")}`);
    // The page-view path the counter is given has the per-visit parts taken out.
    const filed = await page.evaluate(() => window.goatcounter.path("/editor/?lang=ru&src=blob%3Ahttps%3A%2F%2Ftapalog.com%2F7b1c"));
    assert.equal(filed, "/editor/?lang=ru&src=blob", "blob: sources are filed under one path");
    await closePage(page);
    say("reopened the saved file in the editor: hotspot and row are there, the undone hotspot is not");

    // 4. The viewer reads what the editor wrote: picture, hotspot, table row.
    page = await freshPage("Untitled", viewerUrl);
    await page.setInputFiles("#file-open", second);
    await page.waitForSelector("#stage-img", { state: "attached" });
    const viewerHotspots = await page.$$eval(".hotspot[data-id]", (els) => els.map((e) => e.textContent.trim()));
    assert.deepEqual(viewerHotspots, ["Bolt"], "the viewer shows the hotspot");
    const viewerRow = await page.$eval("tr[data-url='p-100']", (tr) => tr.textContent);
    assert.ok(viewerRow.includes("Hex bolt M8") && viewerRow.includes("HB-M8"), `the viewer lists the row: ${viewerRow}`);
    await showTab(page, "stage");
    await (mobile ? page.tap(".hotspot[data-id]") : page.click(".hotspot[data-id]"));
    await page.waitForFunction(() => document.querySelector("tr[data-url='p-100']")?.classList.contains("selected"));
    await closePage(page);
    say("opened the saved file in the viewer: hotspot shown, row listed, selecting the hotspot selects its row");

    // 5. The editor reported what happened — action names only.
    for (const name of ["editor-new-catalog", "editor-add-image", "editor-add-hotspot", "editor-save"]) {
      assert.ok(events.includes(name), `analytics event "${name}" fired (got: ${events.join(", ") || "none"})`);
    }
    say(`analytics events fired: ${[...new Set(events)].join(", ")}`);
  } finally {
    await browser.close();
  }

  /** A tab on an app with the picker APIs removed, so Save downloads and Open uses the file input. */
  async function freshPage(catalogName, url) {
    const context = await browser.newContext({ acceptDownloads: true, ...config.context });
    const page = await context.newPage();
    // The real counter script never loads; a recorder stands in so we can see what would be sent.
    await page.route(/gc\.zgo\.at/, (route) => route.abort());
    await page.addInitScript(() => {
      delete window.showSaveFilePicker;
      delete window.showOpenFilePicker;
      window.__events = [];
      window.goatcounter = { count: (vars) => window.__events.push(vars.path) };
    });
    page.on("dialog", (d) => void d.accept(catalogName));
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.goto(url);
    await page.waitForSelector("#btn-open");
    return page;
  }

  async function closePage(page) {
    events.push(...(await page.evaluate(() => window.__events ?? [])));
    await page.context().close();
    assert.deepEqual(pageErrors, [], "no uncaught errors in the page");
  }

  /** On a phone only one of Images / Diagram / Details is on screen at a time. */
  async function showTab(page, tab) {
    if (!mobile) return;
    await page.click(`.mobile-tab-btn[data-tab="${tab}"]`);
  }

  /** Click (or tap, on a phone) a point of the diagram, given in image pixels. */
  async function tapStage(page, x, y) {
    await showTab(page, "stage");
    const box = await (await page.$("#stage-img")).boundingBox();
    if (mobile) await page.touchscreen.tap(box.x + x, box.y + y);
    else await page.mouse.click(box.x + x, box.y + y);
  }

  async function saveTo(page, path) {
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#btn-save")]);
    assert.match(download.suggestedFilename(), /\.ecatm$/, "Save downloads a .ecatm file");
    await download.saveAs(path);
  }
}

function assertSqlite(path) {
  assert.equal(readFileSync(path).subarray(0, 15).toString("latin1"), "SQLite format 3", `${path} is a SQLite file`);
}

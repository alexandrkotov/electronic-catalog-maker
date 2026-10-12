// End-to-end test of undo in a shared session: two real browsers join the same
// room on the real collab-server and edit one picture together.
//   - each person's Undo takes back only their own edits, on both screens;
//   - when someone else removes what an edit of yours touched, the undo of that
//     edit goes away while the rest of your history keeps working.
// Runs against the production editor build, like smoke.mjs.
//
//   pnpm --filter @ecm/editor build && pnpm --filter @ecm/e2e exec node collab.mjs
//
// Needs bun (the collab server is a Bun app) and Chromium.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { serve, solidPng } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const servers = [];
const editorUrl = await serve("editor", servers);

const work = mkdtempSync(join(tmpdir(), "ecm-collab-"));
const imagePath = join(work, "plan.png");
writeFileSync(imagePath, solidPng(400, 300));

// The collab server, as its own process; wait for its "listening" line.
const serverProcess = spawn("bun", [join(here, "collab-server.ts")], { stdio: ["ignore", "pipe", "inherit"] });
await new Promise((ready, fail) => {
  const timer = setTimeout(() => fail(new Error("collab server did not start in 20 s")), 20_000);
  serverProcess.on("error", fail);
  serverProcess.stdout.on("data", (chunk) => {
    if (String(chunk).includes("listening")) {
      clearTimeout(timer);
      ready();
    }
  });
});

const browser = await chromium.launch();
let failed = false;
try {
  await scenario();
  console.log("ok  undo in a shared session: own edits only, on both screens, dropped when someone else removes what they touch");
} catch (err) {
  failed = true;
  console.error("\nCOLLAB UNDO TEST FAILED\n", err);
} finally {
  await browser.close();
  serverProcess.kill();
  for (const server of servers) server.close();
}
process.exit(failed ? 1 : 0);

async function scenario() {
  const pageErrors = [];
  async function newPage() {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await context.newPage();
    await page.route(/gc\.zgo\.at/, (route) => route.abort());
    await page.addInitScript(() => {
      delete window.showSaveFilePicker;
      delete window.showOpenFilePicker;
    });
    page.on("dialog", (d) => void d.accept("Shared catalog"));
    page.on("pageerror", (e) => pageErrors.push(e.message));
    return page;
  }

  const hotspotNames = (page) => page.$$eval("tr[data-link-id] td:first-child", (tds) => tds.map((td) => td.textContent).sort());
  async function expectHotspots(page, expected) {
    await page
      .waitForFunction(
        (want) => JSON.stringify([...document.querySelectorAll("tr[data-link-id] td:first-child")].map((td) => td.textContent).sort()) === JSON.stringify(want),
        expected,
        { timeout: 8000 },
      )
      .catch(async () => {
        throw new Error(`hotspots are ${JSON.stringify(await hotspotNames(page))}, expected ${JSON.stringify(expected)}`);
      });
  }
  /** A hotspot and its table row, placed at (x, y) of the picture. */
  async function addHotspot(page, x, y, name, url, sku) {
    const box = await (await page.$("#stage-img")).boundingBox();
    await page.mouse.click(box.x + x, box.y + y);
    await page.waitForSelector("#form-link");
    await page.fill("#form-link input[name=name]", name);
    await page.fill("#form-link input[name=url]", url);
    await page.click("#form-link button[type=submit]");
    await page.waitForSelector("#form-row");
    await page.fill("#form-row input[name=name]", `${name} row`);
    await page.fill("#form-row input[name=sku]", sku);
    await page.click("#form-row button[type=submit]");
    await page.waitForSelector(`tr[data-row-id]:has-text('${name} row')`);
  }
  const undoTitle = (page) => page.getAttribute("#btn-undo", "title");
  const undoEnabled = async (page) => !(await page.$eval("#btn-undo", (b) => b.disabled));
  const joinWithName = async (page, name) => {
    await page.waitForSelector("#collab-name-input");
    await page.fill("#collab-name-input", name);
    await page.click("#collab-name-submit");
    await page.waitForSelector("#btn-leave-collab", { timeout: 15_000 });
  };

  // A: a catalog with one hotspot, then a shared session.
  const a = await newPage();
  await a.goto(editorUrl);
  await a.waitForSelector("#btn-new");
  await a.click("#btn-new");
  await a.waitForSelector("#btn-add-image:not([disabled])");
  await a.setInputFiles("#file-image", imagePath);
  await a.waitForSelector("#stage-img", { state: "attached" });
  await addHotspot(a, 60, 60, "Bolt", "p-100", "B-1");
  await a.click("#btn-start-collab");
  await a.waitForSelector("#btn-confirm-yes, #collab-name-input", { timeout: 15_000 }); // "no public address" confirm comes first on a local server
  if (await a.$("#btn-confirm-yes")) await a.click("#btn-confirm-yes");
  await joinWithName(a, "Ann");
  const link = a.url();
  assert.match(link, /collab=/, "the address bar carries the session");
  assert.equal(await undoEnabled(a), false, "history starts empty when the session begins");

  // B joins through the link.
  const b = await newPage();
  await b.goto(link);
  await joinWithName(b, "Bob");
  await b.waitForSelector("#stage-img", { state: "attached" });
  await expectHotspots(b, ["Bolt"]);

  // Each undoes only their own work, and everyone sees it.
  await addHotspot(a, 150, 60, "A1", "p-a1", "A-1");
  await addHotspot(b, 250, 160, "B1", "p-b1", "B-1");
  await expectHotspots(a, ["A1", "B1", "Bolt"]);
  await expectHotspots(b, ["A1", "B1", "Bolt"]);
  assert.equal(await undoEnabled(a), true, "A can undo although B edited in between");
  await a.click("#btn-undo"); // the row
  await a.click("#btn-undo"); // the hotspot
  await expectHotspots(a, ["B1", "Bolt"]);
  await expectHotspots(b, ["B1", "Bolt"]);
  assert.equal(await undoEnabled(a), false, "A has nothing else to undo — Bolt was placed before the session");
  assert.equal(await undoEnabled(b), true, "B's own edit is still undoable after A's undos");
  await a.click("#btn-redo");
  await a.click("#btn-redo");
  await expectHotspots(b, ["A1", "B1", "Bolt"]);

  // B removes the table row A has just edited: what A could undo on it is gone,
  // A's hotspot of that name and the older history stay.
  await addHotspot(a, 300, 80, "A2", "p-a2", "A-2");
  await a.click("tr[data-row-id]:has-text('A2 row')");
  await a.waitForSelector("#form-edit-row");
  await a.fill("#form-edit-row input[name=name]", "A2 renamed");
  await a.click("#form-edit-row button[type=submit]");
  await a.waitForSelector("tr[data-row-id]:has-text('A2 renamed')");
  assert.match(await undoTitle(a), /edit table row/i);
  await expectHotspots(b, ["A1", "A2", "B1", "Bolt"]);
  await b.waitForSelector("tr[data-row-id]:has-text('A2 renamed')");
  await b.click("tr[data-row-id]:has-text('A2 renamed')");
  await b.click("#btn-delete-row");
  await b.click("#btn-confirm-yes");
  await a.waitForFunction(() => document.querySelectorAll("tr[data-row-id]").length === 3, null, { timeout: 8000 });
  await a.waitForFunction(() => /add hotspot/i.test(document.getElementById("btn-undo").title), null, { timeout: 8000 });
  assert.equal(await undoEnabled(a), true, "A's other entries survive");
  await a.click("#btn-undo");
  await expectHotspots(a, ["A1", "B1", "Bolt"]);
  await expectHotspots(b, ["A1", "B1", "Bolt"]);
  while (await undoEnabled(a)) await a.click("#btn-undo");
  await expectHotspots(a, ["B1", "Bolt"]);
  await expectHotspots(b, ["B1", "Bolt"]);

  assert.deepEqual(pageErrors, [], "no uncaught errors in either page");
}

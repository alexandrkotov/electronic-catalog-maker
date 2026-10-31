// End-to-end test of the viewer engine used as a library, the way a host
// application drives it: `mountViewer` straight from source (harness/), the
// controller's getView/setView, the "view" and "region" events, and the Area
// tool with a mouse and with a finger. Complements view.mjs, which covers the
// standalone page's links.
//
//   pnpm --filter @ecm/e2e exec node engine.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
// vite is a dependency of the apps, not of this package: borrow the viewer's.
const { createServer: createViteServer } = await import(createRequire(resolve(here, "../viewer/package.json")).resolve("vite"));

const vite = await createViteServer({ root: resolve(here, "harness"), configFile: false, server: { fs: { allow: [resolve(here, "../..")] } }, logLevel: "error" });
await vite.listen();
const harnessUrl = vite.resolvedUrls.local[0];
const catalogBytes = readFileSync(resolve(here, "../../demo/furniture.ecatm"));
const catalogServer = createHttpServer((req, res) => res.writeHead(200, { "access-control-allow-origin": "*" }).end(catalogBytes));
await new Promise((ok) => catalogServer.listen(0, "127.0.0.1", ok));
const catalogUrl = `http://127.0.0.1:${catalogServer.address().port}/furniture.ecatm`;

const browser = await chromium.launch();
let failed = false;
const say = (msg) => console.log(`  ok  ${msg}`);

async function boot(contextOptions) {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  page.on("pageerror", (err) => assert.fail(`page error: ${err.message}`));
  await page.goto(`${harnessUrl}?src=${encodeURIComponent(catalogUrl)}`);
  await page.locator("#stage-img").waitFor();
  await page.waitForTimeout(500);
  return { context, page };
}
const getView = (page) => page.evaluate(() => window.ctrl.getView());
const setView = (page, view) => page.evaluate((v) => window.ctrl.setView(v), view);
const events = (page, type) => page.evaluate((t) => window.__events.filter((e) => e.type === t).map((e) => e.detail), type);
/** The region box as fractions of the image, measured from the DOM, not from the engine's own state. */
const boxFractions = (page) =>
  page.evaluate(() => {
    const img = document.getElementById("stage-img").getBoundingClientRect();
    const box = document.querySelector(".region-box")?.getBoundingClientRect();
    if (!box) return null;
    return { x: (box.left - img.left) / img.width, y: (box.top - img.top) / img.height, w: box.width / img.width, h: box.height / img.height };
  });
const near = (a, b, eps = 0.02) => Math.abs(a - b) < eps;
const closeBox = (a, b, eps) => !!a && !!b && near(a.x, b.x, eps) && near(a.y, b.y, eps) && near(a.w, b.w, eps) && near(a.h, b.h, eps);

try {
  // ---- setView / getView
  let { context, page } = await boot({ viewport: { width: 1400, height: 900 } });
  const v0 = await getView(page);
  assert.equal(v0.v, 1);

  await setView(page, { v: 1, imageId: v0.imageId, zoom: 3, cx: 0.3, cy: 0.6 });
  let v = await getView(page);
  assert.ok(near(v.zoom, 3, 0.01) && near(v.cx, 0.3, 0.01) && near(v.cy, 0.6, 0.01), `zoom/cx/cy applied: ${JSON.stringify(v)}`);
  say("setView: zoom, cx, cy land where asked");

  await setView(page, { v: 1, imageId: v0.imageId, region: { x: 0.4, y: 0.4, w: 0.1, h: 0.1 } });
  v = await getView(page);
  assert.ok(v.zoom > 1 && near(v.cx, 0.45, 0.01) && near(v.cy, 0.45, 0.01), `a region without zoom is zoomed to and centered: ${JSON.stringify(v)}`);
  assert.deepEqual(v.region, { x: 0.4, y: 0.4, w: 0.1, h: 0.1 });
  say("setView: a region without zoom is fitted and centered");

  await setView(page, { v: 1, imageId: v0.imageId, zoom: 1 });
  v = await getView(page);
  assert.equal(v.zoom, 1);
  assert.equal(v.region, undefined, "a view without a region clears it");
  say("setView: zoom 1 is the fitted image, and clears the region");

  await page.setViewportSize({ width: 600, height: 800 });
  await page.waitForTimeout(300);
  await setView(page, { v: 1, imageId: v0.imageId, zoom: 3, cx: 0.3, cy: 0.6 });
  v = await getView(page);
  assert.ok(near(v.zoom, 3, 0.01) && near(v.cx, 0.3, 0.01) && near(v.cy, 0.6, 0.01), "the same view in a window of another size");
  say("setView: same view reproduces in a 600x800 window");

  const before = await getView(page);
  await setView(page, { v: 1, imageId: 99999 });
  assert.deepEqual(await getView(page), before, "an unknown image is ignored");
  await setView(page, { v: 1, imageId: v0.imageId, linkId: 99999, zoom: 2, cx: 0.5, cy: 0.5 });
  assert.equal((await getView(page)).linkId, undefined, "an unknown hotspot is dropped");
  say("setView: stale ids are skipped, not errors");

  const linkIds = await page.$$eval(".hotspot[data-id]", (els) => els.map((e) => Number(e.dataset.id)));
  const seen = (await events(page, "view")).length;
  await setView(page, { v: 1, imageId: v0.imageId, linkId: linkIds[0] });
  await page.waitForTimeout(500);
  assert.equal((await getView(page)).linkId, linkIds[0]);
  const viewEvents = await events(page, "view");
  assert.ok(viewEvents.length > seen && viewEvents.at(-1).linkId === linkIds[0], "a view event follows setView");
  assert.equal((await events(page, "select")).length, 0, "setView sends no select event");
  say("setView: selects the hotspot, view event follows, no select event");
  await context.close();

  // ---- Area tool, mouse
  ({ context, page } = await boot({ viewport: { width: 1400, height: 900 } }));
  assert.equal(await page.locator("#btn-region").count(), 1, "the Area button is offered");
  assert.equal(await page.locator("#btn-region-clear").count(), 0, "no clear button without a region");

  await page.locator("#btn-region").click();
  assert.equal(await page.locator(".stage-scroll.region-mode").count(), 1, "armed");
  assert.equal(await page.locator(".region-hint").count(), 1, "hint shown");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".stage-scroll.region-mode").count(), 0, "Esc disarms");

  await page.locator("#btn-region").click();
  const imgBox = await page.locator("#stage-img").boundingBox();
  const at = (fx, fy) => [imgBox.x + imgBox.width * fx, imgBox.y + imgBox.height * fy];
  await page.mouse.move(...at(0.2, 0.2));
  await page.mouse.down();
  await page.mouse.move(...at(0.35, 0.3), { steps: 5 });
  assert.equal(await page.locator(".region-box").count(), 1, "the rectangle is drawn while dragging");
  await page.mouse.move(...at(0.6, 0.5), { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  let regionEvents = await events(page, "region");
  assert.equal(regionEvents.length, 1, "one region event");
  assert.ok(closeBox(regionEvents[0], { x: 0.2, y: 0.2, w: 0.4, h: 0.3 }), `the event has the dragged rectangle: ${JSON.stringify(regionEvents[0])}`);
  assert.equal(await page.locator(".stage-scroll.region-mode").count(), 0, "the tool disarms after one area");
  const marked = await getView(page);
  assert.ok(closeBox(marked.region, regionEvents[0]), "the view carries the region");
  assert.equal(marked.linkId, undefined, "dragging over markers selected nothing");
  assert.equal((await events(page, "select")).length, 0);
  assert.equal(await page.locator("#btn-region-clear").count(), 1, "the clear button appears");
  assert.ok(closeBox(await boxFractions(page), marked.region), "the box on screen is where the event says");
  say("mouse: drag draws the area, sends one region event, puts it in the view");

  for (let i = 0; i < 3; i++) await page.locator("#btn-zoom-in").click();
  await page.evaluate(() => {
    const el = document.getElementById("stage-scroll");
    el.scrollLeft = el.scrollWidth * 0.1;
    el.scrollTop = el.scrollHeight * 0.1;
  });
  await page.waitForTimeout(100);
  assert.ok(closeBox(await boxFractions(page), marked.region), "the box stays on the same part of the image when zoomed and scrolled");
  await page.locator("#btn-zoom-fit").click();
  assert.ok(closeBox(await boxFractions(page), marked.region), "and when fitted");
  const borderPx = await page.evaluate(() => {
    const img = document.getElementById("stage-img");
    return parseFloat(getComputedStyle(document.querySelector(".region-box")).borderTopWidth) * (img.getBoundingClientRect().width / img.width);
  });
  assert.ok(Math.abs(borderPx - 2) < 0.2, `the frame stays ~2px on screen at any zoom, got ${borderPx}`);
  say("mouse: the frame does not drift or thicken with zoom and scroll");

  await page.locator("#btn-region-clear").click();
  assert.equal(await page.locator(".region-box").count(), 0, "cleared");
  assert.equal((await getView(page)).region, undefined);
  await page.locator("#btn-region").click();
  const again = await page.locator("#stage-img").boundingBox();
  await page.mouse.click(again.x + 100, again.y + 100);
  assert.equal((await getView(page)).region, undefined, "a click makes no area");
  assert.equal(await page.locator(".stage-scroll.region-mode").count(), 1, "the tool stays armed after a click");
  await page.keyboard.press("Escape");

  await setView(page, { v: 1, imageId: marked.imageId, region: { x: 0.3, y: 0.3, w: 0.2, h: 0.2 } });
  assert.ok(closeBox(await boxFractions(page), { x: 0.3, y: 0.3, w: 0.2, h: 0.2 }), "setView draws a region");
  await setView(page, { v: 1, imageId: marked.imageId, zoom: 2 });
  assert.equal(await page.locator(".region-box").count(), 0, "a view without a region removes it");
  assert.equal((await events(page, "region")).length, 1, "clearing and setView send no region events");
  say("mouse: a click is not an area; clear button and setView remove/draw it");
  await context.close();

  // ---- Area tool, finger
  ({ context, page } = await boot({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }));
  await setView(page, { v: 1, imageId: (await getView(page)).imageId, zoom: 1 }); // narrow layout: brings the picture tab forward
  await page.waitForTimeout(300);
  await page.locator("#btn-region").tap();
  const tb = await page.locator("#stage-img").boundingBox();
  const cdp = await context.newCDPSession(page);
  const touch = (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
  const pt = (fx, fy) => [tb.x + tb.width * fx, tb.y + tb.height * fy];
  await touch("touchStart", ...pt(0.25, 0.3));
  for (let i = 1; i <= 8; i++) await touch("touchMove", ...pt(0.25 + (0.4 * i) / 8, 0.3 + (0.3 * i) / 8));
  await touch("touchEnd");
  await page.waitForTimeout(200);
  regionEvents = await events(page, "region");
  assert.equal(regionEvents.length, 1, "a finger drag gives a region event");
  assert.ok(closeBox(regionEvents[0], { x: 0.25, y: 0.3, w: 0.4, h: 0.3 }, 0.04), `the finger's rectangle: ${JSON.stringify(regionEvents[0])}`);
  assert.ok(closeBox(await boxFractions(page), regionEvents[0]), "and it is drawn");
  say("touch: a finger drag draws the area and sends the region event");
  await context.close();
} catch (err) {
  failed = true;
  console.error(err);
}
await browser.close();
await vite.close();
catalogServer.close();
process.exit(failed ? 1 : 0);

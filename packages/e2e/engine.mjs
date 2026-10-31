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
// /private/... answers only to `Authorization: Bearer secret` (what a host passes as fetchInit).
const catalogRequests = [];
const catalogServer = createHttpServer((req, res) => {
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization" };
  if (req.method === "OPTIONS") return void res.writeHead(204, cors).end();
  catalogRequests.push({ url: req.url, authorization: req.headers.authorization });
  if (req.url.startsWith("/private/") && req.headers.authorization !== "Bearer secret") return void res.writeHead(401, cors).end("no");
  res.writeHead(200, cors).end(catalogBytes);
});
await new Promise((ok) => catalogServer.listen(0, "127.0.0.1", ok));
const catalogOrigin = `http://127.0.0.1:${catalogServer.address().port}`;
const catalogUrl = `${catalogOrigin}/furniture.ecatm`;

const browser = await chromium.launch();
let failed = false;
const say = (msg) => console.log(`  ok  ${msg}`);

/** `src: false` mounts an empty viewer (the host opens a catalog itself); `opts` is merged into the mount options. */
async function boot(contextOptions, { src = true, opts = null } = {}) {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const requests = [];
  page.on("request", (req) => requests.push(req.url()));
  page.on("pageerror", (err) => assert.fail(`page error: ${err.message}`));
  const query = new URLSearchParams();
  if (src) query.set("src", catalogUrl);
  if (opts) query.set("opts", JSON.stringify(opts));
  await page.goto(`${harnessUrl}?${query}`);
  if (src) await page.locator("#stage-img").waitFor();
  await page.waitForTimeout(500);
  return { context, page, requests };
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

  // ---- a host application's viewer: "reader" mode, bytes/url opening, actions, theme, no storage, no extra requests
  const DESKTOP = { viewport: { width: 1400, height: 900 } };
  const ACTIONS = [
    { id: "bookmark", label: "Bookmark", icon: "★" },
    { id: "print", label: "Print" },
  ];
  const READER = { mode: "reader", toolbarActions: ACTIONS, persist: false, analytics: false, theme: "dark" };
  ({ context, page } = await boot(DESKTOP, { src: false, opts: READER }));
  await page.locator(".toolbar").waitFor();
  for (const gone of ["h1", "#btn-open", "#btn-open-remote", "#btn-refresh", "#btn-theme", "#lang-select", "#btn-share-view", ".open-demo-link"]) {
    assert.equal(await page.locator(`.toolbar ${gone}, .panel-images ${gone}`).count(), 0, `reader mode has no ${gone}`);
  }
  assert.equal(await page.locator("#btn-search").count(), 1, "reader keeps Search");
  assert.equal(await page.locator(".toolbar-action").count(), 2, "and the host's buttons");
  assert.equal(await page.locator(".toolbar-action:disabled").count(), 2, "disabled while nothing is open");
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark", "theme comes from the host");
  say("reader mode: only Search and the host's buttons in the toolbar; no demo links; theme from the host");

  // open from bytes, with a view
  await page.evaluate(
    async ([url]) => {
      const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
      await window.ctrl.openBytes(bytes, "furniture", { view: { v: 1, imageId: 1, zoom: 3, cx: 0.3, cy: 0.6 } });
    },
    [catalogUrl],
  );
  v = await getView(page);
  assert.ok(near(v.zoom, 3, 0.01) && near(v.cx, 0.3, 0.01) && near(v.cy, 0.6, 0.01), `openBytes shows the view it was given: ${JSON.stringify(v)}`);
  assert.equal(await page.locator(".toolbar-action:disabled").count(), 0, "buttons enabled once a catalog is open");
  assert.equal(await page.locator("#btn-region").count(), 1, "the Area tool is on in reader mode by default");
  say("openBytes: opens from memory and shows the given view");

  // a host button gets the view
  await page.locator('.toolbar-action[data-action-id="bookmark"]').click();
  const calls = await page.evaluate(() => window.__actionCalls);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, "bookmark");
  assert.deepEqual(calls[0].view, await getView(page), "onClick gets the current view");
  say("toolbarActions: onClick receives the view on screen");

  // not a catalog: rejects, viewer survives
  const failure = await page.evaluate(() => window.ctrl.openBytes(new Uint8Array([1, 2, 3]), "junk").then(() => null, (e) => String(e.message)));
  assert.ok(failure, "openBytes rejects on bytes that are not a catalog");
  say(`openBytes: rejects on junk (${failure.slice(0, 40)})`);

  // theme from outside
  await page.evaluate(() => window.ctrl.setTheme("light"));
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "light", "setTheme");

  // use it for a while, then look at what was stored and requested
  await page.evaluate(() => window.ctrl.openBytes(new Uint8Array(0), "x").catch(() => {}));
  await page.evaluate(async ([url]) => {
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    await window.ctrl.openBytes(bytes, "furniture");
  }, [catalogUrl]);
  const divider = await page.locator("#divider-images").boundingBox();
  await page.mouse.move(divider.x + 2, divider.y + 100);
  await page.mouse.down();
  await page.mouse.move(divider.x + 60, divider.y + 100, { steps: 4 });
  await page.mouse.up();
  await page.locator("#btn-zoom-in").click();
  await page.locator(".hotspot[data-id]").first().click();
  await page.locator("#btn-search").click();
  assert.equal(await page.evaluate(() => localStorage.length), 0, "persist: false — nothing in localStorage after resizing, zooming, selecting, searching");
  say("persist: false — localStorage stays empty");
  await context.close();

  // the same session with defaults does write (so the check above can see something)
  ({ context, page } = await boot(DESKTOP));
  const dividerDefault = await page.locator("#divider-images").boundingBox();
  await page.mouse.move(dividerDefault.x + 2, dividerDefault.y + 100);
  await page.mouse.down();
  await page.mouse.move(dividerDefault.x + 60, dividerDefault.y + 100, { steps: 4 });
  await page.mouse.up();
  assert.ok((await page.evaluate(() => localStorage.length)) > 0, "by default a resized panel is remembered");
  await context.close();

  // requests: only the catalog and the page's own assets
  let requests;
  ({ context, page, requests } = await boot(DESKTOP, { src: false, opts: { mode: "reader", persist: false, analytics: false } }));
  catalogRequests.length = 0;
  await page.evaluate(async ([url]) => {
    await window.ctrl.openUrl(url);
  }, [catalogUrl]);
  await page.locator("#btn-search").click();
  await page.waitForTimeout(300);
  const outsiders = requests.filter((u) => !u.startsWith(harnessUrl) && !u.startsWith(catalogOrigin) && !u.startsWith("data:") && !u.startsWith("blob:"));
  assert.deepEqual(outsiders, [], "no requests beyond the page itself and the catalog");
  assert.deepEqual(
    catalogRequests.map((r) => r.url),
    ["/furniture.ecatm"],
    "the catalog is downloaded once and nothing else is asked of its server",
  );
  say(`analytics: false — ${requests.length} requests, none to a third party`);
  await context.close();

  // openUrl with the host's fetch options
  ({ context, page } = await boot(DESKTOP, { src: false, opts: { mode: "reader" } }));
  const privateUrl = `${catalogOrigin}/private/furniture.ecatm`;
  const refused = await page.evaluate((url) => window.ctrl.openUrl(url).then(() => null, (e) => String(e.message)), privateUrl);
  assert.match(refused, /401/, `without credentials the server says no and openUrl rejects: ${refused}`);
  await page.evaluate((url) => window.ctrl.openUrl(url, { fetchInit: { headers: { authorization: "Bearer secret" } }, view: { v: 1, imageId: 1, zoom: 2 } }), privateUrl);
  assert.equal((await getView(page)).imageId, 1);
  assert.ok(near((await getView(page)).zoom, 2, 0.01), "the view given to openUrl is shown");
  say("openUrl: fetchInit reaches the server, failure rejects, view is shown");
  await context.close();

  // fetchInit is reused by Refresh (full toolbar, where Refresh exists)
  ({ context, page } = await boot(DESKTOP, { src: false }));
  catalogRequests.length = 0;
  await page.evaluate((url) => window.ctrl.openUrl(url, { fetchInit: { headers: { authorization: "Bearer secret" } } }), privateUrl);
  await page.locator("#btn-refresh:not([disabled])").click();
  await page.waitForTimeout(500);
  const withAuth = catalogRequests.filter((r) => r.url.startsWith("/private/"));
  assert.equal(withAuth.length, 2, "opened, then refreshed");
  assert.ok(withAuth.every((r) => r.authorization === "Bearer secret"), "Refresh sends the host's headers again");
  say("openUrl: Refresh reuses the host's fetch options");
  await context.close();
} catch (err) {
  failed = true;
  console.error(err);
}
await browser.close();
await vite.close();
catalogServer.close();
process.exit(failed ? 1 : 0);

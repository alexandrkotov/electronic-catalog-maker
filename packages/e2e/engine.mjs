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
// The same catalog with ONE position (shk-001) sold in two conditions — see buyVariants.ts.
const variantRowUrl = "shk-001";
const variantBytes = await (async () => {
  const SQL = await createRequire(resolve(here, "../viewer/package.json"))("sql.js")();
  const db = new SQL.Database(catalogBytes);
  const row = db.exec(`SELECT extra FROM rows WHERE url = '${variantRowUrl}'`)[0].values[0][0];
  const extra = { ...JSON.parse(row), buy_variants: JSON.stringify([
    { sku: "VAR-A", name: "Cornice, new", description: "Factory new", buy_url: "https://payhip.com/buy?link=aaaa1" },
    { sku: "VAR-B", name: "Cornice, used", description: "Used, serviceable", buy_url: "https://payhip.com/buy?link=bbbb2" },
  ]) };
  db.run("UPDATE rows SET extra = ? WHERE url = ?", [JSON.stringify(extra), variantRowUrl]);
  const bytes = Buffer.from(db.export());
  db.close();
  return bytes;
})();
// The same catalog with a second row under the Cornice's marker (another model — see callout.ts).
const calloutRowUrl = "shk-001~2";
const calloutBytes = await (async () => {
  const SQL = await createRequire(resolve(here, "../viewer/package.json"))("sql.js")();
  const db = new SQL.Database(catalogBytes);
  db.run("INSERT INTO rows (image_id, url, name, sku, description, extra) VALUES (1, ?, 'Cornice, model B', 'SHK-001B', '', ?)", [
    calloutRowUrl,
    JSON.stringify({ callout: "shk-001", Model: "B" }),
  ]);
  const bytes = Buffer.from(db.export());
  db.close();
  return bytes;
})();
// /private/... answers only to `Authorization: Bearer secret` (what a host passes as fetchInit).
const catalogRequests = [];
const catalogServer = createHttpServer((req, res) => {
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization" };
  if (req.method === "OPTIONS") return void res.writeHead(204, cors).end();
  catalogRequests.push({ url: req.url, authorization: req.headers.authorization });
  if (req.url.startsWith("/private/") && req.headers.authorization !== "Bearer secret") return void res.writeHead(401, cors).end("no");
  res.writeHead(200, cors).end(req.url.startsWith("/variants/") ? variantBytes : req.url.startsWith("/callout/") ? calloutBytes : catalogBytes);
});
await new Promise((ok) => catalogServer.listen(0, "127.0.0.1", ok));
const catalogOrigin = `http://127.0.0.1:${catalogServer.address().port}`;
const catalogUrl = `${catalogOrigin}/furniture.ecatm`;
const variantsUrl = `${catalogOrigin}/variants/furniture.ecatm`;
const calloutUrl = `${catalogOrigin}/callout/furniture.ecatm`;

const browser = await chromium.launch();
let failed = false;
const say = (msg) => console.log(`  ok  ${msg}`);

/** `src: false` mounts an empty viewer (the host opens a catalog itself); `opts` is merged into the mount options. */
async function boot(contextOptions, { src = true, opts = null, init = null } = {}) {
  const context = await browser.newContext(contextOptions);
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  const requests = [];
  page.on("request", (req) => requests.push(req.url()));
  page.on("pageerror", (err) => assert.fail(`page error: ${err.message}`));
  const query = new URLSearchParams();
  if (src) query.set("src", typeof src === "string" ? src : catalogUrl);
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

  // search(query) / clearSearch(): the host's own search box drives the viewer's search
  ({ context, page } = await boot(DESKTOP, { src: true, opts: { mode: "reader" } }));
  const resultCount = async () => page.locator("#search-results li[data-url]").count();
  const word = await page.evaluate(() => {
    const first = document.querySelector(".data-table tbody tr td, table tbody tr td");
    return (first?.textContent ?? "").trim().split(/\s+/)[0];
  });
  assert.ok(word, "a word to search for");
  await page.locator("#btn-search").waitFor();
  await page.evaluate(() => document.body.insertAdjacentHTML("beforeend", '<input id="host-box">'));
  await page.locator("#host-box").focus();
  const found = await page.evaluate((q) => window.ctrl.search(q), word);
  assert.ok(found > 0, `search("${word}") reports its matches: ${found}`);
  assert.ok((await resultCount()) > 0, "the panel lists the results");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "host-box", "the host keeps the keyboard focus");
  assert.equal(await page.evaluate(() => window.ctrl.search("zzzz-no-such-thing")), 0, "a miss reports 0");
  assert.equal(await resultCount(), 0, "and lists nothing");
  assert.equal(await page.evaluate((q) => window.ctrl.search(q, { field: "sku" }), word), 0, "the field narrows it");
  await page.evaluate((q) => window.ctrl.search(q), word);
  // a result click goes to its picture and hotspot, the view event follows
  await page.evaluate(() => (window.__events.length = 0));
  const target = page.locator("#search-results li[data-url]").last();
  const targetImage = Number(await target.getAttribute("data-image-id"));
  await target.click();
  await page.waitForTimeout(500);
  v = await getView(page);
  assert.equal(v.imageId, targetImage, "the result's picture is open");
  const hotspotFollow = await events(page, "view");
  assert.ok(hotspotFollow.length > 0 && hotspotFollow.at(-1).imageId === targetImage, "the view event follows the jump");
  assert.equal(await page.locator("#search-panel").count(), 0, "the panel closes after a jump");
  await page.evaluate((q) => window.ctrl.search(q), word);
  assert.equal(await page.locator("#search-panel").count(), 1);
  await page.evaluate(() => window.ctrl.clearSearch());
  assert.equal(await page.locator("#search-panel").count(), 0, "clearSearch closes the panel");
  await page.evaluate((q) => window.ctrl.search(q), word);
  await page.evaluate(() => window.ctrl.clearSearch());
  await page.evaluate(() => window.ctrl.search(""));
  assert.equal(await resultCount(), 0, "the query was forgotten");
  say("search / clearSearch: counts, filled panel, host keeps focus, result jumps with a view event");
  await context.close();

  // Buy variants: one position, several store products — the visitor chooses, nothing is picked for them
  ({ context, page } = await boot(DESKTOP, { src: variantsUrl, init: () => { window.__opened = []; window.open = (u) => { window.__opened.push(String(u)); return null; }; } }));
  const variantBtn = () => page.locator(`.buy-btn[data-variants-url="${variantRowUrl}"]`);
  const cartCount = async () => Number((await page.locator("#btn-cart").textContent()).match(/\((\d+)\)/)[1]);
  assert.match(await variantBtn().textContent(), /Choose condition \(2\)/, "the row shows Choose condition instead of Add to cart");
  assert.equal(await page.locator(`.buy-btn[data-cart-url="${variantRowUrl}"]`).count(), 0, "and has no plain Add button");
  assert.ok(!/buy_variants/.test(await page.locator(`tr[data-url="${variantRowUrl}"]`).first().textContent()), "the raw list is not shown as a characteristic");
  await variantBtn().click();
  assert.equal(await page.locator("#variant-overlay [data-variant-sku]").count(), 2, "the dialog lists both variants");
  assert.match(await page.locator("#variant-overlay").textContent(), /Used, serviceable/, "with their descriptions");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "variant-close", "the cursor starts in the dialog");
  assert.equal(await cartCount(), 0, "opening the dialog adds nothing");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#variant-overlay").count(), 0, "Esc closes it");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-variants-url")), variantRowUrl, "and returns to the button that opened it");
  await variantBtn().click();
  await page.locator("#variant-overlay").click({ position: { x: 3, y: 3 } });
  assert.equal(await page.locator("#variant-overlay").count(), 0, "a click on the shade closes it");
  await variantBtn().click();
  await page.locator('[data-variant-sku="VAR-B"]').click();
  assert.equal(await page.locator("#variant-overlay").count(), 0, "choosing a variant closes the dialog");
  assert.equal(await cartCount(), 1, "and puts exactly that variant in the cart");
  assert.match(await variantBtn().textContent(), /1 ✓/, "the row says one of its variants is in the cart");
  await page.locator("#btn-cart").click();
  assert.equal(await page.locator('#cart-panel li[data-url="variant:VAR-B"]').count(), 1, "the cart lists the chosen variant");
  assert.match(await page.locator("#cart-panel").textContent(), /VAR-B/, "by its own sku");
  await page.locator("#cart-checkout").click();
  const opened = await page.evaluate(() => window.__opened);
  assert.equal(opened.length, 1, "checkout opens one store page");
  assert.ok(opened[0].includes("bbbb2") && !opened[0].includes("aaaa1"), `with the chosen variant's product only: ${opened[0]}`);
  await page.locator("#btn-cart").click();
  await page.locator('#cart-panel [data-remove-url="variant:VAR-B"]').click();
  assert.equal(await cartCount(), 0, "✕ takes the variant out of the cart");
  assert.equal(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("ecm-viewer-cart:")).length), 1, "the cart is kept per catalog as before");
  say("buy variants: Choose condition dialog (Esc, shade, focus), only the chosen product in the cart and at checkout, ✕ removes it");
  await context.close();

  // Bookmarks: the standard viewer keeps them in the browser, per catalog; a host can bring its own store
  ({ context, page } = await boot(DESKTOP));
  const bookmarkLis = () => page.locator("#bookmarks-panel li[data-bookmark-id]");
  assert.equal(await page.locator("#btn-bookmarks").count(), 1, "the standard viewer has a Bookmarks button");
  await page.locator("#btn-bookmarks").click();
  assert.match(await page.locator("#bookmarks-panel .hint").first().textContent(), /No bookmarks yet/, "an empty list says so");
  assert.ok((await page.locator("#bookmark-label").inputValue()).length > 0, "the name starts as the picture's name");
  await page.locator("#btn-bookmarks").click();
  assert.equal(await page.locator("#bookmarks-panel").count(), 0, "the button closes the panel");
  // The panel has no close button: Esc and a click anywhere outside it close it too
  await page.locator("#btn-bookmarks").click();
  assert.equal(await page.evaluate(() => document.activeElement?.id), "bookmark-label", "opening it puts the cursor in the name field");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#bookmarks-panel").count(), 0, "Esc closes the panel");
  await page.locator("#btn-bookmarks").click();
  await page.locator("#bookmark-label").click();
  assert.equal(await page.locator("#bookmarks-panel").count(), 1, "a click inside the panel keeps it open");
  await page.locator(".panel-images li").first().click();
  assert.equal(await page.locator("#bookmarks-panel").count(), 0, "a click outside the panel closes it");
  await page.locator("#btn-bookmarks").click();
  await page.mouse.click(2, 2);
  assert.equal(await page.locator("#bookmarks-panel").count(), 0, "a click outside the viewer closes it too");
  await setView(page, { v: 1, imageId: 1, zoom: 2, cx: 0.4, cy: 0.5 });
  await page.waitForTimeout(300);
  const bookmarkedView = await getView(page);
  await page.locator("#btn-bookmarks").click();
  await page.locator("#bookmark-label").fill("Corner of the sofa");
  await page.locator("#bookmark-add").click();
  assert.equal(await bookmarkLis().count(), 1, "Add puts the view into the list");
  assert.match(await bookmarkLis().first().textContent(), /Corner of the sofa/);
  await setView(page, { v: 1, imageId: 1, zoom: 1 });
  await page.waitForTimeout(300);
  await bookmarkLis().first().click();
  await page.waitForTimeout(400);
  v = await getView(page);
  assert.ok(["zoom", "cx", "cy"].every((k) => near(v[k], bookmarkedView[k], 0.01)) && v.imageId === bookmarkedView.imageId, `a click on a bookmark returns to it: ${JSON.stringify(bookmarkedView)} vs ${JSON.stringify(v)}`);
  assert.equal(await page.locator("#bookmarks-panel").count(), 0, "and closes the panel");
  assert.equal(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("ecm-viewer-bookmarks:")).length), 1, "it is saved in the browser");
  await page.reload();
  await page.locator("#stage-img").waitFor();
  await page.locator("#btn-bookmarks").click();
  assert.equal(await bookmarkLis().count(), 1, "and survives a reload");
  await page.locator("#bookmarks-panel [data-remove-bookmark]").click();
  assert.equal(await bookmarkLis().count(), 0, "✕ removes it");
  await page.locator("#bookmark-label").fill("Enter adds");
  await page.locator("#bookmark-label").press("Enter");
  assert.equal(await bookmarkLis().count(), 1, "Enter in the name field adds too");
  await page.locator("#btn-search").click();
  assert.equal(await page.locator("#bookmarks-panel").count(), 0, "opening Search closes the bookmarks panel");
  say("bookmarks (standard viewer): add by name, return with a click, saved per catalog, remove, Enter, one panel at a time");
  await context.close();

  // persist: false keeps them in memory only; bookmarks: false has no button; reader has none unless given a store
  ({ context, page } = await boot(DESKTOP, { opts: { persist: false } }));
  await page.locator("#btn-bookmarks").click();
  await page.locator("#bookmark-add").click();
  assert.equal(await bookmarkLis().count(), 1, "with persist: false they still work");
  assert.equal(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("ecm-viewer-bookmarks:")).length), 0, "but nothing is written to localStorage");
  await context.close();
  ({ context, page } = await boot(DESKTOP, { opts: { bookmarks: false } }));
  assert.equal(await page.locator("#btn-bookmarks").count(), 0, "bookmarks: false: no button");
  await context.close();
  ({ context, page } = await boot(DESKTOP, { opts: { mode: "reader" } }));
  assert.equal(await page.locator("#btn-bookmarks").count(), 0, "reader mode has no bookmarks of its own");
  await context.close();
  say("bookmarks: persist: false stays in memory, bookmarks: false and reader mode have no button");

  // a host's store: asynchronous, asked each time the panel opens, receives the view and the name
  ({ context, page } = await boot(DESKTOP, { opts: { mode: "reader", persist: false, hostBookmarks: true } }));
  assert.equal(await page.locator("#btn-bookmarks").count(), 1, "a reader-mode viewer given a store has the button");
  await setView(page, { v: 1, imageId: 1, zoom: 3, cx: 0.3, cy: 0.6 });
  await page.waitForTimeout(300);
  const hostMarked = await getView(page);
  await page.locator("#btn-bookmarks").click();
  await page.locator("#bookmark-label").fill("From the host"); // typed while the list is still loading: must survive its arrival
  await page.locator("#bookmark-add").click();
  await bookmarkLis().first().waitFor();
  assert.deepEqual(await page.evaluate(() => window.__bookmarkCalls), ["list", "add:From the host", "list"], "list on open, add with the name, list again");
  await setView(page, { v: 1, imageId: 1, zoom: 1 });
  await bookmarkLis().first().click();
  await page.waitForTimeout(400);
  v = await getView(page);
  assert.ok(near(v.zoom, hostMarked.zoom, 0.01) && near(v.cx, hostMarked.cx, 0.01), "the host's bookmark returns to its view");
  await page.locator("#btn-bookmarks").click();
  await bookmarkLis().first().waitFor();
  await page.locator("#bookmarks-panel [data-remove-bookmark]").click();
  await page.waitForFunction(() => window.__bookmarkCalls.includes("remove:host-1"));
  await page.waitForFunction(() => document.querySelectorAll("#bookmarks-panel li[data-bookmark-id]").length === 0);
  say("bookmarks: a host's own asynchronous store is used for list, add and remove");
  await context.close();

  // WebMCP: the standard viewer offers its tools to a browser agent, a reader-mode one does not
  const stubModelContext = () => {
    window.__agentTools = [];
    document.modelContext = { registerTool: (tool) => window.__agentTools.push(tool.name) };
  };
  ({ context, page } = await boot(DESKTOP, { init: stubModelContext }));
  assert.ok((await page.evaluate(() => window.__agentTools.length)) > 0, "the standard viewer registers its agent tools");
  await context.close();
  ({ context, page } = await boot(DESKTOP, { init: stubModelContext, opts: { mode: "reader" } }));
  assert.equal(await page.evaluate(() => window.__agentTools.length), 0, "a reader-mode viewer registers no agent tools");
  say("WebMCP: tools in the standard viewer, none in reader mode");
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

  // ---- arrow keys: a click in the picture list or the table, then ↑/↓/Home/End
  ({ context, page } = await boot(DESKTOP));
  const shownImage = async () => (await getView(page)).imageId;
  const listItems = page.locator(".panel-images li[data-id]");
  const imageIds = await listItems.evaluateAll((els) => els.map((el) => Number(el.dataset.id)));
  await listItems.nth(0).click();
  await page.keyboard.press("ArrowDown");
  assert.equal(await shownImage(), imageIds[1], "↓ opens the next picture");
  await page.keyboard.press("ArrowDown");
  assert.equal(await shownImage(), imageIds[2], "focus survives the redraw: ↓ again opens the one after");
  await page.keyboard.press("End");
  assert.equal(await shownImage(), imageIds.at(-1), "End opens the last picture");
  await page.keyboard.press("ArrowDown");
  assert.equal(await shownImage(), imageIds.at(-1), "↓ on the last picture stays there");
  await page.keyboard.press("Home");
  assert.equal(await shownImage(), imageIds[0], "Home opens the first picture");
  say("arrow keys: ↑/↓/Home/End in the picture list switch pictures");

  const tableRows = page.locator(".table-panel tbody tr[data-url]");
  const selectedRow = () => page.locator(".table-panel tbody tr.selected").getAttribute("data-url");
  await tableRows.nth(0).click();
  const firstRow = await selectedRow();
  await page.keyboard.press("ArrowDown");
  const secondRow = await selectedRow();
  assert.ok(secondRow && secondRow !== firstRow, `↓ selects the next row: ${firstRow} -> ${secondRow}`);
  assert.equal((await getView(page)).linkId !== undefined, true, "the row's marker is selected on the picture");
  await page.keyboard.press("ArrowUp");
  assert.equal(await selectedRow(), firstRow, "↑ goes back");
  assert.equal(await shownImage(), imageIds[0], "the table keys never switch pictures");
  say("arrow keys: ↑/↓ in the table move the selection between rows");
  await context.close();

  // ---- one marker, several rows (callout.ts)
  ({ context, page } = await boot(DESKTOP, { src: calloutUrl }));
  const selectedRows = () => page.locator(".table-panel tbody tr.selected").evaluateAll((els) => els.map((el) => el.dataset.url));
  const pickedRow = () => page.locator(".table-panel tbody tr.picked").evaluateAll((els) => els.map((el) => el.dataset.url));
  const corniceLink = await page.locator('.hotspot[data-url="shk-001"]').first().getAttribute("data-id");
  await page.locator('.hotspot[data-url="shk-001"]').first().click();
  assert.deepEqual(await selectedRows(), ["shk-001", calloutRowUrl], "the marker selects both rows");
  assert.deepEqual(await pickedRow(), ["shk-001"], "the marker's own row is the picked one");
  await page.locator(`.table-panel tr[data-url="${calloutRowUrl}"]`).click();
  assert.equal(String((await getView(page)).linkId), corniceLink, "a click on the second row selects the shared marker");
  assert.deepEqual(await pickedRow(), [calloutRowUrl]);
  assert.equal(await page.locator(`.table-panel tr[data-url="${calloutRowUrl}"] .extra-cell`).evaluate((td) => td.textContent.includes("callout")), false, "callout is not shown as a characteristic");
  const tableOrder = await page.locator(".table-panel tbody tr").evaluateAll((els) => els.map((el) => el.dataset.url));
  assert.equal(tableOrder[tableOrder.indexOf("shk-001") + 1], calloutRowUrl, "the row added last stands right under its callout's row");
  await page.keyboard.press("ArrowUp");
  assert.deepEqual(await selectedRows(), ["shk-001", calloutRowUrl], "↑ to the row above keeps the shared marker");
  assert.deepEqual(await pickedRow(), ["shk-001"]);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  const afterBlock = tableOrder[tableOrder.indexOf(calloutRowUrl) + 1];
  assert.deepEqual(await selectedRows(), [afterBlock], "↓ past the block steps to the next marker's row");
  assert.deepEqual(await pickedRow(), [], "a marker with one row marks no picked row");
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  assert.deepEqual(await pickedRow(), [calloutRowUrl], "the keys reach the row that only shares a marker");
  assert.equal(String((await getView(page)).linkId), corniceLink);
  say("callout: one marker selects its rows, each row selects the marker, the keys step through every row");
  await context.close();
} catch (err) {
  failed = true;
  console.error(err);
}
await browser.close();
await vite.close();
catalogServer.close();
process.exit(failed ? 1 : 0);

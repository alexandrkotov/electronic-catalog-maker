// End-to-end test of the viewer's "view" (packages/shared/src/view.ts): the
// "view" event, the zoom/cx/cy/rect link parameters, and that a link opens at
// the same place in a window of another size. Runs against the production
// build of the standalone viewer, framed in a tiny host page the way an
// <iframe> embed would be — the engine's events reach the host as postMessage.
//
//   pnpm --filter @ecm/viewer build && pnpm --filter @ecm/e2e exec node view.mjs
import assert from "node:assert/strict";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { serve } from "./lib.mjs";

const servers = [];
const viewerUrl = await serve("viewer", servers);
const demoDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../demo");

// A second origin-less helper: the host page and the demo catalog, on the viewer's own server would
// need a custom handler, so they get a server of their own (CORS open for the catalog).
const HOST = `<!doctype html><meta charset="utf-8"><body style="margin:0">
<iframe id="v" style="border:0;width:100vw;height:100vh"></iframe>
<script>
  window.__events = [];
  addEventListener("message", (e) => { if (e.data && e.data.source === "ecm-viewer") window.__events.push({ at: performance.now(), type: e.data.type, detail: e.data.detail }); });
  document.getElementById("v").src = ${JSON.stringify(viewerUrl)} + location.search;
</script>`;
const hostServer = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/host.html") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(HOST);
  const file = join(demoDir, normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, ""));
  if (!file.startsWith(demoDir) || !existsSync(file) || statSync(file).isDirectory()) return void res.writeHead(404).end();
  res.writeHead(200, { "content-type": "application/octet-stream", "access-control-allow-origin": "*" });
  createReadStream(file).pipe(res);
});
await new Promise((ok) => hostServer.listen(0, "127.0.0.1", ok));
servers.push(hostServer);
const hostUrl = `http://127.0.0.1:${hostServer.address().port}`;
const catalog = `${hostUrl}/furniture.ecatm`;

const browser = await chromium.launch();
let failed = false;
const say = (msg) => console.log(`  ok  ${msg}`);

/** Opens the viewer in a host page of the given size; `query` is added to the viewer's address. */
async function open(size, query = "") {
  const context = await browser.newContext({ viewport: size });
  const page = await context.newPage();
  page.on("pageerror", (err) => assert.fail(`page error: ${err.message}`));
  await page.goto(`${hostUrl}/host.html?src=${encodeURIComponent(catalog)}${query}`);
  const frame = page.frameLocator("#v");
  await frame.locator("#stage-img").waitFor();
  return { page, frame, context, viewerFrame: () => page.frames().find((f) => f.url().startsWith(viewerUrl)) };
}
const settle = (page, ms = 900) => page.waitForTimeout(ms);
const lastView = (page) => page.evaluate(() => [...window.__events].reverse().find((e) => e.type === "ecm-view")?.detail ?? null);
const viewEvents = (page) => page.evaluate(() => window.__events.filter((e) => e.type === "ecm-view"));

try {
  // 1. Opening reports the view, and zooming/scrolling updates it.
  let { page, frame, context, viewerFrame } = await open({ width: 1400, height: 900 });
  await settle(page);
  let view = await lastView(page);
  assert.ok(view, "a view event arrives after the catalog opens");
  assert.equal(view.v, 1);
  assert.equal(typeof view.imageId, "number");
  say(`first view event: ${JSON.stringify(view)}`);

  await frame.locator("#btn-zoom-fit").click();
  await settle(page);
  view = await lastView(page);
  assert.equal(view.zoom, 1, "Fit reports zoom 1");
  assert.equal(view.cx, undefined, "a fitted image has no center to report");
  assert.ok(!/[?&]cx=/.test(viewerFrame().url()), "no cx in the address bar when fitted");
  assert.match(viewerFrame().url(), /[?&]zoom=1(&|$)/, "the address bar says zoom=1");
  say("Fit: zoom 1, no cx/cy, address bar follows");

  for (let i = 0; i < 4; i++) await frame.locator("#btn-zoom-in").click();
  await settle(page);
  view = await lastView(page);
  assert.ok(view.zoom > 1.5, `zoomed in: zoom=${view.zoom}`);
  assert.ok(view.cx >= 0 && view.cx <= 1 && view.cy >= 0 && view.cy <= 1, "cx/cy are fractions");
  say(`zoomed in: zoom=${view.zoom} cx=${view.cx} cy=${view.cy}`);

  // 2. Scrolling to a known place reports it.
  const scrolled = await viewerFrame().evaluate(() => {
    const el = document.getElementById("stage-scroll");
    el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
    el.scrollTop = (el.scrollHeight - el.clientHeight) / 2;
    return { w: el.scrollWidth > el.clientWidth, h: el.scrollHeight > el.clientHeight };
  });
  await settle(page);
  view = await lastView(page);
  if (scrolled.w) assert.ok(Math.abs(view.cx - 0.5) < 0.02, `centered horizontally: cx=${view.cx}`);
  if (scrolled.h) assert.ok(Math.abs(view.cy - 0.5) < 0.02, `centered vertically: cy=${view.cy}`);
  say(`scrolled to the middle: cx=${view.cx} cy=${view.cy}`);

  // 3. The event is rate-limited.
  const before = (await viewEvents(page)).length;
  await viewerFrame().evaluate(async () => {
    const el = document.getElementById("stage-scroll");
    for (let i = 0; i < 40; i++) {
      el.scrollLeft += 7;
      el.scrollTop += 5;
      await new Promise((r) => setTimeout(r, 25));
    }
  });
  await settle(page, 400);
  const events = (await viewEvents(page)).slice(before);
  assert.ok(events.length >= 1 && events.length <= 6, `~1s of scrolling gave ${events.length} events`);
  for (let i = 1; i < events.length; i++) assert.ok(events[i].at - events[i - 1].at >= 240, `events ${i - 1} and ${i} are ${Math.round(events[i].at - events[i - 1].at)} ms apart`);
  say(`rate limit: ${events.length} events in ~1 s of scrolling, never closer than 250 ms`);

  // 4. The address bar's link opens at the same place in a window of another size.
  await settle(page, 800);
  const shared = await lastView(page);
  const query = new URL(viewerFrame().url()).search.replace(/^\?/, "");
  const sharedParams = new URLSearchParams(query);
  assert.equal(Number(sharedParams.get("zoom")), shared.zoom, "the link carries the zoom");
  assert.equal(Number(sharedParams.get("cx")), shared.cx, "the link carries cx");
  assert.equal(Number(sharedParams.get("cy")), shared.cy, "the link carries cy");
  await context.close();

  const other = await open({ width: 1000, height: 700 }, `&${["image", "link", "zoom", "cx", "cy"].filter((k) => sharedParams.has(k)).map((k) => `${k}=${sharedParams.get(k)}`).join("&")}`);
  await settle(other.page, 1200);
  const reopened = await lastView(other.page);
  assert.equal(reopened.imageId, shared.imageId, "same image");
  assert.ok(Math.abs(reopened.zoom - shared.zoom) < 0.05, `same relative zoom: ${reopened.zoom} vs ${shared.zoom}`);
  assert.ok(Math.abs(reopened.cx - shared.cx) < 0.03, `same cx: ${reopened.cx} vs ${shared.cx}`);
  assert.ok(Math.abs(reopened.cy - shared.cy) < 0.03, `same cy: ${reopened.cy} vs ${shared.cy}`);
  say(`link reopened in a 1000x700 window: zoom=${reopened.zoom} cx=${reopened.cx} cy=${reopened.cy}`);
  await other.context.close();

  // 5. A region without a zoom is fitted and centered.
  const region = await open({ width: 1400, height: 900 }, "&rect=0.45,0.45,0.1,0.1");
  await settle(region.page, 1200);
  const r = await lastView(region.page);
  assert.deepEqual(r.region, { x: 0.45, y: 0.45, w: 0.1, h: 0.1 }, "the region is carried through");
  assert.ok(r.zoom > 1, `zoomed in on the region: zoom=${r.zoom}`);
  assert.ok(Math.abs(r.cx - 0.5) < 0.03 && Math.abs(r.cy - 0.5) < 0.03, `centered on the region: cx=${r.cx} cy=${r.cy}`);
  assert.match(region.viewerFrame().url(), /rect=0\.45%2C0\.45%2C0\.1%2C0\.1/, "rect stays in the address bar");
  say(`rect=... without zoom: zoom=${r.zoom} cx=${r.cx} cy=${r.cy}`);
  await region.context.close();

  // 6. An old link (no new parameters) still opens as before.
  const old = await open({ width: 1400, height: 900 }, "&image=1");
  await settle(old.page);
  const o = await lastView(old.page);
  assert.equal(o.imageId, 1, "the old image= parameter still selects the image");
  say("old-style link still works");
  await old.context.close();
} catch (err) {
  failed = true;
  console.error(err);
}
await browser.close();
for (const s of servers) s.close();
process.exit(failed ? 1 : 0);

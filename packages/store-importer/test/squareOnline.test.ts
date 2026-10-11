import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runImport } from "../src/importer";
import { mapProduct } from "../src/normalize";
import { createPoliteFetch } from "../src/politeFetch";
import { getPreset, type JsonFeedPreset } from "../src/presets";

const square = getPreset("square-online") as JsonFeedPreset;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const API = "/app/store/api/v28/editor/users/140341570/sites/857042732497492323";

/** The shape of one product in a real Square Online products response (2026-10-11), trimmed to what the preset reads. */
function product(n: number, categoryIds: string[], low = n, high = low) {
  const image = { data: { absolute_url: `https://cdn.test/${n}.png`, absolute_urls: { "1280": `https://cdn.test/${n}.png?width=1280` } } };
  return {
    id: `${n}`,
    visibility: "visible",
    name: `Item ${n}`,
    short_description: `<p><strong><u>Item ${n}</u></strong></p><p><br/></p><p>About ${n}</p>`,
    site_link: `product/item-${n}/${n}`,
    absolute_site_link: `https://www.store.test/product/item-${n}/${n}`,
    // a product in a category lists that category twice: its id, then its older numeric one
    categoryIds,
    price: { low, high, low_formatted: `$${low}.00`, regular_low: low, regular_high: high },
    thumbnail: image,
    images: { data: [image.data, { absolute_url: `https://cdn.test/${n}-back.png` }] },
  };
}

/** The categories response is a flat list; each category names its top-level ancestor. */
const CATEGORIES = [
  { id: "SOAP", site_category_id: "20", name: "Soap", root_parent_category_id: "SOAP", parent: "", depth: 0, children: [] },
  { id: "CANDLES", site_category_id: "15", name: "Candles", root_parent_category_id: "CANDLES", parent: "", depth: 0, children: [] },
  { id: "WOODWICK", site_category_id: "16", name: "Wooden wick", root_parent_category_id: "CANDLES", parent: "CANDLES", depth: 1, children: [] },
];

/** The ids the feed's address needs sit in the home page's inline state — next to a `site_id` that is something else. */
const HOME = `<!DOCTYPE html><html><head><title>Store</title></head><body><script>window.__BOOTSTRAP_STATE__ = {"siteData":{"user":{"id":140341570,"language":"en"},"site":{"id":"7ae70fd0-6d04-11ec-b1a4-653971b60706","site_id":"7ae70fd0","properties":{"classicSiteID":"857042732497492323"}},"domain":{"subdomain":"store.square.site","site_id":857042732497492323}}};</script></body></html>`;

/** A fake store: `pages` are the feed's pages by number. */
function fakeSite(pages: Record<string, unknown[]>, home = HOME) {
  const requested: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const own = url.hostname.replace(/^www\./, "") === "store.test";
    requested.push(own ? url.pathname : url.hostname + url.pathname + url.search);
    if (own && url.pathname === "/") return new Response(home, { headers: { "Content-Type": "text/html" } });
    if (url.hostname === "cdn5.editmysite.com" && url.pathname === `${API}/products`) {
      return Response.json({ data: pages[url.searchParams.get("page") ?? "1"] ?? [], meta: { pagination: { total: 0 } } });
    }
    if (url.hostname === "cdn5.editmysite.com" && url.pathname === `${API}/categories`) return Response.json({ data: CATEGORIES });
    if (url.hostname === "cdn.test") return new Response(PNG, { headers: { "Content-Type": "image/png" } });
    return new Response("<html>not here</html>", { status: 404, headers: { "Content-Type": "text/html" } });
  }) as typeof fetch;
  return { pf: createPoliteFetch({ minGapMs: 0, retries: 0, fetchImpl, sleep: async () => {} }), requested };
}

let dir = "";
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

describe("Square Online preset", () => {
  test("maps one product to one row", () => {
    const names = new Map([["SOAP", "Soap"]]);
    expect(mapProduct(product(8, ["SOAP", "20"]), square, "https://store.test", names)).toEqual({
      name: "Item 8",
      sku: "",
      description: "Item 8\nAbout 8",
      folder: "Soap",
      price: "8.00",
      buyUrl: "https://store.test/product/item-8/8",
      imageUrl: "https://cdn.test/8.png?width=1280",
    });
    // options at different prices come as the product's lowest and highest
    expect(mapProduct(product(8, [], 18, 36), square, "https://store.test", names).price).toBe("18.00–36.00");
    // a category the store doesn't list (unpublished) is no folder, not a raw id in the catalog
    expect(mapProduct(product(8, ["GONE"]), square, "https://store.test", names).folder).toBe("");
    const noGallery = { ...product(8, []), images: { data: [] } };
    expect(mapProduct(noGallery, square, "https://store.test", names).imageUrl).toBe("https://cdn.test/8.png?width=1280");
  });

  test("reads the ids off the home page, pages through the feed on Square's host, names folders by top-level category", async () => {
    dir = mkdtempSync(join(tmpdir(), "ecm-si-"));
    const full = Array.from({ length: 100 }, (_, i) => product(i + 1, ["SOAP", "20"]));
    const { pf, requested } = fakeSite({ "1": full, "2": [product(101, ["WOODWICK", "16"]), product(102, [])] });

    const report = await runImport({ input: "www.store.test/shop", presetId: "auto", outputRoot: dir, pf, photoConcurrency: 4, onProgress: () => {} });

    expect(report.platform).toBe("Square Online");
    expect(report.products).toBe(102);
    expect(report.folders).toEqual(["Soap", "Candles", "Other"]);
    expect(report.noFolder).toEqual([102]);
    const feed = requested.filter((r) => r.startsWith("cdn5.editmysite.com") && r.includes("/products?per_page=100"));
    expect(feed).toEqual([1, 2].map((page) => `cdn5.editmysite.com${API}/products?per_page=100&include=images&visibilities%5B%5D=visible&page=${page}`));
    expect(requested.filter((r) => r.includes("/categories"))).toEqual([`cdn5.editmysite.com${API}/categories?per_page=100`]);
    expect(readdirSync(report.photosDir).length).toBe(102);
    const csv = readFileSync(report.csvPath, "utf-8").split("\r\n");
    expect(csv[101]).toBe('101,Candles,Item 101,,"Item 101\nAbout 101",101.00,https://www.store.test/product/item-101/101');
  });

  test("a site that isn't on Square Online is left alone", async () => {
    dir = mkdtempSync(join(tmpdir(), "ecm-si-"));
    const { pf, requested } = fakeSite({}, "<html><body>A blog</body></html>");
    await expect(runImport({ input: "store.test", presetId: "square-online", outputRoot: dir, pf, photoConcurrency: 1, onProgress: () => {} })).rejects.toThrow(/Square Online store/);
    expect(requested.some((r) => r.startsWith("cdn5."))).toBe(false);
  });
});

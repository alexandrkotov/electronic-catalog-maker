import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runImport } from "../src/importer";
import { mapProduct } from "../src/normalize";
import { createPoliteFetch } from "../src/politeFetch";
import { getPreset, type JsonFeedPreset } from "../src/presets";

const squarespace = getPreset("squarespace") as JsonFeedPreset;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

/** The shape of one product in a real Squarespace `/shop?format=json` response (2026-10-06), trimmed to what the preset reads. */
function product(n: number, categoryId: string | null, prices = [`${n}.00`]) {
  return {
    id: `id-${n}`,
    title: `Item ${n}`,
    fullUrl: `/shop/p/item-${n}`,
    assetUrl: `https://cdn.test/${n}.png`,
    excerpt: `<p data-rte-preserve-empty="true" style="white-space:pre-wrap;">About ${n}</p><ul data-rte-list="default"><li><p>Handmade</p></li></ul>`,
    body: "",
    categoryIds: categoryId ? [categoryId] : [],
    // the item's own priceMoney is 0.00 in the real feed — the price lives on the variants, in cents and as money
    priceMoney: { currency: "USD", value: "0.00" },
    structuredContent: {
      variants: prices.map((value, v) => ({ sku: `SQ${n}${v}`, price: Math.round(Number(value) * 100), priceMoney: { currency: "USD", value } })),
    },
  };
}

/** Same nesting as the real feed: products usually sit in a leaf, two or three levels down. */
const nestedCategories = {
  all: { id: "all", displayName: "All" },
  categories: [
    { id: "soaps", displayName: "Soaps", children: [] },
    {
      id: "oils",
      displayName: "Essential Oils",
      children: [{ id: "oils-english", displayName: "English Lavender", children: [{ id: "oils-english-hydrosol", displayName: "Hydrosol", children: [] }] }],
    },
  ],
};

const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?><urlset>
  <url><loc>https://www.store.test/about</loc></url>
  <url><loc>https://www.store.test/shop</loc></url>
  <url><loc>https://www.store.test/shop/soaps</loc></url>
  <url><loc>https://www.store.test/shop/p/item-1</loc></url>
  <url><loc>https://www.store.test/shop/p/item-2</loc></url>
</urlset>`;

/** A fake site: `pages` are /shop's feed pages, keyed by the `offset` that asks for them ("" = the first). */
function fakeSite(pages: Record<string, { items: unknown[]; nextPageOffset?: number }>, sitemap = SITEMAP) {
  const requested: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requested.push(url.pathname + url.search);
    if (url.pathname === "/sitemap.xml") return new Response(sitemap, { headers: { "Content-Type": "text/xml" } });
    if (url.pathname === "/shop" && url.searchParams.get("format") === "json") {
      const page = pages[url.searchParams.get("offset") ?? ""];
      if (!page) return Response.json({ items: [] });
      const pagination = page.nextPageOffset ? { nextPage: true, nextPageOffset: page.nextPageOffset, pageSize: 200 } : undefined;
      return Response.json({ collection: { typeName: "products" }, nestedCategories, items: page.items, pagination });
    }
    if (url.hostname === "cdn.test") return new Response(PNG, { headers: { "Content-Type": "image/png" } });
    return new Response("<html>not here</html>", { status: 404, headers: { "Content-Type": "text/html" } });
  }) as typeof fetch;
  return { pf: createPoliteFetch({ minGapMs: 0, retries: 0, fetchImpl, sleep: async () => {} }), requested };
}

let dir = "";
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

describe("Squarespace preset", () => {
  test("maps one product to one row", () => {
    const names = new Map([["soaps", "Soaps"]]);
    expect(mapProduct(product(8, "soaps"), squarespace, "https://store.test", names)).toEqual({
      name: "Item 8",
      sku: "SQ80",
      description: "About 8\n• Handmade",
      folder: "Soaps",
      price: "8.00",
      buyUrl: "https://store.test/shop/p/item-8",
      imageUrl: "https://cdn.test/8.png?format=1000w",
    });
    expect(mapProduct(product(8, "soaps", ["12.00", "8.50"]), squarespace, "https://store.test", names).price).toBe("8.50–12.00");
    // an id the category tree doesn't know is no folder, not a raw id in the catalog
    expect(mapProduct(product(8, "gone"), squarespace, "https://store.test", names).folder).toBe("");
  });

  test("finds the store page in the sitemap, follows the feed's own offsets, names folders by top-level category", async () => {
    dir = mkdtempSync(join(tmpdir(), "ecm-si-"));
    const { pf, requested } = fakeSite({
      "": { items: [product(1, "soaps"), product(2, "oils-english-hydrosol")], nextPageOffset: 17 },
      "17": { items: [product(3, "oils-english"), product(4, null)] },
    });

    const report = await runImport({ input: "store.test", presetId: "auto", outputRoot: dir, pf, photoConcurrency: 2, onProgress: () => {} });

    expect(report.platform).toBe("Squarespace");
    expect(report.products).toBe(4);
    expect(report.folders).toEqual(["Soaps", "Essential Oils", "Other"]);
    expect(report.noFolder).toEqual([4]);
    expect(requested.filter((r) => r.startsWith("/shop?"))).toEqual(["/shop?format=json", "/shop?format=json", "/shop?format=json&offset=17"]);
    expect(readdirSync(report.photosDir).sort()).toEqual(["1.png", "2.png", "3.png", "4.png"]);
    const csv = readFileSync(report.csvPath, "utf-8").split("\r\n");
    expect(csv[2]).toBe('2,Essential Oils,Item 2,SQ20,"About 2\n• Handmade",2.00,https://store.test/shop/p/item-2');
  });

  test("a site without a store page fails with a clear message", async () => {
    dir = mkdtempSync(join(tmpdir(), "ecm-si-"));
    const { pf } = fakeSite({}, `<urlset><url><loc>https://www.store.test/about</loc></url></urlset>`);
    await expect(runImport({ input: "store.test", presetId: "squarespace", outputRoot: dir, pf, photoConcurrency: 1, onProgress: () => {} })).rejects.toThrow(/store page/);
    await expect(runImport({ input: "store.test", presetId: "auto", outputRoot: dir, pf, photoConcurrency: 1, onProgress: () => {} })).rejects.toThrow(/platform/);
  });
});

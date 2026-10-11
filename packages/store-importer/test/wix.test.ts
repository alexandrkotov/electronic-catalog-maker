import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runImport, type Progress } from "../src/importer";
import { createPoliteFetch } from "../src/politeFetch";
import { getPreset, type ProductPagesPreset } from "../src/presets";
import { mapPageProduct, productMarkup } from "../src/productPage";

const wix = getPreset("wix") as ProductPagesPreset;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

/** The markup on a real Wix product page (2026-10-11), trimmed to what the importer reads. */
function markup(n: number, extra: Record<string, unknown> = {}) {
  return {
    "@context": "https://schema.org/",
    "@type": "Product",
    name: `Item ${n} &amp; Co`,
    description: `About ${n}.`,
    brand: { "@type": "Brand", name: "Store" },
    image: [
      { "@type": "ImageObject", height: "2992", width: "2992", contentUrl: `https://static.test/media/${n}~mv2.png/v1/fit/w_500,h_500,q_90/file.png`, thumbnail: { "@type": "ImageObject", contentUrl: `https://static.test/media/${n}~mv2.png/v1/fit/w_50,h_50,q_90/file.png` } },
      { "@type": "ImageObject", contentUrl: `https://static.test/media/${n}-back~mv2.png/v1/fit/w_500,h_500,q_90/file.png` },
    ],
    offers: { "@type": "Offer", url: `https://www.store.test/product-page/item-${n}`, priceCurrency: "USD", price: `${n}`, availability: "https://schema.org/InStock" },
    ...extra,
  };
}

const page = (ld: unknown) => `<!DOCTYPE html><html><head><title>Item</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite","name":"Store"}</script>
<script type="application/ld+json">${JSON.stringify(ld)}</script></head><body>…</body></html>`;

const sitemap = (slugs: string[]) => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1" generatedBy="WIX">
${slugs.map((s) => `<url>\n<loc>https://www.store.test/product-page/${s}</loc>\n<lastmod>2026-10-10</lastmod>\n<image:image>\n<image:loc>https://static.test/media/${s}.png</image:loc>\n</image:image>\n</url>`).join("\n")}
</urlset>`;

/** A fake store: `pages` are its product pages' HTML by slug (a slug without one answers 404). */
function fakeSite(pages: Record<string, string>, listed = Object.keys(pages)) {
  const requested: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requested.push(url.hostname === "static.test" ? url.href : url.pathname);
    if (url.pathname === "/store-products-sitemap.xml" && listed.length > 0) return new Response(sitemap(listed), { headers: { "Content-Type": "text/xml" } });
    const html = pages[url.pathname.replace("/product-page/", "")];
    if (url.pathname.startsWith("/product-page/") && html) return new Response(html, { headers: { "Content-Type": "text/html" } });
    if (url.hostname === "static.test") return new Response(PNG, { headers: { "Content-Type": "image/png" } });
    return new Response("<html>not here</html>", { status: 404, headers: { "Content-Type": "text/html" } });
  }) as typeof fetch;
  return { pf: createPoliteFetch({ minGapMs: 0, retries: 0, fetchImpl, sleep: async () => {} }), requested };
}

let dir = "";
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

describe("product markup on a page", () => {
  const url = "https://www.store.test/product-page/item-8";
  const map = (ld: unknown) => mapPageProduct(productMarkup(page(ld)), wix, url);

  test("maps one product to one row", () => {
    expect(map(markup(8))).toEqual({
      name: "Item 8 & Co",
      sku: "",
      description: "About 8.",
      folder: "",
      price: "8.00",
      buyUrl: url,
      // the photo is asked for at catalog size, not the 500px the markup names
      imageUrl: "https://static.test/media/8~mv2.png/v1/fit/w_1000,h_1000,q_90/file.png",
    });
    expect(map(markup(8, { sku: "SOAP-8", category: "Soap" }))).toMatchObject({ sku: "SOAP-8", folder: "Soap" });
  });

  test("reads the price whichever way the shop wrote it", () => {
    const price = (offers: unknown) => map(markup(8, { offers })).price;
    expect(price([{ "@type": "Offer", price: "12.00" }, { "@type": "Offer", price: 8.5 }])).toBe("8.50–12.00");
    expect(price({ "@type": "AggregateOffer", lowPrice: "18", highPrice: "36" })).toBe("18.00–36.00");
    expect(price({ "@type": "Offer", priceSpecification: { "@type": "UnitPriceSpecification", price: "1,250.00" } })).toBe("1250.00");
    expect(price(undefined)).toBe("");
  });

  test("finds the product among other markup, and takes a photo given as a plain address", () => {
    const graph = { "@context": "https://schema.org", "@graph": [{ "@type": "BreadcrumbList" }, { ...markup(8), "@type": ["Product", "ItemPage"], image: "//static.test/plain.jpg" }] };
    expect(map(graph)).toMatchObject({ name: "Item 8 & Co", imageUrl: "https://static.test/plain.jpg" });
    expect(productMarkup(`<script type="application/ld+json">{not json</script>${page(markup(8))}`)).not.toBeNull();
    expect(productMarkup(page({ "@type": "Organization", name: "Store" }))).toBeNull();
  });
});

describe("Wix preset", () => {
  test("reads the product addresses from the store's sitemap, then one page per product", async () => {
    dir = mkdtempSync(join(tmpdir(), "ecm-si-"));
    const { pf, requested } = fakeSite({ "item-1": page(markup(1)), "item-2": page(markup(2)), "item-3": page({ "@type": "WebPage" }) }, ["item-1", "item-2", "item-3", "item-gone", "item-1"]);
    const progress: Progress[] = [];

    const report = await runImport({ input: "www.store.test", presetId: "auto", outputRoot: dir, pf, photoConcurrency: 2, onProgress: (p) => progress.push(p) });

    expect(report.platform).toBe("Wix");
    expect(report.products).toBe(2);
    expect(report.folders).toEqual([""]);
    // a page without a product on it and a page that's gone are named, not silently dropped
    expect(report.unreadPages).toEqual(["https://www.store.test/product-page/item-3", "https://www.store.test/product-page/item-gone"]);
    // the sitemap is asked for once (detection and listing share it), each product page once
    expect(requested.filter((r) => r === "/store-products-sitemap.xml").length).toBe(1);
    expect(requested.filter((r) => r.startsWith("/product-page/"))).toEqual(["item-1", "item-2", "item-3", "item-gone"].map((s) => `/product-page/${s}`));
    expect(progress.filter((p) => p.stage === "pages").at(-1)).toEqual({ stage: "pages", done: 4, total: 4 });
    expect(readdirSync(report.photosDir).sort()).toEqual(["1.png", "2.png"]);
    const csv = readFileSync(report.csvPath, "utf-8").split("\r\n");
    expect(csv[2]).toBe("2,,Item 2 & Co,,About 2.,2.00,https://www.store.test/product-page/item-2");
  });

  test("a site without a product sitemap fails with a clear message", async () => {
    dir = mkdtempSync(join(tmpdir(), "ecm-si-"));
    const { pf } = fakeSite({});
    await expect(runImport({ input: "store.test", presetId: "wix", outputRoot: dir, pf, photoConcurrency: 1, onProgress: () => {} })).rejects.toThrow(/Wix store/);
    await expect(runImport({ input: "store.test", presetId: "auto", outputRoot: dir, pf, photoConcurrency: 1, onProgress: () => {} })).rejects.toThrow(/platform/);
  });
});

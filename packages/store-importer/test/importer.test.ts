import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fillMissingFolders, normalizeStoreUrl, outputFolderName, runImport, type Progress } from "../src/importer";
import { createPoliteFetch } from "../src/politeFetch";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function shopifyProduct(n: number, withImage = true) {
  return {
    title: `Item ${n}`,
    handle: `item-${n}`,
    body_html: `<p>About ${n}</p>`,
    product_type: n % 2 ? "Odd" : "Even",
    variants: [{ sku: n === 3 ? "" : `SKU-${n}`, price: `${n}.00` }],
    images: withImage ? [{ src: `https://cdn.test/${n}.png` }] : [],
  };
}

/** A fake store: `pages[i]` is page i+1 of /products.json; photos by URL; everything else 404. */
function fakeStore(pages: unknown[][], opts: { brokenPhoto?: number } = {}) {
  const requested: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requested.push(url.pathname + url.search);
    if (url.pathname === "/products.json") {
      const page = Number(url.searchParams.get("page") ?? "1");
      if (url.searchParams.get("limit") === "1") return Response.json({ products: pages[0]!.slice(0, 1) });
      return Response.json({ products: pages[page - 1] ?? [] });
    }
    if (url.hostname === "cdn.test") {
      if (url.pathname === `/${opts.brokenPhoto}.png`) return new Response("gone", { status: 404 });
      return new Response(PNG, { headers: { "Content-Type": "image/png" } });
    }
    return new Response("<html>not here</html>", { status: 404, headers: { "Content-Type": "text/html" } });
  }) as typeof fetch;
  const pf = createPoliteFetch({ minGapMs: 0, retries: 0, fetchImpl, sleep: async () => {} });
  return { pf, requested };
}

let dir = "";
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

describe("store url", () => {
  test("normalizes to the origin", () => {
    expect(normalizeStoreUrl(" Shop.Example.com/collections/x?y=1 ")).toBe("https://shop.example.com");
    expect(normalizeStoreUrl("http://a.com")).toBe("http://a.com");
    expect(() => normalizeStoreUrl("localhost")).toThrow();
    expect(outputFolderName("https://www.kith.com")).toBe("kith.com");
  });
});

describe("fillMissingFolders", () => {
  const item = (folder: string) => ({ name: "", sku: "", description: "", folder, price: "", buyUrl: "", imageUrl: null });
  test("untyped products join 'Other' when the rest have folders", () => {
    const items = [item("Mugs"), item(""), item("Coffee"), item("")];
    expect(fillMissingFolders(items)).toEqual([2, 4]);
    expect(items.map((i) => i.folder)).toEqual(["Mugs", "Other", "Coffee", "Other"]);
  });
  test("a store with no folders at all stays in the root", () => {
    const items = [item(""), item("")];
    expect(fillMissingFolders(items)).toEqual([]);
    expect(items.map((i) => i.folder)).toEqual(["", ""]);
  });
});

describe("runImport (Shopify)", () => {
  test("pages until a short page, writes photos + csv, reports gaps", async () => {
    dir = mkdtempSync(join(tmpdir(), "ecm-si-"));
    const page1 = Array.from({ length: 250 }, (_, i) => shopifyProduct(i + 1, i + 1 !== 7));
    const page2 = [shopifyProduct(251), shopifyProduct(252)];
    const { pf, requested } = fakeStore([page1, page2], { brokenPhoto: 5 });
    const progress: Progress[] = [];

    const report = await runImport({ input: "store.test", presetId: "auto", outputRoot: dir, pf, photoConcurrency: 3, onProgress: (p) => progress.push(p) });

    expect(report.platform).toBe("Shopify");
    expect(report.products).toBe(252);
    expect(report.folders).toEqual(["Odd", "Even"]);
    expect(report.noPhoto).toEqual([7]);
    expect(report.photoFailed).toEqual([5]);
    expect(report.noSku).toEqual([3]);
    // page 2 was short, so page 3 is never asked for
    expect(requested.filter((r) => r.startsWith("/products.json?limit=250"))).toEqual(["/products.json?limit=250&page=1", "/products.json?limit=250&page=2"]);
    expect(progress.some((p) => p.stage === "listing" && p.page === 2 && p.products === 252)).toBe(true);

    const photos = readdirSync(report.photosDir);
    expect(photos.length).toBe(250);
    expect(photos).toContain("1.png");
    expect(photos).not.toContain("5.png");
    expect(photos).not.toContain("7.png");

    const csv = readFileSync(report.csvPath, "utf-8").split("\r\n");
    expect(csv[0]).toBe("﻿No.,Folder,Name,SKU,Description,Price,buy_url");
    expect(csv[1]).toBe("1,Odd,Item 1,SKU-1,About 1,1.00,https://store.test/products/item-1");
    expect(csv[252]).toBe("252,Even,Item 252,SKU-252,About 252,252.00,https://store.test/products/item-252");
  });

  test("skipSku leaves the SKU column empty and reports no missing SKUs", async () => {
    dir = mkdtempSync(join(tmpdir(), "ecm-si-"));
    const { pf } = fakeStore([[shopifyProduct(1), shopifyProduct(2), shopifyProduct(3)]]);

    const report = await runImport({ input: "store.test", presetId: "shopify", outputRoot: dir, pf, photoConcurrency: 1, skipSku: true, onProgress: () => {} });

    expect(report.skuSkipped).toBe(true);
    expect(report.noSku).toEqual([]);
    const csv = readFileSync(report.csvPath, "utf-8").split("\r\n");
    expect(csv[0]).toBe("﻿No.,Folder,Name,SKU,Description,Price,buy_url");
    expect(csv[1]).toBe("1,Odd,Item 1,,About 1,1.00,https://store.test/products/item-1");
  });

  test("re-import replaces the previous photos", async () => {
    dir = mkdtempSync(join(tmpdir(), "ecm-si-"));
    const first = fakeStore([[shopifyProduct(1), shopifyProduct(2), shopifyProduct(3)]]);
    await runImport({ input: "store.test", presetId: "shopify", outputRoot: dir, pf: first.pf, photoConcurrency: 1, onProgress: () => {} });
    const second = fakeStore([[shopifyProduct(1)]]);
    const report = await runImport({ input: "store.test", presetId: "shopify", outputRoot: dir, pf: second.pf, photoConcurrency: 1, onProgress: () => {} });
    expect(readdirSync(report.photosDir)).toEqual(["1.png"]);
  });

  test("a store with no recognizable feed fails with a clear message", async () => {
    dir = mkdtempSync(join(tmpdir(), "ecm-si-"));
    const { pf } = fakeStore([[]]);
    const noFeed = createPoliteFetch({ minGapMs: 0, retries: 0, sleep: async () => {}, fetchImpl: (async () => new Response("<html/>", { status: 200 })) as unknown as typeof fetch });
    await expect(runImport({ input: "store.test", presetId: "auto", outputRoot: dir, pf: noFeed, photoConcurrency: 1, onProgress: () => {} })).rejects.toThrow(/platform/);
    await expect(runImport({ input: "store.test", presetId: "shopify", outputRoot: dir, pf: noFeed, photoConcurrency: 1, onProgress: () => {} })).rejects.toThrow(/product list/);
    await expect(runImport({ input: "store.test", presetId: "shopify", outputRoot: dir, pf, photoConcurrency: 1, onProgress: () => {} })).rejects.toThrow(/empty/);
  });
});

describe("politeFetch", () => {
  test("retries 429 honoring Retry-After, then succeeds", async () => {
    const statuses = [429, 503, 200];
    const slept: number[] = [];
    const pf = createPoliteFetch({
      minGapMs: 0,
      retries: 3,
      sleep: async (ms) => void slept.push(ms),
      fetchImpl: (async () => new Response("", { status: statuses.shift()!, headers: { "Retry-After": "2" } })) as unknown as typeof fetch,
    });
    expect((await pf("https://x.test/")).status).toBe(200);
    expect(slept).toEqual([2000, 2000]);
  });

  test("gives up after the retry budget and returns the last response", async () => {
    let calls = 0;
    const pf = createPoliteFetch({ minGapMs: 0, retries: 2, sleep: async () => {}, fetchImpl: (async () => (calls++, new Response("", { status: 500 }))) as unknown as typeof fetch });
    expect((await pf("https://x.test/")).status).toBe(500);
    expect(calls).toBe(3);
  });
});

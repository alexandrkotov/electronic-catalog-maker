import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { outputFolderName, runImport } from "../src/importer";
import { createPoliteFetch } from "../src/politeFetch";
import { getPreset, type SavedPagePreset } from "../src/presets";
import { extractCards, savedPageUrl } from "../src/savedPage";

const payhip = getPreset("payhip") as SavedPagePreset;

/** The shape of a real saved Payhip store page (2026-09-27), trimmed to what the preset reads. */
function card(key: string, name: string, price: string) {
  const s3 = `https://pe56d.s3.amazonaws.com/o_${key}.jpg`;
  return `<div class="card-wrapper product-card-wrapper underline-links-hover " data-product-key="${key}">
    <img srcset="https://payhip.com/cdn-cgi/image/format=auto,width=500/${s3} 500w, https://payhip.com/cdn-cgi/image/format=auto/${s3} 1280w" src="./x_files/o_${key}.jpg">
    <h3 class="card__heading"><a href="https://payhip.com/b/${key}" class="x"> ${name} </a></h3>
    <h4 class="card__heading"><a href="https://payhip.com/b/${key}">${name} (hidden copy)</a></h4>
    <span class="price-item price-item--regular"> ${price} </span>
  </div>`;
}

/** `window` = the page numbers the pagination shows; `current` links to "#". */
function page(savedFrom: string, current: number, window: number[], hasNext: boolean, cards: string[]) {
  const links = window
    .map((n) => `<li><a href="${n === current ? "https://payhip.com/ECMDemoStore#" : `https://payhip.com/ECMDemoStore/collection/all?&amp;page=${(n - 1) * 16}`}">${n}</a></li>`)
    .join("");
  const next = hasNext ? `<li><a href="https://payhip.com/next">Next <span class="dripicons-chevron-right icon-next"></span></a></li>` : "";
  return `<!DOCTYPE html>\n<!-- saved from url=(0031)${savedFrom} -->\n<html><body>${cards.join("")}<ul class="pagination">${links}${next}</ul></body></html>`;
}

const P1 = page("https://payhip.com/ECMDemoStore", 1, [1, 2, 3], true, [card("A1", "Oak &amp; Linen Chair", "$40"), card("A2", 'Terrazzo Bowl, 12"', "Free")]);
const P2 = page("https://payhip.com/ECMDemoStore/collection/all?&page=16", 2, [1, 2, 3], true, [card("B1", "Lamp", "$9")]);
const P3 = page("https://payhip.com/ECMDemoStore/collection/all?&page=32", 3, [2, 3, 4], true, [card("C1", "Rug", "$99"), card("A1", "Oak &amp; Linen Chair", "$40")]);
const P4 = page("https://payhip.com/ECMDemoStore/collection/all?&page=48", 4, [2, 3, 4], false, [card("D1", "Cornice", "Free")]);

describe("extractCards (Payhip)", () => {
  test("first match per field, S3 original out of the srcset, entities decoded", async () => {
    const { cards, current, hasNext, pageLinks } = await extractCards(P1, payhip);
    expect(cards).toEqual([
      { name: "Oak & Linen Chair", price: "$40", image: "https://pe56d.s3.amazonaws.com/o_A1.jpg", buyUrl: "https://payhip.com/b/A1" },
      { name: 'Terrazzo Bowl, 12"', price: "Free", image: "https://pe56d.s3.amazonaws.com/o_A2.jpg", buyUrl: "https://payhip.com/b/A2" },
    ]);
    expect(current).toBe(1);
    expect(hasNext).toBe(true);
    expect(pageLinks.map((l) => l.number)).toEqual([2, 3]);
    expect(pageLinks[0]!.href).toBe("https://payhip.com/ECMDemoStore/collection/all?&page=16");
  });

  test("where the page was saved from", () => {
    expect(savedPageUrl(P2)).toBe("https://payhip.com/ECMDemoStore/collection/all?&page=16");
    expect(savedPageUrl('<link rel="canonical" href="https://s.com/shop">')).toBe("https://s.com/shop");
    expect(savedPageUrl("<html></html>")).toBeNull();
  });

  test("a store under a shared host gets its own output folder", () => {
    expect(outputFolderName("https://payhip.com/ECMDemoStore")).toBe("payhip.com-ECMDemoStore");
  });
});

describe("runImport (saved pages)", () => {
  let dir = "";
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  const photoFetch = createPoliteFetch({
    minGapMs: 0,
    retries: 0,
    sleep: async () => {},
    fetchImpl: (async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "binary/octet-stream" } })) as unknown as typeof fetch,
  });
  const run = (pages: string[]) => {
    dir = mkdtempSync(join(tmpdir(), "ecm-si-"));
    return runImport({ input: "", presetId: "payhip", savedHtml: pages, outputRoot: dir, pf: photoFetch, photoConcurrency: 2, onProgress: () => {} });
  };

  test("only page 1: the pages it links to are reported missing", async () => {
    const r = await run([P1]);
    expect(r.products).toBe(2);
    expect(r.pages).toEqual({
      saved: [1],
      missing: [
        { number: 2, href: "https://payhip.com/ECMDemoStore/collection/all?&page=16" },
        { number: 3, href: "https://payhip.com/ECMDemoStore/collection/all?&page=32" },
      ],
      moreAfter: null,
    });
  });

  test("pages 1-3 with 3 still showing Next: more pages follow", async () => {
    const r = await run([P3, P1, P2]);
    expect(r.origin).toBe("https://payhip.com/ECMDemoStore"); // page 1's address, whatever the pick order
    expect(r.pages!.missing.map((m) => m.number)).toEqual([4]);
  });

  test("all 4 pages: complete, duplicates dropped, photos named by number", async () => {
    const r = await run([P1, P2, P3, P4]);
    expect(r.pages).toEqual({ saved: [1, 2, 3, 4], missing: [], moreAfter: null });
    expect(r.products).toBe(5); // A1 appears on pages 1 and 3
    expect(readdirSync(r.photosDir).sort()).toEqual(["1.jpg", "2.jpg", "3.jpg", "4.jpg", "5.jpg"]);
    const csv = readFileSync(r.csvPath, "utf-8").split("\r\n");
    expect(csv[1]).toBe("1,,Oak & Linen Chair,,,$40,https://payhip.com/b/A1");
    expect(csv[2]).toBe('2,,"Terrazzo Bowl, 12""",,,Free,https://payhip.com/b/A2');
  });

  test("the last saved page still has Next and nothing further is linked", async () => {
    const r = await run([P1, P2, page("https://payhip.com/ECMDemoStore/collection/all?&page=32", 3, [1, 2, 3], true, [card("C1", "Rug", "$99")])]);
    expect(r.pages).toEqual({ saved: [1, 2, 3], missing: [], moreAfter: 3 });
  });

  test("a payhip.com address without the saved page is refused with directions", async () => {
    dir = mkdtempSync(join(tmpdir(), "ecm-si-"));
    await expect(runImport({ input: "payhip.com/ECMDemoStore", presetId: "auto", outputRoot: dir, pf: photoFetch, photoConcurrency: 1, onProgress: () => {} })).rejects.toThrow(/saved page/);
    await expect(run([])).rejects.toThrow(/Pick the saved/);
  });
});

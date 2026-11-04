import { describe, expect, test } from "bun:test";
import { catalogHasAnyBuyTarget, expandVariantRows, parseBuyVariants, rowHasBuyTarget, variantCartKey } from "./buyVariants.js";
import type { CatalogRow } from "./types.js";

const variants = (list: unknown) => ({ buy_variants: JSON.stringify(list) });
const row = (url: string, extra: Record<string, string>, over: Partial<CatalogRow> = {}): CatalogRow => ({
  id: 1,
  imageId: 1,
  url,
  name: "Top cowl",
  sku: "",
  description: "Cowl",
  extra,
  ...over,
});

describe("parseBuyVariants", () => {
  test("reads sku, name, description and link", () => {
    expect(parseBuyVariants(variants([{ sku: "A1", name: "Cowl A", description: "up to 1000", buy_url: "https://shop.example/buy?link=a1" }]))).toEqual([
      { sku: "A1", name: "Cowl A", description: "up to 1000", buyUrl: "https://shop.example/buy?link=a1" },
    ]);
  });

  test("a missing name or description is empty, a missing sku or link drops the entry", () => {
    const got = parseBuyVariants(
      variants([{ sku: "A1", buy_url: "https://s.example/a" }, { name: "no sku", buy_url: "https://s.example/b" }, { sku: "C", name: "no link" }, { sku: "  ", buy_url: "https://s.example/d" }]),
    );
    expect(got).toEqual([{ sku: "A1", name: "", description: "", buyUrl: "https://s.example/a" }]);
  });

  test("only web links are accepted", () => {
    const got = parseBuyVariants(variants([{ sku: "A", buy_url: "javascript:alert(1)" }, { sku: "B", buy_url: "not a url" }, { sku: "C", buy_url: "http://s.example/c" }]));
    expect(got.map((v) => v.sku)).toEqual(["C"]);
  });

  test("a repeated sku keeps the first entry", () => {
    const got = parseBuyVariants(variants([{ sku: "A", name: "first", buy_url: "https://s.example/1" }, { sku: "A", name: "second", buy_url: "https://s.example/2" }]));
    expect(got.map((v) => v.name)).toEqual(["first"]);
  });

  test("no key, an empty value, broken JSON or a non-array give nothing", () => {
    expect(parseBuyVariants({})).toEqual([]);
    expect(parseBuyVariants({ buy_variants: "" })).toEqual([]);
    expect(parseBuyVariants({ buy_variants: "[not json" })).toEqual([]);
    expect(parseBuyVariants({ buy_variants: '{"sku":"A"}' })).toEqual([]);
    expect(parseBuyVariants(variants([null, 5, "x"]))).toEqual([]);
  });
});

describe("expandVariantRows", () => {
  test("a row without variants stays as it is", () => {
    const plain = row("p", { buy_url: "https://s.example/p" });
    expect(expandVariantRows([plain])).toEqual([plain]);
  });

  test("a row with variants becomes one cart row per variant, with the variant's own link", () => {
    const shared = row("pos-1", { ...variants([{ sku: "A", name: "Cowl A", description: "d1", buy_url: "https://s.example/a" }, { sku: "B", description: "d2", buy_url: "https://s.example/b" }]), fig: "1" });
    const out = expandVariantRows([shared]);
    expect(out.map((r) => [r.url, r.sku, r.name, r.description, r.extra.buy_url])).toEqual([
      [variantCartKey("A"), "A", "Cowl A", "d1", "https://s.example/a"],
      [variantCartKey("B"), "B", "Top cowl", "d2", "https://s.example/b"], // no variant name: the row's own
    ]);
    expect(out[0]!.extra.buy_variants).toBeUndefined();
    expect(out[0]!.extra.fig).toBe("1");
  });

  test("the same sku on two rows is one cart item", () => {
    const v = variants([{ sku: "A", buy_url: "https://s.example/a" }]);
    expect(expandVariantRows([row("one", v), row("two", v)])).toHaveLength(1);
  });

  test("a row whose variants are all invalid is kept as it is", () => {
    const broken = row("b", variants([{ sku: "A" }]));
    expect(expandVariantRows([broken])).toEqual([broken]);
  });
});

describe("rowHasBuyTarget / catalogHasAnyBuyTarget", () => {
  const link = row("l", { buy_url: "https://s.example/l" });
  const multi = row("m", variants([{ sku: "A", buy_url: "https://s.example/a" }]));
  const none = row("n", { fig: "3" });
  test("a link or variants count, nothing else does", () => {
    expect(rowHasBuyTarget(link)).toBe(true);
    expect(rowHasBuyTarget(multi)).toBe(true);
    expect(rowHasBuyTarget(none)).toBe(false);
    expect(rowHasBuyTarget(row("e", { buy_url: "  " }))).toBe(false);
    expect(catalogHasAnyBuyTarget([none, multi])).toBe(true);
    expect(catalogHasAnyBuyTarget([none])).toBe(false);
  });
});

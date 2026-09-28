import { describe, expect, test } from "bun:test";
import { selectAll, selectText } from "../src/jsonPath";
import { buildUrl, extractPrice, mapProduct, resolveImageUrl, stripHtml, truncate } from "../src/normalize";
import { toCsv } from "../src/csv";
import { getPreset, type JsonFeedPreset } from "../src/presets";

const product = {
  title: "Oak &amp; Linen Chair",
  handle: "oak-chair",
  body_html: "<p>Solid <strong>oak</strong>,&nbsp;linen seat.</p><ul><li>Seats 1</li><li>Ships flat</li></ul><script>x()</script>",
  product_type: "Chairs",
  variants: [{ sku: "CH-1", price: "35.00" }, { sku: "CH-2", price: "19.5" }],
  images: [{ src: "//cdn.shopify.com/s/files/chair.jpg?v=1" }],
};

describe("jsonPath", () => {
  test("keys, indexes and [*]", () => {
    expect(selectText(product, "variants[1].sku")).toBe("CH-2");
    expect(selectAll(product, "variants[*].price")).toEqual(["35.00", "19.5"]);
    expect(selectText(product, "variants[5].sku")).toBe("");
    expect(selectText(product, "nope.deeper")).toBe("");
    expect(selectAll([1, 2], "")).toEqual([[1, 2]]);
  });
});

describe("normalize", () => {
  test("stripHtml keeps words and paragraph breaks", () => {
    expect(stripHtml(product.body_html)).toBe("Solid oak, linen seat.\n• Seats 1\n• Ships flat");
  });

  test("truncate cuts at a word boundary", () => {
    expect(truncate("alpha beta gamma delta", 14)).toBe("alpha beta…");
    expect(truncate("short", 12)).toBe("short");
  });

  test("price: range, first, minor units", () => {
    expect(extractPrice(product, { path: "variants[*].price", mode: "range" })).toBe("19.50–35.00");
    expect(extractPrice(product, { path: "variants[*].price", mode: "first" })).toBe("35.00");
    expect(extractPrice({ v: [{ p: "5" }, { p: "5.00" }] }, { path: "v[*].p", mode: "range" })).toBe("5.00");
    expect(extractPrice({ prices: { price: "1999", currency_minor_unit: 2 } }, { path: "prices.price", mode: "first", minorUnitsPath: "prices.currency_minor_unit" })).toBe("19.99");
    expect(extractPrice({}, { path: "variants[*].price", mode: "range" })).toBe("");
  });

  test("buildUrl fills fields, and gives up when one is missing", () => {
    expect(buildUrl("{origin}/products/{handle}", product, "https://s.com")).toBe("https://s.com/products/oak-chair");
    expect(buildUrl("{origin}/products/{handle}", {}, "https://s.com")).toBe("");
    expect(buildUrl("{permalink}", { permalink: "https://s.com/p/x/" }, "https://s.com")).toBe("https://s.com/p/x/");
  });

  test("resolveImageUrl makes it absolute and applies the resize query", () => {
    expect(resolveImageUrl("//cdn.x.com/a.jpg?v=1", "https://s.com", { width: "1000" })).toBe("https://cdn.x.com/a.jpg?v=1&width=1000");
    expect(resolveImageUrl("/img/a.png", "https://s.com", {})).toBe("https://s.com/img/a.png");
    expect(resolveImageUrl("", "https://s.com", {})).toBeNull();
  });

  test("the Shopify preset maps one product to one row", () => {
    const item = mapProduct(product, getPreset("shopify") as JsonFeedPreset, "https://s.com");
    expect(item).toEqual({
      name: "Oak & Linen Chair",
      sku: "CH-1",
      description: "Solid oak, linen seat.\n• Seats 1\n• Ships flat",
      folder: "Chairs",
      price: "19.50–35.00",
      buyUrl: "https://s.com/products/oak-chair",
      imageUrl: "https://cdn.shopify.com/s/files/chair.jpg?v=1&width=1000",
    });
  });
});

describe("csv", () => {
  test("Composer's column order, quoting, BOM and CRLF", () => {
    const csv = toCsv([{ name: 'Say "hi", ok', sku: "A", description: "l1\nl2", folder: "", price: "1.00", buyUrl: "u", imageUrl: null }]);
    expect(csv).toBe('﻿No.,Folder,Name,SKU,Description,Price,buy_url\r\n1,,"Say ""hi"", ok",A,"l1\nl2",1.00,u\r\n');
  });
});

import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { createEmptyCatalog, exportCatalog, initSqlite, openCatalog, readMeta, updateWhereToBuy } from "./db.js";
import type { CatalogRow } from "./types.js";
import {
  DEFAULT_WHERE_TO_BUY,
  activeSites,
  compactPartNumber,
  fillSearchUrl,
  isDigitsOnlyPartNumber,
  parseWhereToBuy,
  partNumbersForRow,
  serializeWhereToBuy,
  siteHomeUrl,
  whereToBuyEnabled,
  type WhereToBuySettings,
} from "./whereToBuy.js";

const SQL = await initSqlite(createRequire(import.meta.url).resolve("sql.js/dist/sql-wasm.wasm"));

const settings: WhereToBuySettings = {
  button: "replace",
  partNumber: "sku",
  altKey: "alt_pn",
  manufacturer: "Acme Motors",
  label: "",
  sites: [
    { name: "Parts Market", kind: "Marketplace", color: "#16a34a", home: "https://market.example.com/", searchUrl: "https://market.example.com/search?q={pn}", enabled: true },
    { name: "Bolt Depot", kind: "Store", color: "", home: "https://bolts.example.com/", searchUrl: "", enabled: true },
    { name: "Old Stock", kind: "Used", color: "", home: "https://old.example.com/", searchUrl: "https://old.example.com/p/{pn_nodash}.html", enabled: false },
  ],
};

function row(sku: string, extra: Record<string, string> = {}): CatalogRow {
  return { id: 1, imageId: 1, url: "p1", name: "Camshaft", sku, description: "", extra };
}

describe("parseWhereToBuy", () => {
  test("missing or broken JSON means the feature is off", () => {
    expect(parseWhereToBuy(undefined)).toEqual(DEFAULT_WHERE_TO_BUY);
    expect(parseWhereToBuy("not json")).toEqual(DEFAULT_WHERE_TO_BUY);
    expect(parseWhereToBuy("[1,2]")).toEqual(DEFAULT_WHERE_TO_BUY);
    expect(whereToBuyEnabled(parseWhereToBuy(undefined))).toBe(false);
  });

  test("round-trips through serializeWhereToBuy", () => {
    expect(parseWhereToBuy(serializeWhereToBuy(settings))).toEqual(settings);
  });

  test("drops sites without a name, bad colors and unknown values", () => {
    const parsed = parseWhereToBuy(
      JSON.stringify({
        button: "sideways",
        partNumber: "price",
        sites: [{ name: "  " }, { name: "Shop", color: "red; background:url(x)", home: "https://shop.example.com/" }],
      }),
    );
    expect(parsed.button).toBe("off");
    expect(parsed.partNumber).toBe("sku");
    expect(parsed.sites).toEqual([{ name: "Shop", kind: "", color: "", home: "https://shop.example.com/", searchUrl: "", enabled: true }]);
  });

  test("accepts an extra key as the part-number source", () => {
    expect(parseWhereToBuy(JSON.stringify({ partNumber: "extra:part_no" })).partNumber).toBe("extra:part_no");
    expect(parseWhereToBuy(JSON.stringify({ partNumber: "extra:" })).partNumber).toBe("sku");
  });
});

describe("which sites and rows get the button", () => {
  test("only enabled sites with something to open are listed", () => {
    expect(activeSites(settings).map((s) => s.name)).toEqual(["Parts Market", "Bolt Depot"]);
  });

  test("button off or no active site turns the feature off", () => {
    expect(whereToBuyEnabled(settings)).toBe(true);
    expect(whereToBuyEnabled({ ...settings, button: "off" })).toBe(false);
    expect(whereToBuyEnabled({ ...settings, sites: settings.sites.map((s) => ({ ...s, enabled: false })) })).toBe(false);
  });

  test("the row's number comes first, then deduplicated alternates", () => {
    expect(partNumbersForRow(row("AX-12441", { alt_pn: "74349; ax-12441, 77672" }), settings)).toEqual(["AX-12441", "74349", "77672"]);
  });

  test("a row without a number gets no button", () => {
    expect(partNumbersForRow(row("  ", { alt_pn: "74349" }), settings)).toEqual([]);
  });

  test("the number can come from an extra key", () => {
    expect(partNumbersForRow(row("", { part_no: "STD-1732" }), { ...settings, partNumber: "extra:part_no" })).toEqual(["STD-1732"]);
  });
});

describe("search links", () => {
  test("fills and encodes every placeholder", () => {
    expect(fillSearchUrl("https://market.example.com/search?q={pn}", "AX-12441", "")).toBe("https://market.example.com/search?q=AX-12441");
    expect(fillSearchUrl("https://old.example.com/p/{pn_nodash}.html", "AX-12441", "")).toBe("https://old.example.com/p/AX12441.html");
    expect(fillSearchUrl("https://x.example.com/{pn_lower}", "STD-1732", "")).toBe("https://x.example.com/std-1732");
    expect(fillSearchUrl("https://x.example.com/s?q={mfr} {pn}", "A&B/1", "Acme Motors")).toBe("https://x.example.com/s?q=Acme%20Motors%20A%26B%2F1");
  });

  test("an empty template or a non-web link gives no link", () => {
    expect(fillSearchUrl("", "AX-12441", "")).toBeNull();
    expect(fillSearchUrl("javascript:alert('{pn}')", "AX-12441", "")).toBeNull();
    expect(siteHomeUrl({ ...settings.sites[1]!, home: "data:text/html,hi" })).toBeNull();
    expect(siteHomeUrl(settings.sites[1]!)).toBe("https://bolts.example.com/");
  });

  test("compactPartNumber strips separators", () => {
    expect(compactPartNumber("MS21919-G12")).toBe("MS21919G12");
    expect(compactPartNumber("74 349")).toBe("74349");
  });
});

describe("digits-only warning", () => {
  test("flags numbers without letters", () => {
    expect(isDigitsOnlyPartNumber("74349")).toBe(true);
    expect(isDigitsOnlyPartNumber("74-349")).toBe(true);
    expect(isDigitsOnlyPartNumber("AX-12441")).toBe(false);
    expect(isDigitsOnlyPartNumber("STD-1732")).toBe(false);
  });
});

describe("catalog meta", () => {
  test("is off in a new catalog and survives save/open", () => {
    const db = createEmptyCatalog(SQL, "Engine");
    expect(readMeta(db).whereToBuy).toEqual(DEFAULT_WHERE_TO_BUY);
    updateWhereToBuy(db, settings);
    const reopened = openCatalog(SQL, exportCatalog(db));
    expect(readMeta(reopened).whereToBuy).toEqual(settings);
  });
});

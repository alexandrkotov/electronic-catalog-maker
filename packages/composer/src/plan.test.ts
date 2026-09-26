import { describe, expect, test } from "bun:test";
import { parseTable } from "./table.js";
import { isBlocking, makePlan, photoNumber } from "./plan.js";

describe("parseTable", () => {
  test("comma CSV with quotes, BOM and extra keys", () => {
    const t = parseTable('﻿No.,Folder,Name,SKU,Description,Price,buy_url\r\n1,,"Chair, oak",CH-1,"Line one\nline two",$10,\r\n2,Lamps,Lamp,,,,\r\n');
    expect(t.extraKeys).toEqual(["Price", "buy_url"]);
    expect(t.items).toHaveLength(2);
    expect(t.items[0]).toMatchObject({ no: 1, folder: "", name: "Chair, oak", sku: "CH-1", description: "Line one\nline two", extra: { Price: "$10" } });
    expect(t.items[1]).toMatchObject({ no: 2, folder: "Lamps", extra: {} });
  });

  test("TSV pasted from a spreadsheet, and semicolon CSV", () => {
    expect(parseTable("№\tПапка\tНазвание\n1\tСтулья\tСтул\n").items[0]).toMatchObject({ no: 1, folder: "Стулья", name: "Стул" });
    expect(parseTable("No;Folder;Name\n5;;Table\n").items[0]).toMatchObject({ no: 5, name: "Table" });
  });

  test("non-numeric numbers are reported, blank lines skipped", () => {
    const t = parseTable("No,Folder,Name\nabc,,X\n\n0,,Y\n3,,Z\n");
    expect(t.badNumbers).toEqual([{ line: 2, value: "abc" }, { line: 4, value: "0" }]);
    expect(t.items.map((i) => i.no)).toEqual([3]);
  });
});

describe("makePlan", () => {
  const table = parseTable(
    ["No,Folder,Name,SKU", "3,,C,S3", "1,,A,S1", "2,Lamps,B,DUP", "4,Lamps,D,DUP", "5,Chairs,,S5"].join("\n"),
  );

  test("photo numbers", () => {
    expect(photoNumber("007.JPG")).toBe(7);
    expect(photoNumber("1.jpeg")).toBe(1);
    expect(photoNumber("1a.jpg")).toBeNull();
    expect(photoNumber("3.txt")).toBeNull();
  });

  test("root grid first, folders in table order, items sorted by number", () => {
    const p = makePlan(table, ["1.jpg", "2.png", "3.jpg", "4.jpg", "5.jpg"], 0, 3);
    expect(p.grids.map((g) => g.folder)).toEqual(["", "Lamps", "Chairs"]);
    expect(p.grids[0]!.items.map((i) => i.item.no)).toEqual([1, 3]);
    expect(isBlocking(p.report)).toBe(false);
  });

  test("url is a unique SKU, else item-<no>", () => {
    const p = makePlan(table, [], 0, 3);
    const urls = p.grids.flatMap((g) => g.items.map((i) => i.url));
    expect(urls).toEqual(["S1", "S3", "item-2", "item-4", "S5"]);
    expect(p.report.duplicateSkus).toEqual([{ sku: "DUP", nos: [2, 4] }]);
  });

  test("report: missing, orphan, duplicate and unrecognized photos, empty names", () => {
    const p = makePlan(table, ["1.jpg", "01.png", "2.jpg", "9.jpg", "notes.txt", "cover.jpg"], 0, 3);
    expect(p.report.missingPhotos).toEqual([3, 4, 5]);
    expect(p.report.orphanPhotos).toEqual(["9.jpg"]);
    expect(p.report.duplicatePhotos).toEqual(["1.jpg"]);
    expect(p.report.unrecognizedFiles).toEqual(["cover.jpg", "notes.txt"]);
    expect(p.report.emptyNames).toEqual([5]);
    expect(p.grids[0]!.items[0]!.photo).toBe("01.png");
  });

  test("duplicate numbers block the build", () => {
    const p = makePlan(parseTable("No,Folder,Name\n1,,A\n1,,B\n"), [], 0, 3);
    expect(p.report.duplicateNumbers).toEqual([{ no: 1, lines: [2, 3] }]);
    expect(isBlocking(p.report)).toBe(true);
  });

  test("a folder over the ceiling splits into equal parts of whole rows", () => {
    const rows = Array.from({ length: 130 }, (_, i) => `${i + 1},Big,Item ${i + 1}`);
    const p = makePlan(parseTable(["No,Folder,Name", ...rows].join("\n")), [], 120, 3);
    expect(p.grids.map((g) => [g.part, g.parts, g.items.length])).toEqual([[1, 2, 66], [2, 2, 64]]);
  });

  test("no ceiling, no split", () => {
    const rows = Array.from({ length: 500 }, (_, i) => `${i + 1},Big,Item ${i + 1}`);
    const p = makePlan(parseTable(["No,Folder,Name", ...rows].join("\n")), [], 0, 3);
    expect(p.grids).toHaveLength(1);
  });
});

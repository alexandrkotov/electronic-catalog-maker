import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { addImage, addRow, createEmptyCatalog, deleteRow, findRowByUrl, initSqlite, updateRow } from "./db.js";
import { captionText, listGridLayouts, staleGridCaptions, writeGridLayout, type GridLayout } from "./gridCaption.js";

const SQL = await initSqlite(createRequire(import.meta.url).resolve("sql.js/dist/sql-wasm.wasm"));

function grid(subtitleKey = "Price") {
  const db = createEmptyCatalog(SQL, "t");
  const imageId = addImage(db, { name: "Grid", mimeType: "image/jpeg", imageData: "", width: 920, height: 600 });
  addRow(db, { imageId, url: "item-1", name: "Bird", extra: { Price: "5" } });
  addRow(db, { imageId, url: "item-2", name: "", extra: {} });
  const layout: GridLayout = {
    v: 1, width: 920, height: 600, tile: 432, cap: 80, capFont: 18, subFont: 16, pad: 14, lineH: 23, radius: 14, accent: "#2563eb", subtitleKey,
    tiles: [
      { url: "item-1", no: 1, x: 20, y: 100, name: "Bird", sub: "5" },
      { url: "item-2", no: 2, x: 468, y: 100, name: "#2", sub: "" },
    ],
  };
  writeGridLayout(db, imageId, layout);
  return { db, imageId };
}

describe("grid captions", () => {
  test("an unnamed item is captioned with its number", () => {
    expect(captionText({ subtitleKey: "Price" }, 7, { name: " ", sku: "", extra: {} })).toEqual({ name: "#7", sub: "" });
    expect(captionText({ subtitleKey: "sku" }, 7, { name: "Lamp", sku: "L-1", extra: {} })).toEqual({ name: "Lamp", sub: "L-1" });
  });

  test("a freshly composed grid has nothing to repaint", () => {
    expect(staleGridCaptions(grid().db)).toEqual([]);
  });

  test("renaming a row or changing the shown extra marks just that tile", () => {
    const { db, imageId } = grid();
    updateRow(db, findRowByUrl(db, "item-2")!.id, { name: "Sunrise", extra: { Price: "9" } });
    const stale = staleGridCaptions(db);
    expect(stale.map((s) => s.imageId)).toEqual([imageId]);
    expect(stale[0]!.stale.map((s) => [s.tile.url, s.text])).toEqual([["item-2", { name: "Sunrise", sub: "9" }]]);
  });

  test("a change the picture does not show is not a reason to repaint", () => {
    const { db } = grid();
    updateRow(db, findRowByUrl(db, "item-1")!.id, { name: "Bird", description: "small", extra: { Price: "5", Color: "green" } });
    expect(staleGridCaptions(db)).toEqual([]);
  });

  test("a deleted row falls back to the number", () => {
    const { db } = grid();
    deleteRow(db, findRowByUrl(db, "item-1")!.id);
    expect(staleGridCaptions(db)[0]!.stale[0]!.text).toEqual({ name: "#1", sub: "" });
  });

  test("a layout is ignored once its picture has another size", () => {
    const { db, imageId } = grid();
    db.run("UPDATE images SET height = 700 WHERE id = ?", [imageId]);
    expect(listGridLayouts(db)).toEqual([]);
  });
});

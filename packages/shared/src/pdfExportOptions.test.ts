import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { addImage, addLink, createEmptyCatalog, initSqlite } from "./db.js";
import { cropToRegion, suggestedQrSize } from "./pdfExportOptions.js";
import type { CatalogLink, CatalogRow } from "./types.js";

const SQL = await initSqlite(createRequire(import.meta.url).resolve("sql.js/dist/sql-wasm.wasm"));
const image = { name: "Img", mimeType: "image/jpeg", imageData: "", width: 920, height: 900 };

function catalogWithLinks(points: Array<[left: number, top: number]>) {
  const db = createEmptyCatalog(SQL, "t");
  const imageId = addImage(db, image);
  points.forEach(([left, top], i) => addLink(db, { imageId, name: String(i + 1), url: `u${i}`, left, top, fontSize: 20 }));
  return db;
}

describe("suggestedQrSize", () => {
  test("large for a composited tile grid", () => {
    const grid: Array<[number, number]> = [];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) grid.push([40 + c * 298, 128 + r * 396]);
    expect(suggestedQrSize(catalogWithLinks(grid))).toBe("large");
  });

  test("small for hand-placed diagram hotspots", () => {
    expect(suggestedQrSize(catalogWithLinks([[50, 60], [310, 75], [120, 400], [700, 520], [455, 800]]))).toBe("small");
  });

  test("small for an empty catalog", () => {
    expect(suggestedQrSize(createEmptyCatalog(SQL, "t"))).toBe("small");
  });
});

describe("cropToRegion", () => {
  const link = (id: number, left: number, top: number, url = `u${id}`): CatalogLink => ({ id, imageId: 1, name: String(id), url, left, top, fontSize: 20 });
  const row = (url: string): CatalogRow => ({ id: 1, imageId: 1, url, name: url, sku: "", description: "", extra: {} });
  const size = { width: 1000, height: 800 };

  test("cuts the rectangle out in pixels and keeps what is inside, moved to the new origin", () => {
    const links = [link(1, 150, 120), link(2, 450, 400), link(3, 900, 700)];
    const crop = cropToRegion(size, { x: 0.1, y: 0.1, w: 0.4, h: 0.5 }, links, [row("u1"), row("u2"), row("u3")])!;
    expect(crop.rect).toEqual({ x: 100, y: 80, w: 400, h: 400 });
    expect(crop.links.map((l) => [l.id, l.left, l.top])).toEqual([
      [1, 50, 40],
      [2, 350, 320],
    ]);
    expect(crop.rows.map((r) => r.url)).toEqual(["u1", "u2"]);
  });

  test("a navigation marker never comes along", () => {
    const crop = cropToRegion(size, { x: 0, y: 0, w: 1, h: 1 }, [link(1, 10, 10), link(2, 20, 20, "#image=2")], [])!;
    expect(crop.links.map((l) => l.id)).toEqual([1]);
  });

  test("a region sticking out of the picture is clipped; an empty one is nothing", () => {
    expect(cropToRegion(size, { x: 0.8, y: 0.8, w: 0.9, h: 0.9 }, [], [])!.rect).toEqual({ x: 800, y: 640, w: 200, h: 160 });
    expect(cropToRegion(size, { x: 1.2, y: 0, w: 0.1, h: 0.1 }, [], [])).toBeNull();
    expect(cropToRegion(size, { x: 0.5, y: 0.5, w: 0, h: 0.2 }, [], [])).toBeNull();
  });

  test("a hairline region is still at least one pixel", () => {
    const rect = cropToRegion(size, { x: 0.5, y: 0.5, w: 0.0001, h: 0.0001 }, [], [])!.rect;
    expect(rect.w).toBeGreaterThanOrEqual(1);
    expect(rect.h).toBeGreaterThanOrEqual(1);
  });
});

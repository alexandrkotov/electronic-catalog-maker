import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { addImage, addLink, createEmptyCatalog, initSqlite } from "./db.js";
import { suggestedQrSize } from "./pdfExportOptions.js";

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

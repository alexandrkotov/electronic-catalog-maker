import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { addImage, addLink, createEmptyCatalog, deleteLink, initSqlite, linkNamesByImage, listImageInfos, listImages } from "./db.js";
import { ImageSrcCache } from "./images.js";

const SQL = await initSqlite(createRequire(import.meta.url).resolve("sql.js/dist/sql-wasm.wasm"));

function catalog() {
  const db = createEmptyCatalog(SQL, "t");
  const a = addImage(db, { name: "A", mimeType: "image/png", imageData: "QUJD", width: 10, height: 8, sortOrder: 1, folder: "F" });
  const b = addImage(db, { name: "B", mimeType: "image/jpeg", imageData: "REVG", width: 4, height: 3, sortOrder: 0 });
  return { db, a, b };
}

describe("listImageInfos", () => {
  test("is listImages without the picture data, in the same order", () => {
    const { db } = catalog();
    const infos = listImageInfos(db);
    expect(infos).toEqual(listImages(db).map(({ imageData: _, ...rest }) => rest));
    expect(infos.map((i) => i.name)).toEqual(["B", "A"]);
    expect("imageData" in infos[0]!).toBe(false);
  });
});

describe("linkNamesByImage", () => {
  test("groups hotspot names by image in hotspot order; images without any are absent", () => {
    const { db, a } = catalog();
    addLink(db, { imageId: a, name: "1", url: "p-1", top: 1, left: 1 });
    const gone = addLink(db, { imageId: a, name: "2", url: "p-2", top: 2, left: 2 });
    addLink(db, { imageId: a, name: "3", url: "p-1", top: 3, left: 3 });
    deleteLink(db, gone);
    expect([...linkNamesByImage(db)]).toEqual([[a, ["1", "3"]]]);
  });
});

describe("ImageSrcCache", () => {
  test("builds a data URL once per image and starts over for another database", () => {
    const first = catalog();
    const cache = new ImageSrcCache();
    expect(cache.get(first.db, first.a)).toBe("data:image/png;base64,QUJD");
    first.db.run("UPDATE images SET image_data = 'WFla' WHERE id = ?", [first.a]);
    expect(cache.get(first.db, first.a)).toBe("data:image/png;base64,QUJD"); // cached
    expect(cache.get(first.db, 999)).toBe("");
    const second = catalog();
    second.db.run("UPDATE images SET image_data = 'WFla' WHERE id = ?", [second.a]);
    expect(cache.get(second.db, second.a)).toBe("data:image/png;base64,WFla");
  });
});

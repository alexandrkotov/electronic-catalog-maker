import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { addImage, createEmptyCatalog, exportCatalog, initSqlite, listImages, openCatalog, updateImage } from "./db.js";

const SQL = await initSqlite(createRequire(import.meta.url).resolve("sql.js/dist/sql-wasm.wasm"));
const image = { name: "Room", mimeType: "image/jpeg", imageData: "", width: 10, height: 10 };

describe("images.fit_on_open", () => {
  test("a catalog from before the column existed opens with it off", () => {
    const old = new SQL.Database();
    old.run(`CREATE TABLE images (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, mime_type TEXT NOT NULL DEFAULT 'image/jpeg',
      image_data TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, folder TEXT NOT NULL DEFAULT '');
      CREATE TABLE links (id INTEGER PRIMARY KEY AUTOINCREMENT, image_id INTEGER NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL, top REAL NOT NULL, left REAL NOT NULL, font_size INTEGER NOT NULL DEFAULT 12);
      INSERT INTO images (name, image_data, width, height) VALUES ('Room', '', 10, 10);`);
    const db = openCatalog(SQL, old.export());
    expect(listImages(db)[0]?.fitOnOpen).toBe(false);
  });

  test("set on add, changed by update, kept when an update leaves it out, survives export", () => {
    const db = createEmptyCatalog(SQL, "t");
    const id = addImage(db, { ...image, fitOnOpen: true });
    expect(listImages(db)[0]?.fitOnOpen).toBe(true);
    updateImage(db, id, { name: "Room", folder: "" }); // an older editor in a shared session
    expect(listImages(db)[0]?.fitOnOpen).toBe(true);
    updateImage(db, id, { name: "Room", folder: "", fitOnOpen: false });
    expect(listImages(openCatalog(SQL, exportCatalog(db)))[0]?.fitOnOpen).toBe(false);
  });
});

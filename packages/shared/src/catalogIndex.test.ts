import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { catalogName, extractCover, extractSearchChunks, indexCatalog, openCatalog, searchCatalog } from "./catalogIndex.js";
import { ProtectedCatalogError, isProtectedCatalog, protectCatalog } from "./protect.js";

// The point of this module: it needs no DOM. Bun's test runner has none, so
// everything below doubling as proof is the whole test.
const wasm = readFileSync(createRequire(import.meta.url).resolve("sql.js/dist/sql-wasm.wasm"));
const demoDir = new URL("../../../demo/", import.meta.url);
const demo = (file: string) => new Uint8Array(readFileSync(new URL(file, demoDir)));
const demoFiles = readdirSync(demoDir).filter((f) => f.endsWith(".ecatm"));

test("there is no DOM here", () => {
  expect(typeof document).toBe("undefined");
  expect(typeof window).toBe("undefined");
});

describe("every demo catalog", () => {
  for (const file of demoFiles) {
    test(file, async () => {
      const bytes = demo(file);
      if (isProtectedCatalog(bytes)) {
        // A real protected demo, no key: only the public name and cover can be read.
        const digest = await indexCatalog(bytes, { wasm });
        expect(digest).toMatchObject({ protected: true, locked: true, chunks: [] });
        expect(digest.name.length).toBeGreaterThan(0);
        await expect(openCatalog(bytes, { wasm })).rejects.toMatchObject({ code: "locked" });
        return;
      }
      const db = await openCatalog(bytes, { wasm });
      try {
        expect(catalogName(db).length).toBeGreaterThan(0);
        const cover = extractCover(db);
        expect(cover).not.toBeNull();
        expect(cover!.mime).toMatch(/^image\//);
        expect(cover!.bytes.length).toBeGreaterThan(100);
        const chunks = extractSearchChunks(db);
        expect(chunks.length).toBeGreaterThan(0);
        for (const c of chunks) {
          expect(Number.isInteger(c.imageId)).toBe(true);
          expect(c.text.trim()).not.toBe("");
        }
      } finally {
        db.close();
      }
    });
  }
});

describe("a catalog with items (furniture)", () => {
  test("the cover is a real picture, as stored", async () => {
    const db = await openCatalog(demo("furniture.ecatm"), { wasm });
    const { mime, bytes } = extractCover(db)!;
    const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
    const isWebp = String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
    expect(isJpeg || isPng || isWebp).toBe(true);
    expect(mime).toBe(isJpeg ? "image/jpeg" : isPng ? "image/png" : "image/webp");
    db.close();
  });

  test("item chunks say which hotspot to open, and picture chunks have none", async () => {
    const db = await openCatalog(demo("furniture.ecatm"), { wasm });
    const chunks = extractSearchChunks(db);
    const withLink = chunks.filter((c) => c.linkId !== undefined);
    const withoutLink = chunks.filter((c) => c.linkId === undefined);
    expect(withLink.length).toBeGreaterThan(0);
    expect(withoutLink.length).toBeGreaterThan(0);
    // The ids are real: that hotspot exists on that picture.
    for (const c of withLink) {
      const stmt = db.prepare("SELECT 1 FROM links WHERE id = ? AND image_id = ?");
      stmt.bind([c.linkId!, c.imageId]);
      expect(stmt.step()).toBe(true);
      stmt.free();
    }
    db.close();
  });

  test("search finds an item by a word of its name and points at its picture and hotspot", async () => {
    const db = await openCatalog(demo("furniture.ecatm"), { wasm });
    const item = extractSearchChunks(db).find((c) => c.linkId !== undefined)!;
    const word = item.text.split(/\s+/)[0]!.toLowerCase();
    const hits = searchCatalog(db, word);
    expect(hits.length).toBeGreaterThan(0);
    const hit = hits.find((h) => h.imageId === item.imageId && h.linkId === item.linkId);
    expect(hit).toBeDefined();
    expect(hit!.snippet.toLowerCase()).toContain(word);
    expect(hit!.rowName.length).toBeGreaterThan(0);
    // Case does not matter, a blank query finds nothing, and a miss finds nothing.
    expect(searchCatalog(db, word.toUpperCase()).length).toBe(hits.length);
    expect(searchCatalog(db, "   ")).toEqual([]);
    expect(searchCatalog(db, "zzzz-no-such-thing")).toEqual([]);
    db.close();
  });

  test("a search can be narrowed to one field", async () => {
    const db = await openCatalog(demo("furniture.ecatm"), { wasm });
    const stmt = db.prepare("SELECT name, sku FROM rows WHERE sku != '' LIMIT 1");
    stmt.step();
    const { name, sku } = stmt.getAsObject() as { name: string; sku: string };
    stmt.free();
    expect(searchCatalog(db, sku, "sku").length).toBeGreaterThan(0);
    expect(searchCatalog(db, sku, "name").length).toBe(0);
    expect(searchCatalog(db, name, "name").length).toBeGreaterThan(0);
    db.close();
  });
});

describe("a quiz gives nothing away", () => {
  test("no item text in the chunks, no search hits", async () => {
    const db = await openCatalog(demo("quiz-cell-biology-en.ecatm"), { wasm });
    const chunks = extractSearchChunks(db);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.linkId === undefined)).toBe(true);
    const stmt = db.prepare("SELECT name FROM rows LIMIT 1");
    stmt.step();
    const { name } = stmt.getAsObject() as { name: string };
    stmt.free();
    expect(searchCatalog(db, name)).toEqual([]);
    db.close();
  });
});

describe("a protected catalog", () => {
  const cover = { mime: "image/jpeg", bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]) };
  const protectedBytes = async () => protectCatalog(demo("furniture.ecatm"), "s3cret", { name: "Public name", cover, iterations: 1000 });

  test("without the key it will not open", async () => {
    const bytes = await protectedBytes();
    await expect(openCatalog(bytes, { wasm })).rejects.toMatchObject({ code: "locked" });
    await expect(openCatalog(bytes, { wasm, key: "wrong" })).rejects.toBeInstanceOf(ProtectedCatalogError);
    await expect(openCatalog(bytes, { wasm, key: "wrong" })).rejects.toMatchObject({ code: "wrong-password" });
  });

  test("with the key it opens like any other", async () => {
    const db = await openCatalog(await protectedBytes(), { wasm, key: "s3cret" });
    expect(extractSearchChunks(db).length).toBeGreaterThan(0);
    db.close();
  });

  test("indexCatalog without a key reads only the public name and cover", async () => {
    const digest = await indexCatalog(await protectedBytes(), { wasm });
    expect(digest).toMatchObject({ name: "Public name", protected: true, locked: true, chunks: [] });
    expect(digest.cover?.mime).toBe("image/jpeg");
    expect([...digest.cover!.bytes]).toEqual([...cover.bytes]);
  });

  test("indexCatalog with a wrong key falls back to the same public part", async () => {
    const digest = await indexCatalog(await protectedBytes(), { wasm, key: "wrong" });
    expect(digest.locked).toBe(true);
    expect(digest.chunks).toEqual([]);
  });

  test("indexCatalog with the key reads everything", async () => {
    const digest = await indexCatalog(await protectedBytes(), { wasm, key: "s3cret" });
    expect(digest.locked).toBe(false);
    expect(digest.protected).toBe(true);
    expect(digest.chunks.length).toBeGreaterThan(0);
    expect(digest.name).not.toBe("Public name"); // the catalog's own name, now that it is readable
  });

  test("indexCatalog of an ordinary catalog", async () => {
    const digest = await indexCatalog(demo("furniture.ecatm"), { wasm });
    expect(digest).toMatchObject({ protected: false, locked: false });
    expect(digest.chunks.length).toBeGreaterThan(0);
    expect(digest.cover).not.toBeNull();
  });
});

test("bytes that are not a catalog are an error, not a crash", async () => {
  await expect(openCatalog(new Uint8Array([1, 2, 3, 4]), { wasm })).rejects.toBeDefined();
});

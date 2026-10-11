import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import type { Database } from "sql.js";
import {
  addImage,
  addLink,
  addRow,
  captureUndoAfterAdd,
  captureUndoBefore,
  createEmptyCatalog,
  deleteImage,
  deleteLink,
  deleteRow,
  findRowByUrl,
  initSqlite,
  isAddOp,
  listImages,
  listLinksForImage,
  listRowsForImage,
  readMeta,
  updateImage,
  updateLink,
  updateLinkPosition,
  updateRow,
  updateStoreSettings,
  type UndoOp,
} from "./index.js";

const SQL = await initSqlite(createRequire(import.meta.url).resolve("sql.js/dist/sql-wasm.wasm"));

const HANDLERS: Record<string, (db: Database, ...args: never[]) => unknown> = {
  addImage,
  updateImage,
  deleteImage,
  addLink,
  updateLink,
  deleteLink,
  updateLinkPosition,
  addRow,
  updateRow,
  deleteRow,
  updateStoreSettings,
};

/** Applies an op and returns the ops that undo it, the way the editor does. */
function apply(db: Database, fn: string, ...args: unknown[]): UndoOp[] {
  const handler = HANDLERS[fn] as (db: Database, ...a: unknown[]) => unknown;
  if (isAddOp(fn)) {
    const id = handler(db, ...args) as number;
    const input = { ...(args[0] as object), id };
    return captureUndoAfterAdd(db, fn, input) ?? [];
  }
  const inverse = captureUndoBefore(db, fn, args);
  if (inverse === null) throw new Error(`no undo for ${fn}`);
  handler(db, ...args);
  return inverse;
}

function run(db: Database, ops: UndoOp[]) {
  for (const op of ops) (HANDLERS[op.fn] as (db: Database, ...a: unknown[]) => unknown)(db, ...op.args);
}

function snapshot(db: Database) {
  const images = listImages(db);
  return JSON.stringify({
    meta: readMeta(db),
    images,
    links: images.flatMap((i) => listLinksForImage(db, i.id)),
    rows: images.flatMap((i) => listRowsForImage(db, i.id)),
  });
}

function seeded() {
  const db = createEmptyCatalog(SQL, "t");
  const img = addImage(db, { name: "A", mimeType: "image/png", imageData: "QUJD", width: 100, height: 80, sortOrder: 0, folder: "F" });
  addImage(db, { name: "B", mimeType: "image/png", imageData: "REVG", width: 10, height: 10, sortOrder: 1 });
  const l1 = addLink(db, { imageId: img, name: "bolt", url: "p-1", top: 10, left: 20, fontSize: 14 });
  addLink(db, { imageId: img, name: "bolt again", url: "p-1", top: 30, left: 40 });
  addRow(db, { imageId: img, url: "p-1", name: "Bolt", sku: "B1", description: "d", extra: { w: "2 kg" } });
  const l3 = addLink(db, { imageId: img, name: "nut", url: "p-2", top: 50, left: 60 });
  return { db, img, l1, l3 };
}

describe("undo capture round-trips through the db functions", () => {
  test.each([
    ["updateStoreSettings", (s: ReturnType<typeof seeded>) => ["updateStoreSettings", { catalogMode: "shop", storeUrl: "https://x.test", cartMode: "instant", cartIdPattern: "a", cartItemParam: "b", cartCheckoutBaseUrl: "c", defaultView: "table" }]],
    ["updateImage", (s: ReturnType<typeof seeded>) => ["updateImage", s.img, { name: "Renamed", folder: "", fitOnOpen: true }]],
    ["updateLink name", (s: ReturnType<typeof seeded>) => ["updateLink", s.l1, { name: "renamed", url: "p-1" }]],
    ["updateLink url, row follows", (s: ReturnType<typeof seeded>) => ["updateLink", s.l3, { name: "nut", url: "p-9" }]],
    ["updateLinkPosition", (s: ReturnType<typeof seeded>) => ["updateLinkPosition", s.l1, 1, 2]],
    ["deleteLink (bare)", (s: ReturnType<typeof seeded>) => ["deleteLink", s.l3]],
    ["deleteLink (sibling keeps the row)", (s: ReturnType<typeof seeded>) => ["deleteLink", s.l1]],
    ["deleteImage", (s: ReturnType<typeof seeded>) => ["deleteImage", s.img]],
  ])("%s", (_name, build) => {
    const s = seeded();
    const before = snapshot(s.db);
    const [fn, ...args] = build(s) as [string, ...unknown[]];
    const inverse = apply(s.db, fn, ...args);
    expect(snapshot(s.db)).not.toBe(before);
    run(s.db, inverse);
    expect(snapshot(s.db)).toBe(before);
  });

  test("updateRow and deleteRow", () => {
    const s = seeded();
    const row = findRowByUrl(s.db, "p-1")!;
    const before = snapshot(s.db);
    const updateInverse = apply(s.db, "updateRow", row.id, { name: "X", sku: "", description: "", extra: {} });
    expect(snapshot(s.db)).not.toBe(before);
    run(s.db, updateInverse);
    expect(snapshot(s.db)).toBe(before);
    const deleteInverse = apply(s.db, "deleteRow", row.id);
    expect(findRowByUrl(s.db, "p-1")).toBeNull();
    run(s.db, deleteInverse);
    expect(snapshot(s.db)).toBe(before);
  });

  test("undoing adds removes exactly what was added", () => {
    const s = seeded();
    const before = snapshot(s.db);
    const imgInv = apply(s.db, "addImage", { name: "C", mimeType: "image/png", imageData: "", width: 1, height: 1 });
    const linkInv = apply(s.db, "addLink", { imageId: s.img, name: "n", url: "p-3", top: 1, left: 1 });
    const rowInv = apply(s.db, "addRow", { imageId: s.img, url: "p-3", name: "N" });
    run(s.db, rowInv);
    run(s.db, linkInv);
    run(s.db, imgInv);
    expect(snapshot(s.db)).toBe(before);
  });

  test("redo: replaying the undo and capturing again restores the edit", () => {
    const s = seeded();
    const before = snapshot(s.db);
    const undo = apply(s.db, "deleteImage", s.img);
    const afterDelete = snapshot(s.db);
    // undo, capturing the redo as the editor does
    const redo: UndoOp[] = [];
    for (const op of undo) redo.unshift(...apply(s.db, op.fn, ...op.args));
    expect(snapshot(s.db)).toBe(before);
    run(s.db, redo);
    expect(snapshot(s.db)).toBe(afterDelete);
  });

  test("an add over a bare row brings that row back when undone", () => {
    const db = createEmptyCatalog(SQL, "t");
    const img = addImage(db, { name: "A", mimeType: "image/png", imageData: "", width: 1, height: 1 });
    addRow(db, { imageId: img, url: "orphan", name: "Bare" }); // a row with no hotspot at all
    const before = snapshot(db);
    const inv = apply(db, "addLink", { imageId: img, name: "n", url: "orphan", top: 1, left: 1 });
    run(db, inv);
    expect(snapshot(db)).toBe(before);
  });

  test("unknown functions and missing targets", () => {
    const { db } = seeded();
    expect(captureUndoBefore(db, "somethingNew", [])).toBeNull();
    expect(captureUndoBefore(db, "updateLink", [9999, { name: "x", url: "y" }])).toEqual([]);
    expect(captureUndoAfterAdd(db, "addLink", {})).toBeNull();
  });
});

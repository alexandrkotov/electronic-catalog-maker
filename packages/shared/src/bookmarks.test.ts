import { describe, expect, test } from "bun:test";
import { bookmarksStorageKey, localBookmarkStore } from "./bookmarks.js";
import type { KeyValueStorage } from "./types.js";

const memory = (): KeyValueStorage & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
};

describe("localBookmarkStore", () => {
  test("adds, lists in order and removes", () => {
    const store = localBookmarkStore(memory(), "k");
    expect(store.list()).toEqual([]);
    const a = store.add({ v: 1, imageId: 3, zoom: 2, cx: 0.4, cy: 0.5 }, "Corner") as { id: string };
    const b = store.add({ v: 1, imageId: 4, region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }, "Area") as { id: string };
    expect(a.id).not.toBe(b.id);
    expect((store.list() as { label: string }[]).map((x) => x.label)).toEqual(["Corner", "Area"]);
    store.remove(a.id);
    expect((store.list() as { label: string }[]).map((x) => x.label)).toEqual(["Area"]);
    store.remove("no-such-id");
    expect(store.list()).toHaveLength(1);
  });

  test("a view is cleaned on the way in; one that is not a view is refused", () => {
    const store = localBookmarkStore(memory(), "k");
    const saved = store.add({ v: 1, imageId: 1, zoom: 5000, cx: 5 }, "x") as { view: { zoom: number; cx: number } };
    expect(saved.view.zoom).toBeLessThan(5000);
    expect(saved.view.cx).toBe(1);
    expect(() => store.add({ v: 1 } as never, "bad")).toThrow();
  });

  test("each key is its own list, and the key may come later", () => {
    const storage = memory();
    let key: string | null = null;
    const store = localBookmarkStore(storage, () => key);
    expect(store.list()).toEqual([]);
    expect(() => store.add({ v: 1, imageId: 1 }, "no catalog yet")).toThrow();
    key = bookmarksStorageKey("a.ecatm", "A");
    store.add({ v: 1, imageId: 1 }, "in A");
    key = bookmarksStorageKey("b.ecatm", "B");
    expect(store.list()).toEqual([]);
    key = bookmarksStorageKey("a.ecatm", "A");
    expect(store.list()).toHaveLength(1);
  });

  test("a corrupted entry or a bad item is skipped, not thrown on", () => {
    const storage = memory();
    const store = localBookmarkStore(storage, "k");
    storage.setItem("k", "{not json");
    expect(store.list()).toEqual([]);
    storage.setItem("k", JSON.stringify([{ id: "ok", label: "fine", view: { v: 1, imageId: 2 } }, { id: 5 }, null, { id: "x", label: "y", view: { v: 1 } }]));
    expect((store.list() as { id: string }[]).map((b) => b.id)).toEqual(["ok"]);
    storage.setItem("k", '"a string"');
    expect(store.list()).toEqual([]);
  });
});

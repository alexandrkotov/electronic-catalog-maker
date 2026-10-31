import type { KeyValueStorage } from "./types.js";
import { normalizeView, type EcatmView } from "./view.js";

/** One saved place in a catalog: the view to return to and the name its owner gave it. */
export interface Bookmark {
  /** Stable for as long as the bookmark exists; what `remove` is given. */
  id: string;
  label: string;
  view: EcatmView;
}

/**
 * Where a viewer keeps its bookmarks. The host implements it (a server, a
 * user's account) and passes it as `bookmarks`; the viewer draws the panel.
 * Each method may answer at once or return a promise. The store belongs to the
 * catalog on screen: the viewer asks for `list()` whenever its panel opens.
 */
export interface BookmarkStore {
  list(): Bookmark[] | Promise<Bookmark[]>;
  /** Saves a view and returns the new bookmark, with its id. */
  add(view: EcatmView, label: string): Bookmark | Promise<Bookmark>;
  remove(id: string): void | Promise<void>;
}

/** Identifies "this catalog" for the built-in store, the same way cartStorageKey does for the cart. */
export function bookmarksStorageKey(sourceName: string, catalogName: string): string {
  return `ecm-viewer-bookmarks:${sourceName}::${catalogName}`;
}

function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The built-in store: a catalog's bookmarks as one JSON entry in `storage`
 * (localStorage, or the in-memory stand-in of a viewer mounted with
 * `persist: false`). `key` may be a function, for a store made before a
 * catalog is open; without a key (null) it is empty and `add` throws.
 * Corrupted entries are skipped, never thrown on.
 */
export function localBookmarkStore(storage: KeyValueStorage, key: string | (() => string | null)): BookmarkStore {
  const keyNow = () => (typeof key === "function" ? key() : key);
  const read = (): Bookmark[] => {
    const k = keyNow();
    if (k === null) return [];
    try {
      const parsed: unknown = JSON.parse(storage.getItem(k) ?? "[]");
      if (!Array.isArray(parsed)) return [];
      return parsed.flatMap((b: Partial<Bookmark> | null): Bookmark[] => {
        const view = normalizeView(b?.view);
        return b && typeof b.id === "string" && typeof b.label === "string" && view ? [{ id: b.id, label: b.label, view }] : [];
      });
    } catch {
      return [];
    }
  };
  const write = (list: Bookmark[]) => {
    const k = keyNow();
    if (k === null) throw new Error("No catalog is open");
    storage.setItem(k, JSON.stringify(list));
  };
  return {
    list: read,
    add(view, label) {
      const normalized = normalizeView(view);
      if (!normalized) throw new Error("Not a view");
      const bookmark: Bookmark = { id: newId(), label, view: normalized };
      write([...read(), bookmark]);
      return bookmark;
    },
    remove(id) {
      write(read().filter((b) => b.id !== id));
    },
  };
}

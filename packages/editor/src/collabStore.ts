/**
 * Persists a room's outbox — edits made while disconnected, not yet
 * confirmed sent — to IndexedDB, so they survive an accidental tab reload
 * and not just a brief network blip (see project notes, Phase 3).
 *
 * Deliberately does *not* persist the catalog itself or `lastAppliedSeq`:
 * this editor never keeps the open catalog anywhere but in-memory sql.js
 * (true before this feature existed too — reloading loses the open file
 * today regardless), so a reload always re-joins from scratch (fresh
 * snapshot + a full ops replay from the start) rather than resuming
 * mid-stream. The outbox is what's actually worth surviving that: once
 * rejoined, it gets drained against the now-complete history the same way
 * a same-tab reconnect drains it against just what it missed.
 */

export interface QueuedOp {
  fn: string;
  args: unknown[];
}

const DB_NAME = "ecm-collab";
const STORE_NAME = "outboxes";

function openStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME, { keyPath: "roomId" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Every IndexedDB call is wrapped like this — private/incognito windows and disabled site data both throw, and losing the outbox to a storage quirk shouldn't crash the tab, just fall back to in-memory-only (no reload survival) for that session. */
async function safely<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

export function loadOutbox(roomId: string): Promise<QueuedOp[]> {
  return safely(async () => {
    const db = await openStore();
    return await new Promise<QueuedOp[]>((resolve, reject) => {
      const req = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(roomId);
      req.onsuccess = () => resolve((req.result?.outbox as QueuedOp[] | undefined) ?? []);
      req.onerror = () => reject(req.error);
    });
  }, []);
}

export function saveOutbox(roomId: string, outbox: QueuedOp[]): Promise<void> {
  return safely(async () => {
    const db = await openStore();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      if (outbox.length === 0) {
        tx.objectStore(STORE_NAME).delete(roomId);
      } else {
        tx.objectStore(STORE_NAME).put({ roomId, outbox });
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }, undefined);
}

export function clearOutbox(roomId: string): Promise<void> {
  return saveOutbox(roomId, []);
}

import type { Database } from "sql.js";
import {
  findRowByUrl,
  getImage,
  getLink,
  getRow,
  hasOtherLinkForUrl,
  listLinksForImage,
  listRowsForImage,
  readMeta,
} from "./db.js";
import type { AddImageInput, AddLinkInput, AddRowInput } from "./db.js";

/**
 * Undo support for the editor's catalog edits: given one edit about to be
 * (or just) applied to the database, work out the edit(s) that put things
 * back exactly as they were. The result is plain `{ fn, args }` data — the
 * same shape the collaboration layer relays — so the editor replays it
 * through the very same functions it uses for every other edit, and
 * capturing *that* replay's inverse in turn is what makes redo free.
 *
 * Two entry points because an add only learns its id afterward, while
 * everything else has to be read before it is overwritten or deleted.
 */
export interface UndoOp {
  fn: string;
  args: unknown[];
}

const ADD_FUNCTIONS = new Set(["addImage", "addLink", "addRow"]);

/** addImage / addLink / addRow — capture these with captureUndoAfterAdd, after they ran. */
export function isAddOp(fn: string): boolean {
  return ADD_FUNCTIONS.has(fn);
}

/**
 * The inverse of every non-add edit, read from `db` as it is *before* the
 * edit runs. `[]` means the target is already gone, so the edit changes
 * nothing worth undoing; `null` means this function isn't one undo knows
 * how to reverse (the caller should drop its history rather than guess).
 */
export function captureUndoBefore(db: Database, fn: string, args: unknown[]): UndoOp[] | null {
  switch (fn) {
    case "updateStoreSettings": {
      const m = readMeta(db);
      return [
        {
          fn,
          args: [
            {
              catalogMode: m.catalogMode,
              storeUrl: m.storeUrl,
              cartMode: m.cartMode,
              cartIdPattern: m.cartIdPattern,
              cartItemParam: m.cartItemParam,
              cartCheckoutBaseUrl: m.cartCheckoutBaseUrl,
              defaultView: m.defaultView,
            },
          ],
        },
      ];
    }
    case "updateImage": {
      const image = getImage(db, args[0] as number);
      if (!image) return [];
      return [{ fn, args: [image.id, { name: image.name, folder: image.folder, fitOnOpen: image.fitOnOpen, hideMarkers: image.hideMarkers }] }];
    }
    case "deleteImage": {
      const imageId = args[0] as number;
      const image = getImage(db, imageId);
      if (!image) return [];
      const ops: UndoOp[] = [
        {
          fn: "addImage",
          args: [
            {
              id: image.id,
              name: image.name,
              mimeType: image.mimeType,
              imageData: image.imageData,
              width: image.width,
              height: image.height,
              sortOrder: image.sortOrder,
              folder: image.folder,
              fitOnOpen: image.fitOnOpen,
              hideMarkers: image.hideMarkers,
            } satisfies AddImageInput,
          ],
        },
      ];
      for (const link of listLinksForImage(db, imageId)) ops.push({ fn: "addLink", args: [linkInput(link)] });
      for (const row of listRowsForImage(db, imageId)) ops.push({ fn: "addRow", args: [rowInput(row)] });
      return ops;
    }
    case "updateLink": {
      const link = getLink(db, args[0] as number);
      if (!link) return [];
      return [{ fn, args: [link.id, { name: link.name, url: link.url }] }];
    }
    case "updateLinkPosition": {
      const link = getLink(db, args[0] as number);
      if (!link) return [];
      return [{ fn, args: [link.id, link.top, link.left] }];
    }
    case "deleteLink": {
      const link = getLink(db, args[0] as number);
      if (!link) return [];
      const ops: UndoOp[] = [{ fn: "addLink", args: [linkInput(link)] }];
      // deleteLink also removes the data row when this was the last hotspot on its url.
      const row = hasOtherLinkForUrl(db, link.url, link.id) ? null : findRowByUrl(db, link.url);
      if (row) ops.push({ fn: "addRow", args: [rowInput(row)] });
      return ops;
    }
    case "updateRow": {
      const row = getRow(db, args[0] as number);
      if (!row) return [];
      return [{ fn, args: [row.id, { name: row.name, sku: row.sku, description: row.description, extra: row.extra }] }];
    }
    case "deleteRow": {
      const row = getRow(db, args[0] as number);
      if (!row) return [];
      return [{ fn: "addRow", args: [rowInput(row)] }];
    }
    default:
      return null;
  }
}

/**
 * What one edit touches, for undo in a shared session. Other people's edits
 * land between yours and an undo of them, so an undo entry is only safe to
 * replay while nothing it would put back has been touched by someone else:
 *   - `writes` are the keys the edit changes — a remote edit's writes are
 *     compared against the entries still on the history stacks;
 *   - `needs` are the keys that must stay untouched for the edit to be
 *     undone (or redone) safely — what an entry remembers about itself.
 * Keys name records, not values: `link:7`, `row:3`, `image:2` (the image
 * exists), `imageprops:2` (its name/folder), `content:2` (which hotspots and
 * rows it holds), `url:p-100` (which hotspots sit on that url) and
 * `rowurl:p-100` (whether a data row sits there — only one can), `settings`.
 *
 * Read from `db` before the edit runs (an add carries everything it needs
 * in its input, which must already have its id). Edits of different records
 * share no key, so two people adding hotspots to the same picture can each
 * still undo their own.
 */
export interface OpFootprint {
  writes: string[];
  needs: string[];
}

export function opFootprint(db: Database, fn: string, args: unknown[]): OpFootprint {
  const writes: string[] = [];
  const needs: string[] = [];
  const both = (...keys: string[]) => {
    writes.push(...keys);
    needs.push(...keys);
  };
  switch (fn) {
    case "addImage": {
      const id = (args[0] as { id: number }).id;
      both(`image:${id}`, `imageprops:${id}`, `content:${id}`);
      break;
    }
    case "updateImage": {
      const id = args[0] as number;
      writes.push(`imageprops:${id}`);
      needs.push(`imageprops:${id}`, `image:${id}`);
      break;
    }
    case "deleteImage": {
      const id = args[0] as number;
      both(`image:${id}`, `imageprops:${id}`, `content:${id}`);
      for (const link of listLinksForImage(db, id)) both(`link:${link.id}`, `url:${link.url}`);
      for (const row of listRowsForImage(db, id)) both(`row:${row.id}`, `rowurl:${row.url}`);
      break;
    }
    case "addLink": {
      const input = args[0] as { id: number; imageId: number; url: string };
      writes.push(`link:${input.id}`, `url:${input.url}`, `content:${input.imageId}`);
      needs.push(`link:${input.id}`, `image:${input.imageId}`);
      // Undoing the add deletes the hotspot — and with it a data row that was already waiting on this url.
      // That row is put back afterwards, which only works while it and its url are as they were.
      const row = findRowByUrl(db, input.url);
      if (row) needs.push(`row:${row.id}`, `rowurl:${input.url}`, `url:${input.url}`);
      break;
    }
    case "updateLink": {
      const id = args[0] as number;
      both(`link:${id}`);
      const link = getLink(db, id);
      const url = (args[1] as { url: string }).url;
      if (link && link.url !== url) {
        both(`url:${link.url}`, `url:${url}`, `rowurl:${link.url}`, `rowurl:${url}`);
        for (const key of [link.url, url]) {
          const row = findRowByUrl(db, key);
          if (row) both(`row:${row.id}`);
        }
      }
      break;
    }
    case "updateLinkPosition":
      both(`link:${args[0] as number}`);
      break;
    case "deleteLink": {
      const link = getLink(db, args[0] as number);
      if (!link) break;
      writes.push(`link:${link.id}`, `url:${link.url}`, `content:${link.imageId}`);
      needs.push(`link:${link.id}`, `image:${link.imageId}`);
      // The last hotspot on a url takes its data row along; undoing brings it back.
      const row = hasOtherLinkForUrl(db, link.url, link.id) ? null : findRowByUrl(db, link.url);
      if (row) both(`row:${row.id}`, `rowurl:${link.url}`);
      break;
    }
    case "addRow": {
      const input = args[0] as { id: number; imageId: number; url: string };
      writes.push(`row:${input.id}`, `rowurl:${input.url}`, `content:${input.imageId}`);
      needs.push(`row:${input.id}`, `image:${input.imageId}`);
      break;
    }
    case "updateRow":
      both(`row:${args[0] as number}`);
      break;
    case "deleteRow": {
      const row = getRow(db, args[0] as number);
      if (!row) break;
      writes.push(`row:${row.id}`, `rowurl:${row.url}`, `content:${row.imageId}`);
      needs.push(`row:${row.id}`, `rowurl:${row.url}`, `image:${row.imageId}`);
      break;
    }
    case "updateStoreSettings":
      both("settings");
      break;
  }
  return { writes, needs };
}

/** The inverse of an add, called after it ran with the id it landed on (`input.id` must be set). */
export function captureUndoAfterAdd(db: Database, fn: string, input: { id?: number }): UndoOp[] | null {
  const id = input.id;
  if (id === undefined) return null;
  switch (fn) {
    case "addImage":
      return [{ fn: "deleteImage", args: [id] }];
    case "addLink": {
      const ops: UndoOp[] = [{ fn: "deleteLink", args: [id] }];
      // deleteLink removes the row sitting on this url when this is its only hotspot, so a row that
      // was there before the add (a bare row with no hotspot) has to come back with it.
      const link = getLink(db, id);
      const row = link && !hasOtherLinkForUrl(db, link.url, id) ? findRowByUrl(db, link.url) : null;
      if (row) ops.push({ fn: "addRow", args: [rowInput(row)] });
      return ops;
    }
    case "addRow":
      return [{ fn: "deleteRow", args: [id] }];
    default:
      return null;
  }
}

function linkInput(link: { id: number; imageId: number; name: string; url: string; top: number; left: number; fontSize: number }): AddLinkInput {
  return { id: link.id, imageId: link.imageId, name: link.name, url: link.url, top: link.top, left: link.left, fontSize: link.fontSize };
}

function rowInput(row: { id: number; imageId: number; url: string; name: string; sku: string; description: string; extra: Record<string, string> }): AddRowInput {
  return { id: row.id, imageId: row.imageId, url: row.url, name: row.name, sku: row.sku, description: row.description, extra: row.extra };
}

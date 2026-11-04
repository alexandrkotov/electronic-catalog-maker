import type { Database } from "sql.js";
import { getImage } from "./db.js";
import type { CatalogImageInfo } from "./types.js";

export interface ImageGroup<T extends CatalogImageInfo = CatalogImageInfo> {
  /** "" = ungrouped — always sorted first, before any named folder. */
  folder: string;
  images: T[];
}

/**
 * Groups images by their `folder` field for the two-level image list —
 * ungrouped images first (in their existing order), then one group per
 * folder name, alphabetical. Purely presentational: `images.folder` is a
 * plain string column, not a normalized table (see schema.ts).
 */
export function groupImagesByFolder<T extends CatalogImageInfo>(images: T[]): ImageGroup<T>[] {
  const byFolder = new Map<string, T[]>();
  for (const img of images) {
    const key = img.folder.trim();
    const list = byFolder.get(key);
    if (list) list.push(img);
    else byFolder.set(key, [img]);
  }

  const folderNames = [...byFolder.keys()].filter((k) => k !== "").sort((a, b) => a.localeCompare(b));
  const out: ImageGroup<T>[] = [];
  const ungrouped = byFolder.get("");
  if (ungrouped) out.push({ folder: "", images: ungrouped });
  for (const name of folderNames) out.push({ folder: name, images: byFolder.get(name)! });
  return out;
}

/** Every distinct folder name already in use, for an autocomplete list when moving an image. */
export function collectFolders(images: CatalogImageInfo[]): string[] {
  const names = new Set(images.map((i) => i.folder.trim()).filter((f) => f !== ""));
  return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * `data:` URLs of the pictures shown on the stage, read from the database
 * once per image instead of on every redraw. Belongs to one database: asking
 * with another one starts over. A data URL rather than a blob: URL keeps
 * working on pages whose Content-Security-Policy allows only data: images.
 */
export class ImageSrcCache {
  private db: Database | null = null;
  private srcs = new Map<number, string>();

  get(db: Database, imageId: number): string {
    if (db !== this.db) this.clear(db);
    let src = this.srcs.get(imageId);
    if (src === undefined) {
      const image = getImage(db, imageId);
      src = image ? `data:${image.mimeType};base64,${image.imageData}` : "";
      this.srcs.set(imageId, src);
    }
    return src;
  }

  /** Forget everything — also needed when an image's picture may have changed under the same id. */
  clear(db: Database | null = null): void {
    this.db = db;
    this.srcs.clear();
  }
}

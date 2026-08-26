import type { CatalogImage } from "./types.js";

export interface ImageGroup {
  /** "" = ungrouped — always sorted first, before any named folder. */
  folder: string;
  images: CatalogImage[];
}

/**
 * Groups images by their `folder` field for the two-level image list —
 * ungrouped images first (in their existing order), then one group per
 * folder name, alphabetical. Purely presentational: `images.folder` is a
 * plain string column, not a normalized table (see schema.ts).
 */
export function groupImagesByFolder(images: CatalogImage[]): ImageGroup[] {
  const byFolder = new Map<string, CatalogImage[]>();
  for (const img of images) {
    const key = img.folder.trim();
    const list = byFolder.get(key);
    if (list) list.push(img);
    else byFolder.set(key, [img]);
  }

  const folderNames = [...byFolder.keys()].filter((k) => k !== "").sort((a, b) => a.localeCompare(b));
  const out: ImageGroup[] = [];
  const ungrouped = byFolder.get("");
  if (ungrouped) out.push({ folder: "", images: ungrouped });
  for (const name of folderNames) out.push({ folder: name, images: byFolder.get(name)! });
  return out;
}

/** Every distinct folder name already in use, for an autocomplete list when moving an image. */
export function collectFolders(images: CatalogImage[]): string[] {
  const names = new Set(images.map((i) => i.folder.trim()).filter((f) => f !== ""));
  return [...names].sort((a, b) => a.localeCompare(b));
}

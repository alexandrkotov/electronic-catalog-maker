/**
 * Matches the photo folder against the table and lays items out into grids
 * (one per table folder, "" = the catalog root), plus the pre-build report.
 * Pure data — no DOM, no canvas — so it's unit-tested on its own.
 */
import type { ParsedTable, TableItem } from "./table.js";

const PHOTO_EXT = /\.(jpe?g|png|webp|gif|avif|bmp)$/i;

export interface PlanItem {
  item: TableItem;
  /** Key into the photo map, or null when no photo carries this number. */
  photo: string | null;
  /** rows.url — the join key between hotspot and row. */
  url: string;
}

export interface GridPlan {
  folder: string;
  /** 1-based part, when a big folder is split over several grids. */
  part: number;
  parts: number;
  items: PlanItem[];
}

export interface Report {
  /** Blocking: the build button stays off while any of these is non-empty. */
  badNumbers: ParsedTable["badNumbers"];
  duplicateNumbers: Array<{ no: number; lines: number[] }>;
  noItems: boolean;
  /** Warnings: the build still goes ahead. */
  missingPhotos: number[];
  orphanPhotos: string[];
  duplicatePhotos: string[];
  unrecognizedFiles: string[];
  duplicateSkus: Array<{ sku: string; nos: number[] }>;
  emptyNames: number[];
}

export interface Plan {
  grids: GridPlan[];
  report: Report;
  /** The file chosen for each photo number. */
  photoByNo: Map<number, string>;
}

export function isBlocking(r: Report): boolean {
  return r.noItems || r.badNumbers.length > 0 || r.duplicateNumbers.length > 0;
}

/** "7.jpg", "007.JPG" -> 7; anything else -> null. */
export function photoNumber(fileName: string): number | null {
  if (!PHOTO_EXT.test(fileName)) return null;
  const stem = fileName.replace(PHOTO_EXT, "");
  if (!/^\d+$/.test(stem)) return null;
  const n = Number(stem);
  return n >= 1 ? n : null;
}

/**
 * `maxPerGrid` is a technical ceiling (see render.ts maxTilesPerGrid), not a
 * user setting: a folder over it is split into equal parts, each a whole
 * number of rows (`columns`), so no part ends with a stub row.
 */
export function makePlan(table: ParsedTable, photoNames: string[], maxPerGrid: number, columns: number): Plan {
  const photoByNo = new Map<number, string>();
  const duplicatePhotos: string[] = [];
  const unrecognizedFiles: string[] = [];
  for (const name of [...photoNames].sort((a, b) => a.localeCompare(b))) {
    const n = photoNumber(name);
    if (n === null) unrecognizedFiles.push(name);
    else if (photoByNo.has(n)) duplicatePhotos.push(name);
    else photoByNo.set(n, name);
  }

  const linesByNo = new Map<number, number[]>();
  for (const it of table.items) linesByNo.set(it.no, [...(linesByNo.get(it.no) ?? []), it.line]);
  const duplicateNumbers = [...linesByNo]
    .filter(([, lines]) => lines.length > 1)
    .map(([no, lines]) => ({ no, lines }));

  const nosBySku = new Map<string, number[]>();
  for (const it of table.items) if (it.sku) nosBySku.set(it.sku, [...(nosBySku.get(it.sku) ?? []), it.no]);
  const duplicateSkus = [...nosBySku]
    .filter(([, nos]) => nos.length > 1)
    .map(([sku, nos]) => ({ sku, nos }));

  // A unique SKU is the natural row key; otherwise fall back to the number.
  const taken = new Set<string>();
  const urlOf = new Map<TableItem, string>();
  for (const it of table.items) if (it.sku && nosBySku.get(it.sku)!.length === 1) taken.add(it.sku);
  for (const it of table.items) {
    if (it.sku && nosBySku.get(it.sku)!.length === 1) {
      urlOf.set(it, it.sku);
      continue;
    }
    let url = `item-${it.no}`;
    for (let k = 2; taken.has(url); k++) url = `item-${it.no}-${k}`;
    taken.add(url);
    urlOf.set(it, url);
  }

  // Root first, then folders in the order the table first mentions them.
  const byFolder = new Map<string, TableItem[]>([["", []]]);
  for (const it of table.items) byFolder.set(it.folder, [...(byFolder.get(it.folder) ?? []), it]);
  const grids: GridPlan[] = [];
  for (const [folder, items] of byFolder) {
    if (items.length === 0) continue;
    const sorted = [...items].sort((a, b) => a.no - b.no);
    const parts = maxPerGrid > 0 ? Math.ceil(sorted.length / maxPerGrid) : 1;
    const size = Math.ceil(Math.ceil(sorted.length / parts) / columns) * columns;
    for (let p = 0; p < parts; p++) {
      grids.push({
        folder,
        part: p + 1,
        parts,
        items: sorted.slice(p * size, (p + 1) * size).map((item) => ({
          item,
          photo: photoByNo.get(item.no) ?? null,
          url: urlOf.get(item)!,
        })),
      });
    }
  }

  const tableNos = new Set(table.items.map((it) => it.no));
  return {
    grids,
    photoByNo,
    report: {
      badNumbers: table.badNumbers,
      duplicateNumbers,
      noItems: table.items.length === 0,
      missingPhotos: table.items.filter((it) => !photoByNo.has(it.no)).map((it) => it.no),
      orphanPhotos: [...photoByNo].filter(([n]) => !tableNos.has(n)).map(([, name]) => name),
      duplicatePhotos,
      unrecognizedFiles,
      duplicateSkus,
      emptyNames: table.items.filter((it) => it.name === "").map((it) => it.no),
    },
  };
}

import type { CatalogRow } from "./types.js";

/**
 * "all" searches name/sku/description and every value in `extra`; the fixed
 * fields narrow to one column; "extra:<key>" narrows to one specific key
 * inside a row's free-form `extra` JSON (see schema.ts) — e.g. "material"
 * for a catalog that happens to track that per-row.
 */
export type SearchField = "all" | "name" | "sku" | "description" | `extra:${string}`;

/** Union of every key used in any row's `extra` object, for building a field dropdown. */
export function collectExtraKeys(rows: CatalogRow[]): string[] {
  const keys = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row.extra)) keys.add(key);
  }
  return [...keys].sort((a, b) => a.localeCompare(b));
}

/** Case-insensitive substring match. Empty query matches nothing (no results to show yet). */
export function searchRows(rows: CatalogRow[], query: string, field: SearchField): CatalogRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return rows.filter((row) => matches(row, q, field));
}

function matches(row: CatalogRow, q: string, field: SearchField): boolean {
  if (field === "name") return row.name.toLowerCase().includes(q);
  if (field === "sku") return row.sku.toLowerCase().includes(q);
  if (field === "description") return row.description.toLowerCase().includes(q);
  if (field.startsWith("extra:")) {
    const value = row.extra[field.slice("extra:".length)];
    return value !== undefined && String(value).toLowerCase().includes(q);
  }
  // "all"
  return (
    row.name.toLowerCase().includes(q) ||
    row.sku.toLowerCase().includes(q) ||
    row.description.toLowerCase().includes(q) ||
    Object.values(row.extra).some((v) => String(v).toLowerCase().includes(q))
  );
}

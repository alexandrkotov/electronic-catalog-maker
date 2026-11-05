/**
 * One callout, several rows: a parts manual often lists one position (one
 * number on the drawing) with a different part for each model — "VALVE,
 * Intake: 73117 for the A1A, LW-13087 for the E1A4". Rows are unique by
 * address and a marker points at one address, so the second row names the
 * first one in its extra: `callout` = the address of the row whose marker it
 * shares. The viewer then treats them as one position: the marker selects
 * both rows, either row selects the marker.
 *
 * One level only: a row names a row that has a marker of its own; a `callout`
 * that leads nowhere (deleted row, no marker on this picture) is ignored and
 * the row is a plain row again.
 */

import type { CatalogRow } from "./types.js";

/** Extra key holding the address of the row whose marker this row shares. */
export const CALLOUT_KEY = "callout";

/** The address this row's `callout` names, or null (none, empty, or itself). */
export function calloutOf(row: Pick<CatalogRow, "url" | "extra">): string | null {
  const raw = row.extra[CALLOUT_KEY];
  const url = typeof raw === "string" ? raw.trim() : "";
  return url && url !== row.url ? url : null;
}

/**
 * The address of the marker that stands for this row on a picture: its own
 * address when a marker has it, else the one its `callout` names when a marker
 * has that; null when neither (a row listed only).
 */
export function markerUrlFor(row: Pick<CatalogRow, "url" | "extra">, markerUrls: ReadonlySet<string>): string | null {
  if (markerUrls.has(row.url)) return row.url;
  const shared = calloutOf(row);
  return shared !== null && markerUrls.has(shared) ? shared : null;
}

/**
 * A free address for one more row under the callout `url`: `url~2`, `url~3`, …
 * (the editor's "another model" row; addresses are unique per catalog).
 */
export function nextCalloutRowUrl(url: string, taken: ReadonlySet<string>): string {
  for (let n = 2; ; n++) {
    const candidate = `${url}~${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Table order: each row that names another row of the list as its callout
 * comes right after that row (after the ones already there), so a position
 * reads as one block, a row added later for another model included (by
 * insertion order alone it would land at the bottom). Everything else keeps
 * its order.
 */
export function groupCalloutRows<T extends Pick<CatalogRow, "url" | "extra">>(rows: T[]): T[] {
  const urls = new Set(rows.map((r) => r.url));
  const leadOf = (r: T): string | null => {
    const url = calloutOf(r);
    return url !== null && urls.has(url) ? url : null;
  };
  const followers = new Map<string, T[]>();
  for (const r of rows) {
    const lead = leadOf(r);
    if (lead !== null) followers.set(lead, [...(followers.get(lead) ?? []), r]);
  }
  const out: T[] = [];
  const placed = new Set<T>();
  const place = (r: T) => {
    if (placed.has(r)) return;
    placed.add(r);
    out.push(r);
    for (const f of followers.get(r.url) ?? []) place(f);
  };
  for (const r of rows) if (leadOf(r) === null) place(r);
  for (const r of rows) place(r); // rows only in a loop of callouts: where they were
  return out;
}


/**
 * "Where to buy": a row button that opens a list of sites (marketplaces,
 * dealers, stores) where the row's part number can be searched. The catalog
 * carries its own list in the `where_to_buy` meta key (JSON, edited in the
 * editor); the viewer only builds links from it — nothing here talks to those
 * sites, and the format names none of them.
 *
 * A site either has a search link template (`searchUrl`, e.g.
 * `https://example.com/search?q={pn}`) or none, in which case the viewer
 * copies the number and opens the site's home page for the visitor to paste
 * it into the site's own search box.
 */

import type { CatalogRow } from "./types.js";

/** Meta key holding the JSON settings. */
export const WHERE_TO_BUY_META_KEY = "where_to_buy";

export interface WhereToBuySite {
  name: string;
  /** Short line under the name, e.g. "Marketplace" or "Used parts". */
  kind: string;
  /** Badge color, a CSS hex color; "" = a neutral default. */
  color: string;
  /** Opened when there is no search link (after copying the number). */
  home: string;
  /** Search link template with placeholders — see fillSearchUrl. "" = none. */
  searchUrl: string;
  enabled: boolean;
}

/** Which row value is the part number: one of the fixed columns or an extra key (`extra:<key>`). */
export type PartNumberSource = "sku" | "name" | "url" | `extra:${string}`;

export interface WhereToBuySettings {
  /** "replace": the button takes Buy's place; "both": next to Buy; "off" (default): not shown. */
  button: "replace" | "both" | "off";
  partNumber: PartNumberSource;
  /** Extra key holding alternate numbers for the same position (comma/semicolon separated); "" = none. */
  altKey: string;
  /** Fills {mfr}; also named in the digits-only warning. */
  manufacturer: string;
  /** Button label; "" = the viewer's own localized "Where to buy". */
  label: string;
  sites: WhereToBuySite[];
}

export const DEFAULT_WHERE_TO_BUY: WhereToBuySettings = {
  button: "off",
  partNumber: "sku",
  altKey: "alt_pn",
  manufacturer: "",
  label: "",
  sites: [],
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function readPartNumberSource(v: unknown): PartNumberSource {
  if (v === "sku" || v === "name" || v === "url") return v;
  if (typeof v === "string" && v.startsWith("extra:") && v.length > "extra:".length) return v as PartNumberSource;
  return DEFAULT_WHERE_TO_BUY.partNumber;
}

function readSite(v: unknown): WhereToBuySite | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const name = str(o.name).trim();
  if (!name) return null;
  const color = str(o.color).trim();
  return {
    name,
    kind: str(o.kind).trim(),
    color: /^#[0-9a-f]{3,8}$/i.test(color) ? color : "",
    home: str(o.home).trim(),
    searchUrl: str(o.searchUrl).trim(),
    enabled: o.enabled !== false,
  };
}

/** Reads the meta value; anything missing or malformed falls back to the defaults (feature off). */
export function parseWhereToBuy(json: string | undefined | null): WhereToBuySettings {
  if (!json) return { ...DEFAULT_WHERE_TO_BUY, sites: [] };
  let o: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...DEFAULT_WHERE_TO_BUY, sites: [] };
    o = parsed as Record<string, unknown>;
  } catch {
    return { ...DEFAULT_WHERE_TO_BUY, sites: [] };
  }
  const button = o.button === "replace" || o.button === "both" ? o.button : "off";
  return {
    button,
    partNumber: readPartNumberSource(o.partNumber),
    altKey: typeof o.altKey === "string" ? o.altKey.trim() : DEFAULT_WHERE_TO_BUY.altKey,
    manufacturer: str(o.manufacturer).trim(),
    label: str(o.label).trim(),
    sites: Array.isArray(o.sites) ? o.sites.map(readSite).filter((s): s is WhereToBuySite => s !== null) : [],
  };
}

export function serializeWhereToBuy(settings: WhereToBuySettings): string {
  return JSON.stringify(settings);
}

/** The sites the popup lists: enabled, and with something to open. */
export function activeSites(settings: WhereToBuySettings): WhereToBuySite[] {
  return settings.sites.filter((s) => s.enabled && (s.searchUrl || s.home));
}

/** Whether rows get the button at all. */
export function whereToBuyEnabled(settings: WhereToBuySettings): boolean {
  return settings.button !== "off" && activeSites(settings).length > 0;
}

function splitNumbers(value: string): string[] {
  return value
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The row's part number first, then its alternates (deduplicated, case-insensitive); [] = no button for this row. */
export function partNumbersForRow(row: CatalogRow, settings: WhereToBuySettings): string[] {
  const src = settings.partNumber;
  const main = (src.startsWith("extra:") ? str(row.extra[src.slice("extra:".length)]) : str(row[src as "sku" | "name" | "url"])).trim();
  if (!main) return [];
  const alts = settings.altKey ? splitNumbers(str(row.extra[settings.altKey])) : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const pn of [main, ...alts]) {
    const key = pn.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(pn);
  }
  return out;
}

/** Part number without dashes, spaces, dots and slashes — how many sites index it. */
export function compactPartNumber(pn: string): string {
  return pn.replace(/[-\s./]/g, "");
}

/**
 * Builds a site's search link. Placeholders: {pn} the number as written,
 * {pn_nodash} without dashes/spaces, {pn_lower} lower case, {mfr} the
 * catalog's manufacturer — each URL-encoded. Returns null when the template
 * is empty or the result isn't an http(s) link.
 */
export function fillSearchUrl(template: string, pn: string, manufacturer: string): string | null {
  if (!template) return null;
  const values: Record<string, string> = {
    pn,
    pn_nodash: compactPartNumber(pn),
    pn_lower: pn.toLowerCase(),
    mfr: manufacturer,
  };
  const filled = template.replace(/\{(pn_nodash|pn_lower|pn|mfr)\}/g, (_, key: string) => encodeURIComponent(values[key] ?? ""));
  return safeHttpUrl(filled);
}

/** The home link to open for a site without a search link; null when it isn't an http(s) link. */
export function siteHomeUrl(site: WhereToBuySite): string | null {
  return site.home ? safeHttpUrl(site.home) : null;
}

function safeHttpUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

/**
 * A number made only of digits (dashes/spaces allowed): other manufacturers
 * use the same digits, so a search for it also finds unrelated parts.
 */
export function isDigitsOnlyPartNumber(pn: string): boolean {
  return /^\d[\d\s-]*$/.test(pn.trim());
}

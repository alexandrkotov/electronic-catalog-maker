/**
 * Address search through OpenStreetMap's Nominatim, within its usage policy:
 * one request per second at most, and only on an explicit search (Enter or
 * the button) — never per keystroke. The browser identifies the app by its
 * Referer; a page can't set its own User-Agent.
 */

export interface Place {
  name: string;
  /** Full address line. */
  label: string;
  lng: number;
  lat: number;
  /** [west, south, east, north], when the place has an extent. */
  bounds: [number, number, number, number] | null;
}

const ENDPOINT = "https://nominatim.openstreetmap.org/search";
const MIN_INTERVAL_MS = 1100;

let lastRequestAt = 0;

interface NominatimResult {
  name?: string;
  display_name: string;
  lat: string;
  lon: string;
  boundingbox?: [string, string, string, string];
}

export function toPlace(r: NominatimResult): Place {
  // boundingbox is [south, north, west, east].
  const b = r.boundingbox?.map(Number);
  const bounds: Place["bounds"] =
    b && b.length === 4 && b.every(Number.isFinite) ? [b[2]!, b[0]!, b[3]!, b[1]!] : null;
  return {
    name: r.name?.trim() || r.display_name.split(",")[0]!.trim(),
    label: r.display_name,
    lng: Number(r.lon),
    lat: Number(r.lat),
    bounds,
  };
}

export async function searchPlaces(query: string, locale: string): Promise<Place[]> {
  const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();

  const url = `${ENDPOINT}?${new URLSearchParams({ format: "jsonv2", limit: "5", "accept-language": locale, q: query })}`;
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const results = (await response.json()) as NominatimResult[];
  return results.map(toPlace).filter((p) => Number.isFinite(p.lng) && Number.isFinite(p.lat));
}

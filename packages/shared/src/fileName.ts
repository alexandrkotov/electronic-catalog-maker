/**
 * The file-name stem a catalog is saved or exported under, from its name:
 * letters and digits of any script are kept ("Моя карта" → "Моя_карта"), and
 * every run of anything else — spaces, punctuation, characters a file system
 * refuses — becomes one "_". A name with nothing usable gives "catalog".
 */
export function catalogFileStem(catalogName: string | undefined | null): string {
  const stem = (catalogName ?? "").replace(/[^\p{L}\p{N}_-]+/gu, "_").replace(/^_+|_+$/g, "");
  return stem || "catalog";
}

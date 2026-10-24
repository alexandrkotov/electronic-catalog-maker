/**
 * Navigation hotspots: a link whose address is `#image=<id>` jumps to that
 * image instead of pointing at a data row — the classic "room overview →
 * close-up of one piece → ⌂ back to the room" catalog shape (the legacy
 * link-map editor's internal `#anchor` links). No schema change: it is just
 * an address convention in links.url, and a navigation link never gets a
 * row. `=` can't appear in an editor-generated slug (see slugify), so an
 * ordinary item address can't be mistaken for one.
 */
const NAV_LINK = /^#image=(\d+)$/;

/**
 * Catalog links: `#catalog=<address>` opens another catalog in the same
 * viewer — a quest's next chapter, a password-protected bonus file, a
 * related catalog. A relative address is resolved against the open
 * catalog's own address (see resolveCatalogLink). Like `#image=`, it never
 * gets a row.
 */
const CATALOG_LINK = /^#catalog=(\S+)$/;

/** The target image id of a navigation link's address, or null for an ordinary (item) address. */
export function navTargetImageId(url: string): number | null {
  const m = NAV_LINK.exec(url.trim());
  return m ? Number(m[1]) : null;
}

/** The address a catalog link opens, as written (possibly relative), or null for any other address. */
export function catalogLinkTarget(url: string): string | null {
  const m = CATALOG_LINK.exec(url.trim());
  return m ? m[1]! : null;
}

/**
 * The absolute address of a catalog link's target: relative to the open
 * catalog's address when it was opened from one, else to the page. Only
 * http(s) is followed. Null when the address can't be resolved.
 */
export function resolveCatalogLink(target: string, base: string): string | null {
  try {
    const url = new URL(target, base);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

/** A hotspot that leads somewhere (another image, another catalog) instead of pointing at a data row. */
export function isNavLink(link: { url: string }): boolean {
  return navTargetImageId(link.url) !== null || catalogLinkTarget(link.url) !== null;
}

export function navLinkUrl(imageId: number): string {
  return `#image=${imageId}`;
}

/**
 * The navigation links that lead further into the catalog: to an image
 * listed after the one they are on (`imageIds` in catalog order). A "⌂" back
 * to the overview leads to an earlier image, so it isn't one — on paper there
 * is nowhere to go back to, while a forward marker still says what is where.
 */
export function forwardNavLinks<T extends { url: string }>(links: T[], imageId: number, imageIds: number[]): T[] {
  const from = imageIds.indexOf(imageId);
  return links.filter((link) => {
    const target = navTargetImageId(link.url);
    return target !== null && imageIds.indexOf(target) > from;
  });
}

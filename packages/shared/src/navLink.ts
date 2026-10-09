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

/** The target image id of a navigation link's address, or null for an ordinary (item) address. */
export function navTargetImageId(url: string): number | null {
  const m = NAV_LINK.exec(url.trim());
  return m ? Number(m[1]) : null;
}

export function isNavLink(link: { url: string }): boolean {
  return navTargetImageId(link.url) !== null;
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

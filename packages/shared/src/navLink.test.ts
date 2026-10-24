import { describe, expect, test } from "bun:test";
import { catalogLinkTarget, forwardNavLinks, isNavLink, navLinkUrl, navTargetImageId, resolveCatalogLink } from "./navLink.js";

describe("navTargetImageId", () => {
  test("reads the target of #image=<id>, tolerating surrounding spaces", () => {
    expect(navTargetImageId("#image=1")).toBe(1);
    expect(navTargetImageId(" #image=42 ")).toBe(42);
  });

  test("ordinary item addresses are not navigation links", () => {
    for (const url of ["#image-1", "#sofa", "image=1", "#image=", "#image=1a", "LR-101", "https://example.com/#image=1"]) {
      expect(navTargetImageId(url)).toBeNull();
    }
  });

  test("navLinkUrl round-trips", () => {
    expect(navTargetImageId(navLinkUrl(7))).toBe(7);
    expect(isNavLink({ url: navLinkUrl(3) })).toBe(true);
    expect(isNavLink({ url: "#coffee-table" })).toBe(false);
  });
});

describe("forwardNavLinks", () => {
  // Catalog order: overview 5, then pages 9 and 2 (ids don't follow the order).
  const order = [5, 9, 2];

  test("an overview's markers lead forward, a page's ⌂ doesn't", () => {
    const overview = [{ url: "#image=9" }, { url: "#image=2" }, { url: "LR-101" }];
    expect(forwardNavLinks(overview, 5, order)).toEqual([{ url: "#image=9" }, { url: "#image=2" }]);
    expect(forwardNavLinks([{ url: "#image=5" }], 9, order)).toEqual([]);
    expect(forwardNavLinks([{ url: "#image=5" }, { url: "#image=2" }], 9, order)).toEqual([{ url: "#image=2" }]);
  });

  test("a link to itself or to a missing image is not forward", () => {
    expect(forwardNavLinks([{ url: "#image=5" }, { url: "#image=77" }], 5, order)).toEqual([]);
  });
});

describe("catalog links", () => {
  test("#catalog=<address> is a navigation link to another catalog", () => {
    expect(catalogLinkTarget("#catalog=crypt.ecatm")).toBe("crypt.ecatm");
    expect(catalogLinkTarget(" #catalog=https://example.com/a.ecatm ")).toBe("https://example.com/a.ecatm");
    expect(isNavLink({ url: "#catalog=crypt.ecatm" })).toBe(true);
    expect(navTargetImageId("#catalog=crypt.ecatm")).toBeNull();
  });

  test("anything else is not one", () => {
    for (const url of ["#catalog=", "#catalog", "catalog=a.ecatm", "#catalog=a b.ecatm", "#image=3", "#crypt"]) {
      expect(catalogLinkTarget(url)).toBeNull();
    }
  });

  test("resolves against the open catalog's address, http(s) only", () => {
    expect(resolveCatalogLink("crypt.ecatm", "https://play.tapalog.com/haunted-house/house.ecatm")).toBe(
      "https://play.tapalog.com/haunted-house/crypt.ecatm",
    );
    expect(resolveCatalogLink("/demo/a.ecatm", "https://tapalog.com/viewer/")).toBe("https://tapalog.com/demo/a.ecatm");
    expect(resolveCatalogLink("javascript:alert(1)", "https://tapalog.com/")).toBeNull();
    expect(resolveCatalogLink("data:text/plain,x", "https://tapalog.com/")).toBeNull();
  });
});

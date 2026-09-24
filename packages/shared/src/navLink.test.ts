import { describe, expect, test } from "bun:test";
import { isNavLink, navLinkUrl, navTargetImageId } from "./navLink.js";

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

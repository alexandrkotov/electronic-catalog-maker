import { describe, expect, test } from "bun:test";
import { toolbarFromHideAttr } from "./toolbarHide.js";

describe("toolbarFromHideAttr", () => {
  test("no attribute or nothing known hides nothing", () => {
    expect(toolbarFromHideAttr(null)).toBeUndefined();
    expect(toolbarFromHideAttr("")).toBeUndefined();
    expect(toolbarFromHideAttr("search export")).toBeUndefined();
  });

  test("each name turns its control off, the rest keep their defaults", () => {
    expect(toolbarFromHideAttr("open open-remote refresh")).toEqual({ open: false, openRemote: false, refresh: false });
  });

  test("commas, extra spaces and capitals are fine", () => {
    expect(toolbarFromHideAttr(" Title,THEME ,, language ")).toEqual({ title: false, theme: false, language: false });
  });
});

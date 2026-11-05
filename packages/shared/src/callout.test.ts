import { describe, expect, test } from "bun:test";
import { calloutOf, groupCalloutRows, markerUrlFor, nextCalloutRowUrl } from "./callout.js";

const row = (url: string, extra: Record<string, string> = {}) => ({ url, extra });

describe("calloutOf", () => {
  test("reads the trimmed address", () => {
    expect(calloutOf(row("v~2", { callout: "  v " }))).toBe("v");
  });

  test("none, empty or the row itself means no shared callout", () => {
    expect(calloutOf(row("v"))).toBeNull();
    expect(calloutOf(row("v", { callout: " " }))).toBeNull();
    expect(calloutOf(row("v", { callout: "v" }))).toBeNull();
  });
});

describe("markerUrlFor", () => {
  const markers = new Set(["v", "s"]);

  test("a row with its own marker keeps it", () => {
    expect(markerUrlFor(row("s", { callout: "v" }), markers)).toBe("s");
  });

  test("a row without one borrows the marker its callout names", () => {
    expect(markerUrlFor(row("v~2", { callout: "v" }), markers)).toBe("v");
  });

  test("a callout that leads nowhere leaves the row without a marker", () => {
    expect(markerUrlFor(row("x", { callout: "gone" }), markers)).toBeNull();
    expect(markerUrlFor(row("x"), markers)).toBeNull();
  });
});

describe("nextCalloutRowUrl", () => {
  test("takes the first free ~n", () => {
    expect(nextCalloutRowUrl("v", new Set(["v"]))).toBe("v~2");
    expect(nextCalloutRowUrl("v", new Set(["v", "v~2", "v~3"]))).toBe("v~4");
  });
});

describe("groupCalloutRows", () => {
  const urls = (rows: { url: string }[]) => rows.map((r) => r.url);

  test("a row added later moves up under its callout, after the ones already there", () => {
    const rows = [row("a"), row("a~2", { callout: "a" }), row("b"), row("c"), row("a~3", { callout: "a" })];
    expect(urls(groupCalloutRows(rows))).toEqual(["a", "a~2", "a~3", "b", "c"]);
  });

  test("a callout to a row not in the list keeps the row where it is", () => {
    expect(urls(groupCalloutRows([row("x", { callout: "gone" }), row("b")]))).toEqual(["x", "b"]);
  });

  test("a loop of callouts loses no row", () => {
    expect(urls(groupCalloutRows([row("p", { callout: "q" }), row("q", { callout: "p" }), row("r")])).sort()).toEqual(["p", "q", "r"]);
  });
});

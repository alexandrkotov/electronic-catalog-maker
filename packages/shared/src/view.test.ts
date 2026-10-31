import { describe, expect, test } from "bun:test";
import { fitScale, normalizeRegion, normalizeView, parseViewGeometry, placeView, readView, setViewGeometryParams, viewKey } from "./view.js";

const image = { w: 2000, h: 1000 };
const box = { w: 1000, h: 600 };

describe("normalizeView", () => {
  test("keeps a valid view and fills in v", () => {
    expect(normalizeView({ v: 1, imageId: 3, linkId: 9, zoom: 2, cx: 0.25, cy: 0.5, region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } })).toEqual({
      v: 1,
      imageId: 3,
      linkId: 9,
      zoom: 2,
      cx: 0.25,
      cy: 0.5,
      region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
    });
  });

  test("needs an integer imageId", () => {
    expect(normalizeView(null)).toBeNull();
    expect(normalizeView({ v: 1 })).toBeNull();
    expect(normalizeView({ v: 1, imageId: 1.5 })).toBeNull();
    expect(normalizeView({ v: 1, imageId: "3" })).toBeNull();
  });

  test("clamps fractions and zoom, drops junk", () => {
    const v = normalizeView({ v: 1, imageId: 1, zoom: 0.2, cx: 7, cy: -1, linkId: "x", region: { x: 0.5, y: 0.5, w: 0.8, h: 0 } });
    expect(v).toEqual({ v: 1, imageId: 1, zoom: 1, cx: 1, cy: 0 });
  });
});

describe("normalizeRegion", () => {
  test("clips a rectangle that sticks out of the image", () => {
    expect(normalizeRegion({ x: 0.8, y: 0.9, w: 0.5, h: 0.5 })).toEqual({ x: 0.8, y: 0.9, w: 0.2, h: 0.1 });
  });
  test("rejects an empty or non-numeric one", () => {
    expect(normalizeRegion({ x: 0.2, y: 0.2, w: 0, h: 0.1 })).toBeUndefined();
    expect(normalizeRegion({ x: NaN, y: 0, w: 1, h: 1 })).toBeUndefined();
    expect(normalizeRegion(undefined)).toBeUndefined();
  });
});

describe("address-bar parameters", () => {
  test("round trip", () => {
    const params = new URLSearchParams("image=2&link=5");
    setViewGeometryParams(params, { zoom: 2.5, cx: 0.123456, cy: 0.5, region: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } });
    expect(params.get("image")).toBe("2");
    expect(params.get("zoom")).toBe("2.5");
    expect(params.get("cx")).toBe("0.1235");
    expect(params.get("rect")).toBe("0.1,0.2,0.3,0.4");
    expect(parseViewGeometry(params)).toEqual({ zoom: 2.5, cx: 0.1235, cy: 0.5, region: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } });
  });

  test("an old link without the new parameters gives an empty geometry", () => {
    expect(parseViewGeometry(new URLSearchParams("src=a.ecatm&image=2&link=5"))).toEqual({});
  });

  test("malformed values are ignored", () => {
    expect(parseViewGeometry(new URLSearchParams("zoom=abc&cx=&rect=1,2,3"))).toEqual({});
    expect(parseViewGeometry(new URLSearchParams("rect=0.1,0.1,0,0.3"))).toEqual({});
  });

  test("writing replaces old values and leaves absent ones out", () => {
    const params = new URLSearchParams("zoom=3&cx=0.1&cy=0.1&rect=0,0,1,1");
    setViewGeometryParams(params, { zoom: 1 });
    expect(params.toString()).toBe("zoom=1");
  });
});

describe("fitScale", () => {
  test("fits the tighter axis with a margin, never above 100%", () => {
    expect(fitScale(image, box)).toBeCloseTo((1000 - 28) / 2000, 6);
    expect(fitScale({ w: 100, h: 100 }, box)).toBe(1);
  });
  test("null while nothing has a size", () => {
    expect(fitScale(image, { w: 0, h: 0 })).toBeNull();
    expect(fitScale({ w: 0, h: 10 }, box)).toBeNull();
  });
});

describe("placeView", () => {
  const fit = fitScale(image, box)!;

  test("zoom 1 is the fitted whole image", () => {
    expect(placeView({ zoom: 1 }, image, box)).toEqual({ scale: fit, fitted: true, scrollLeft: 0, scrollTop: 0 });
    expect(placeView({}, image, box)?.fitted).toBe(true);
  });

  test("zoom is relative to the fitted scale and cx/cy land in the middle of the window", () => {
    const p = placeView({ zoom: 2, cx: 0.5, cy: 0.5 }, image, box)!;
    expect(p.scale).toBeCloseTo(fit * 2, 6);
    expect(p.fitted).toBe(false);
    // The middle of the scaled image minus half the window.
    expect(p.scrollLeft).toBeCloseTo(0.5 * 2000 * fit * 2 - 500, 4);
    expect(p.scrollTop).toBe(Math.max(0, 0.5 * 1000 * fit * 2 - 300));
  });

  test("a region without a zoom is fitted into the window and centered", () => {
    const region = { x: 0.4, y: 0.4, w: 0.1, h: 0.2 };
    const p = placeView({ region }, image, box)!;
    const w = region.w * image.w * p.scale;
    const h = region.h * image.h * p.scale;
    expect(p.fitted).toBe(false);
    // Fits with the margin and touches it on the tighter axis.
    expect(w).toBeLessThanOrEqual(box.w - 48 + 1e-6);
    expect(h).toBeLessThanOrEqual(box.h - 48 + 1e-6);
    expect(Math.max(w / (box.w - 48), h / (box.h - 48))).toBeCloseTo(1, 6);
    // Its center is the window's center.
    expect(p.scrollLeft + box.w / 2).toBeCloseTo(0.45 * image.w * p.scale, 4);
    expect(p.scrollTop + box.h / 2).toBeCloseTo(0.5 * image.h * p.scale, 4);
  });

  test("the same region on a phone-sized window gives a smaller scale", () => {
    const region = { x: 0.4, y: 0.4, w: 0.1, h: 0.2 };
    const desktop = placeView({ region }, image, box)!;
    const phone = placeView({ region }, image, { w: 360, h: 500 })!;
    expect(phone.scale).toBeLessThan(desktop.scale);
  });

  test("a region bigger than the window stays fitted", () => {
    expect(placeView({ region: { x: 0, y: 0, w: 1, h: 1 } }, image, box)?.fitted).toBe(true);
  });

  test("a region is centered when a zoom is given without cx/cy", () => {
    const region = { x: 0.45, y: 0.45, w: 0.1, h: 0.1 };
    const p = placeView({ zoom: 3, region }, image, box)!;
    expect(p.scrollLeft + box.w / 2).toBeCloseTo(0.5 * image.w * p.scale, 4);
  });

  test("never zooms beyond 400%", () => {
    expect(placeView({ region: { x: 0.5, y: 0.5, w: 0.001, h: 0.001 } }, image, box)!.scale).toBe(4);
  });

  test("null before the window has a size", () => {
    expect(placeView({ zoom: 2 }, image, { w: 0, h: 0 })).toBeNull();
  });
});

describe("readView", () => {
  test("is the inverse of placeView", () => {
    const placed = placeView({ zoom: 3, cx: 0.3, cy: 0.7 }, image, box)!;
    const back = readView({ left: placed.scrollLeft, top: placed.scrollTop }, placed.scale, image, box)!;
    expect(back.zoom).toBeCloseTo(3, 3);
    expect(back.cx).toBeCloseTo(0.3, 3);
    expect(back.cy).toBeCloseTo(0.7, 3);
  });

  test("the view survives a window of another size", () => {
    const phone = { w: 360, h: 640 };
    const a = placeView({ zoom: 10, cx: 0.8, cy: 0.4 }, image, phone)!;
    const back = readView({ left: a.scrollLeft, top: a.scrollTop }, a.scale, image, phone)!;
    expect(back.cx).toBeCloseTo(0.8, 3);
    expect(back.cy).toBeCloseTo(0.4, 3);
  });

  test("a center the window cannot reach (near an edge) is pulled in, not lost", () => {
    const a = placeView({ zoom: 3, cx: 0, cy: 0 }, image, box)!;
    expect(a.scrollLeft).toBe(0);
    const back = readView({ left: a.scrollLeft, top: a.scrollTop }, a.scale, image, box)!;
    expect(back.cx).toBeGreaterThan(0);
  });

  test("at or below the fitted scale only zoom 1 is reported", () => {
    const fit = fitScale(image, box)!;
    expect(readView({ left: 0, top: 0 }, fit, image, box)).toEqual({ zoom: 1 });
    expect(readView({ left: 0, top: 0 }, fit / 2, image, box)).toEqual({ zoom: 1 });
  });

  test("an axis the image does not fill reports its middle", () => {
    // Zoomed to 120% of fit: the image is 2000*fit*1.2 wide (wider than the window) but only ~0.6 of the window tall.
    const fit = fitScale(image, box)!;
    const scale = fit * 1.2;
    const back = readView({ left: 100, top: 0 }, scale, image, box)!;
    expect(image.h * scale).toBeLessThan(box.h);
    expect(back.cy).toBe(0.5);
  });
});

describe("viewKey", () => {
  test("equal views have equal keys, different ones do not", () => {
    expect(viewKey({ v: 1, imageId: 1, zoom: 2 })).toBe(viewKey({ v: 1, imageId: 1, zoom: 2 }));
    expect(viewKey({ v: 1, imageId: 1, zoom: 2 })).not.toBe(viewKey({ v: 1, imageId: 1, zoom: 2.5 }));
    expect(viewKey({ v: 1, imageId: 1 })).not.toBe(viewKey({ v: 1, imageId: 1, region: { x: 0, y: 0, w: 1, h: 1 } }));
  });
});

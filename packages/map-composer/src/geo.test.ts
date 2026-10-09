import { describe, expect, test } from "bun:test";
import {
  fileStem,
  fitWithin,
  homeMarker,
  isInside,
  labelFontSize,
  mapMeta,
  mapPixelRatio,
  pointGeo,
  pointLabel,
  previewFontSize,
  toImagePixels,
} from "./geo.js";

describe("toImagePixels", () => {
  test("scales by the canvas-to-container ratio, whatever it is", () => {
    const pos = { x: 300, y: 150 };
    const container = { width: 900, height: 600 };
    expect(toImagePixels(pos, container, { width: 1800, height: 1200 })).toEqual({ left: 600, top: 300 });
    expect(toImagePixels(pos, container, { width: 900, height: 600 })).toEqual({ left: 300, top: 150 });
    expect(toImagePixels(pos, container, { width: 2700, height: 1800 })).toEqual({ left: 900, top: 450 });
  });

  test("corners map to corners", () => {
    const container = { width: 721, height: 481 };
    const image = { width: 1442, height: 962 };
    expect(toImagePixels({ x: 0, y: 0 }, container, image)).toEqual({ left: 0, top: 0 });
    expect(toImagePixels({ x: 721, y: 481 }, container, image)).toEqual({ left: 1442, top: 962 });
  });
});

test("isInside", () => {
  const c = { width: 100, height: 50 };
  expect(isInside({ x: 0, y: 50 }, c)).toBe(true);
  expect(isInside({ x: 100.5, y: 10 }, c)).toBe(false);
  expect(isInside({ x: 10, y: -1 }, c)).toBe(false);
});

describe("homeMarker", () => {
  test("the Shop the look demo's own numbers at its size", () => {
    expect(homeMarker({ width: 1536, height: 1024 })).toEqual({ left: 80, top: 80, fontSize: 60 });
  });

  test("scales with the shorter side", () => {
    expect(homeMarker({ width: 2000, height: 1500 })).toEqual({ left: 117, top: 117, fontSize: 88 });
    expect(homeMarker({ width: 600, height: 800 })).toEqual({ left: 47, top: 47, fontSize: 35 });
  });
});

test("fitWithin keeps small photos and scales big ones by the longer side", () => {
  expect(fitWithin({ width: 800, height: 600 }, 2000)).toEqual({ width: 800, height: 600 });
  expect(fitWithin({ width: 4000, height: 3000 }, 2000)).toEqual({ width: 2000, height: 1500 });
  expect(fitWithin({ width: 3000, height: 4000 }, 2000)).toEqual({ width: 1500, height: 2000 });
});

test("pointLabel", () => {
  const p = { id: 7, name: " Anna Nails ", lng: 0, lat: 0 };
  expect(pointLabel(p, 3, "name")).toBe("Anna Nails");
  expect(pointLabel(p, 3, "number")).toBe("3");
  expect(pointLabel({ ...p, name: "  " }, 3, "name")).toBe("3");
});

test("labelFontSize", () => {
  expect(labelFontSize(1536, "medium")).toBe(22);
  expect(labelFontSize(1536, "small")).toBe(17);
  expect(labelFontSize(1536, "large")).toBe(30);
  expect(labelFontSize(300, "small")).toBe(10);
});

test("mapMeta and pointGeo round to what a map can show", () => {
  const meta = mapMeta({
    style: "liberty",
    west: -122.71234567,
    south: 45.6,
    east: -122.6,
    north: 45.70000004,
    centerLng: -122.65617283,
    centerLat: 45.65,
    zoom: 13.4567,
    image: { width: 1800, height: 1200 },
  });
  expect(meta.bbox).toEqual([-122.712346, 45.6, -122.6, 45.7]);
  expect(meta.center).toEqual([-122.656173, 45.65]);
  expect(meta.zoom).toBe(13.46);
  expect(meta.imageSize).toEqual([1800, 1200]);
  expect(meta.source).toBe("osm");
  expect(meta.attribution).toContain("© OpenStreetMap contributors");
  expect(pointGeo({ id: 1, name: "", lng: -111.89100049, lat: 40.76080011 })).toEqual({ lat: 40.7608, lng: -111.891 });
});

test("fileStem", () => {
  expect(fileStem('Nail techs: "Downtown"')).toBe("Nail techs   Downtown");
  expect(fileStem("  ")).toBe("catalog");
});

test("mapPixelRatio aims at the same picture width on any screen", () => {
  expect(mapPixelRatio(892)).toBe(2);
  expect(mapPixelRatio(1200)).toBe(2);
  expect(mapPixelRatio(558)).toBe(3.2);
  expect(mapPixelRatio(322)).toBe(4);
  expect(mapPixelRatio(0)).toBe(2);
});

test("previewFontSize follows the viewer's counter-scaling", () => {
  expect(previewFontSize(26, 892, 1784)).toBeCloseTo(23.4); // shrunk 2x, scaled back 1.8x
  expect(previewFontSize(26, 1784, 1784)).toBe(26);
  expect(previewFontSize(26, 1200, 1784)).toBeCloseTo(26); // 1/zoom under 1.8: fully compensated
});

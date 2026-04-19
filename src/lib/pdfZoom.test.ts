import { describe, expect, test } from "vitest";
import {
  ZOOM_MIN,
  ZOOM_MAX,
  ZOOM_STEP,
  clampZoom,
  nextZoom,
  prevZoom,
  computePageHeights,
} from "./pdfZoom";

describe("clampZoom", () => {
  test("returns 1.0 when input is not finite", () => {
    expect(clampZoom(NaN)).toBe(1.0);
    expect(clampZoom(Infinity)).toBe(1.0);
    expect(clampZoom(undefined as unknown as number)).toBe(1.0);
  });
  test("clamps below min", () => {
    expect(clampZoom(0.1)).toBe(ZOOM_MIN);
  });
  test("clamps above max", () => {
    expect(clampZoom(10)).toBe(ZOOM_MAX);
  });
  test("passes through valid values", () => {
    expect(clampZoom(1.25)).toBe(1.25);
  });
});

describe("nextZoom / prevZoom", () => {
  test("nextZoom advances by step", () => {
    expect(nextZoom(1.0)).toBeCloseTo(1.0 + ZOOM_STEP);
  });
  test("nextZoom caps at max", () => {
    expect(nextZoom(ZOOM_MAX)).toBe(ZOOM_MAX);
    expect(nextZoom(ZOOM_MAX - ZOOM_STEP / 2)).toBe(ZOOM_MAX);
  });
  test("prevZoom retreats by step", () => {
    expect(prevZoom(1.0)).toBeCloseTo(1.0 - ZOOM_STEP);
  });
  test("prevZoom caps at min", () => {
    expect(prevZoom(ZOOM_MIN)).toBe(ZOOM_MIN);
  });
  test("rounding: sequence of +step lands on clean values", () => {
    let z = 1.0;
    for (let i = 0; i < 20; i++) z = nextZoom(z);
    expect(Math.round(z * 100)).toBe(200);
  });
});

describe("computePageHeights", () => {
  const infos = [
    { width: 612, height: 792 },
    { width: 595, height: 842 },
  ];

  test("returns empty when container width is 0", () => {
    expect(computePageHeights(infos, 0, 1.0)).toEqual([]);
  });

  test("at zoom 1.0, heights are fit-to-width", () => {
    const heights = computePageHeights(infos, 600, 1.0);
    expect(heights[0]).toBeCloseTo(792 * (600 / 612));
    expect(heights[1]).toBeCloseTo(842 * (600 / 595));
  });

  test("zoom 2.0 doubles heights linearly", () => {
    const h1 = computePageHeights(infos, 600, 1.0);
    const h2 = computePageHeights(infos, 600, 2.0);
    expect(h2[0]).toBeCloseTo(h1[0] * 2);
    expect(h2[1]).toBeCloseTo(h1[1] * 2);
  });
});

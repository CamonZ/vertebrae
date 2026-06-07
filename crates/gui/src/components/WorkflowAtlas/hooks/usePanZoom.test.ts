import { describe, expect, it } from "vitest";
import { clamp, fitTransform, zoomAt } from "./usePanZoom";

describe("clamp", () => {
  it("returns the value when within range", () => {
    expect(clamp(0.5, 0.15, 2.4)).toBe(0.5);
  });

  it("clamps below the lower bound", () => {
    expect(clamp(-3, 0.15, 2.4)).toBe(0.15);
  });

  it("clamps above the upper bound", () => {
    expect(clamp(99, 0.15, 2.4)).toBe(2.4);
  });

  it("returns the bound when equal", () => {
    expect(clamp(0.15, 0.15, 2.4)).toBe(0.15);
    expect(clamp(2.4, 0.15, 2.4)).toBe(2.4);
  });
});

describe("fitTransform", () => {
  it("scales content to fit and centers it", () => {
    // Container 1000x1000, content 800x800, pad 96.
    // limiting scale = (1000 - 96) / 800 = 1.13 on both axes.
    const t = fitTransform(1000, 1000, { w: 800, h: 800 }, 0.15, 2.4, 96);
    expect(t).not.toBeNull();
    expect(t!.s).toBeCloseTo(1.13, 5);
    // Centered: (cw - w*s)/2 on both axes.
    const expected = (1000 - 800 * 1.13) / 2;
    expect(t!.x).toBeCloseTo(expected, 5);
    expect(t!.y).toBeCloseTo(expected, 5);
  });

  it("uses the tighter axis when content is non-square", () => {
    // wide container, tall content -> height is the constraint.
    const t = fitTransform(2000, 600, { w: 400, h: 800 }, 0.15, 2.4, 100);
    expect(t).not.toBeNull();
    // height: (600 - 100)/800 = 0.625 ; width: (2000-100)/400 = 4.75 -> min 0.625
    expect(t!.s).toBeCloseTo(0.625, 5);
  });

  it("clamps the fit scale to max", () => {
    // Tiny content in a huge container would scale way past max.
    const t = fitTransform(1000, 1000, { w: 10, h: 10 }, 0.15, 2.4, 96);
    expect(t).not.toBeNull();
    expect(t!.s).toBe(2.4);
  });

  it("clamps the fit scale to min", () => {
    // Huge content in a small container would scale below min.
    const t = fitTransform(200, 200, { w: 100000, h: 100000 }, 0.15, 2.4, 96);
    expect(t).not.toBeNull();
    expect(t!.s).toBe(0.15);
  });

  it("returns null when the container is not yet sized", () => {
    expect(fitTransform(0, 0, { w: 800, h: 800 }, 0.15, 2.4, 96)).toBeNull();
    expect(fitTransform(1, 500, { w: 800, h: 800 }, 0.15, 2.4, 96)).toBeNull();
    expect(fitTransform(500, 1, { w: 800, h: 800 }, 0.15, 2.4, 96)).toBeNull();
  });

  it("returns null for empty content", () => {
    expect(fitTransform(1000, 1000, { w: 0, h: 0 }, 0.15, 2.4, 96)).toBeNull();
    expect(fitTransform(1000, 1000, { w: -5, h: 100 }, 0.15, 2.4, 96)).toBeNull();
  });

  it("produces no NaN for valid inputs", () => {
    const t = fitTransform(1280, 720, { w: 1500, h: 900 }, 0.15, 2.4, 96);
    expect(t).not.toBeNull();
    expect(Number.isNaN(t!.s)).toBe(false);
    expect(Number.isNaN(t!.x)).toBe(false);
    expect(Number.isNaN(t!.y)).toBe(false);
  });
});

describe("zoomAt", () => {
  it("keeps the anchor point fixed in screen space", () => {
    const prev = { s: 1, x: 0, y: 0 };
    const px = 300;
    const py = 200;
    const next = zoomAt(prev, 1.5, px, py, 0.15, 2.4);
    // World point under the cursor before and after zoom must coincide.
    const worldBeforeX = (px - prev.x) / prev.s;
    const worldAfterX = (px - next.x) / next.s;
    expect(worldAfterX).toBeCloseTo(worldBeforeX, 10);
    const worldBeforeY = (py - prev.y) / prev.s;
    const worldAfterY = (py - next.y) / next.s;
    expect(worldAfterY).toBeCloseTo(worldBeforeY, 10);
  });

  it("applies the zoom factor to scale", () => {
    const next = zoomAt({ s: 1, x: 0, y: 0 }, 1.18, 100, 100, 0.15, 2.4);
    expect(next.s).toBeCloseTo(1.18, 10);
  });

  it("clamps scale to max without translating past the anchor", () => {
    const next = zoomAt({ s: 2.3, x: 10, y: 20 }, 4, 100, 100, 0.15, 2.4);
    expect(next.s).toBe(2.4);
    // Anchor still fixed even when clamped.
    const worldBefore = (100 - 10) / 2.3;
    const worldAfter = (100 - next.x) / next.s;
    expect(worldAfter).toBeCloseTo(worldBefore, 10);
  });

  it("clamps scale to min", () => {
    const next = zoomAt({ s: 0.16, x: 0, y: 0 }, 0.1, 100, 100, 0.15, 2.4);
    expect(next.s).toBe(0.15);
  });

  it("is a no-op on scale when already clamped at max", () => {
    const next = zoomAt({ s: 2.4, x: 5, y: 5 }, 2, 50, 50, 0.15, 2.4);
    expect(next.s).toBe(2.4);
  });
});

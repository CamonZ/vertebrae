import { describe, expect, it } from "vitest";
import { RAIL_RADIUS, pointAt, railBetween, route, routePath } from "./route";

describe("route", () => {
  it("measures a straight rail by arc length", () => {
    const r = route([
      [0, 0],
      [100, 0],
    ]);
    expect(r.length).toBe(100);
    expect(pointAt(r, 0)).toEqual([0, 0]);
    expect(pointAt(r, 0.25)).toEqual([25, 0]);
    expect(pointAt(r, 1)).toEqual([100, 0]);
  });

  it("rounds corners with radius 22 and stays shorter than the sharp path", () => {
    expect(RAIL_RADIUS).toBe(22);
    const r = route([
      [0, 0],
      [100, 0],
      [100, 100],
    ]);
    expect(r.length).toBeLessThan(200);
    expect(r.length).toBeGreaterThan(200 - 2 * 22 + 2 * 22 * (Math.PI / 4) - 1);
    // the corner point itself is cut off
    expect(r.points.some(([x, y]) => x === 100 && y === 0)).toBe(false);
    // every sample stays within the corner's radius box
    for (const [x, y] of r.points) {
      if (x > 78 && y < 22)
        expect(Math.hypot(100 - x, y)).toBeLessThanOrEqual(22 + 1e-9);
    }
  });

  it("limits the radius on short segments", () => {
    const r = route([
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
    expect(r.points[1]).toEqual([5, 0]);
  });

  it("samples by arc length across corners", () => {
    const r = route([
      [0, 0],
      [100, 0],
      [100, 100],
    ]);
    const mid = pointAt(r, 0.5);
    const [x, y] = mid;
    expect(Math.hypot(100 - x, y)).toBeLessThan(22);
  });

  it("overshoots past the end along the last segment, capped at 160 px", () => {
    const r = route([
      [0, 0],
      [0, 100],
    ]);
    const [x, y] = pointAt(r, 1.1);
    expect(x).toBe(0);
    expect(y).toBeCloseTo(110, 9);
    expect(pointAt(r, 10)).toEqual([0, 260]);
  });

  it("holds a zero-length stay route at its point", () => {
    const r = route([
      [5, 5],
      [5, 5],
    ]);
    expect(pointAt(r, 1.2)).toEqual([5, 5]);
  });

  it("formats path data deterministically", () => {
    expect(
      routePath(
        route([
          [0, 0],
          [10.004, -0.001],
        ])
      )
    ).toBe("M0 0 L10 0");
  });

  it("rejects an empty route", () => {
    expect(() => route([])).toThrow();
  });
});

describe("railBetween", () => {
  it("connects aligned ports directly", () => {
    expect(
      railBetween({ x: 0, y: 200, side: "E" }, { x: 300, y: 200, side: "W" })
    ).toEqual([
      [0, 200],
      [300, 200],
    ]);
  });

  it("uses a midpoint elbow pair between east and west ports", () => {
    expect(
      railBetween({ x: 0, y: 100, side: "E" }, { x: 200, y: 300, side: "W" })
    ).toEqual([
      [0, 100],
      [100, 100],
      [100, 300],
      [200, 300],
    ]);
  });

  it("uses one elbow from a horizontal to a vertical port", () => {
    expect(
      railBetween({ x: 0, y: 100, side: "E" }, { x: 200, y: 300, side: "N" })
    ).toEqual([
      [0, 100],
      [200, 100],
      [200, 300],
    ]);
    expect(
      railBetween({ x: 0, y: 100, side: "S" }, { x: 200, y: 300, side: "W" })
    ).toEqual([
      [0, 100],
      [0, 300],
      [200, 300],
    ]);
  });

  it("uses a midpoint elbow pair between vertical ports", () => {
    expect(
      railBetween({ x: 0, y: 0, side: "S" }, { x: 100, y: 200, side: "N" })
    ).toEqual([
      [0, 0],
      [0, 100],
      [100, 100],
      [100, 200],
    ]);
  });
});

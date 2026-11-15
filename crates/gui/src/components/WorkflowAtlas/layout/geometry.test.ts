import { describe, expect, it } from "vitest";
import type { Rect } from "./types";
import { rayBox, roundedPath, splitRef } from "./geometry";

const BOX: Rect = { x: 100, y: 100, w: 200, h: 80 };

describe("splitRef", () => {
  it("splits on the first dot", () => {
    expect(splitRef("wf-1.step-a")).toEqual(["wf-1", "step-a"]);
  });
  it("keeps later dots in the step id", () => {
    expect(splitRef("wf.step.with.dots")).toEqual(["wf", "step.with.dots"]);
  });
});

describe("roundedPath", () => {
  it("returns empty for fewer than 2 points", () => {
    expect(roundedPath([], 6)).toBe("");
    expect(roundedPath([{ x: 1, y: 2 }], 6)).toBe("");
  });
  it("draws a straight line for exactly 2 points (no corners)", () => {
    expect(roundedPath([{ x: 0, y: 0 }, { x: 10, y: 0 }], 6)).toBe(
      "M0,0 L10,0",
    );
  });
  it("rounds an interior corner with a quadratic", () => {
    const d = roundedPath(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
      ],
      10,
    );
    expect(d).toContain("Q100,0");
    expect(d).not.toContain("NaN");
  });
  it("clamps radius to half the shorter adjacent leg", () => {
    // legs of length 4: radius clamps to 2 around the corner
    const d = roundedPath(
      [
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 4, y: 4 },
      ],
      10,
    );
    expect(d).toContain("L2,0");
    expect(d).toContain("Q4,0 4,2");
    expect(d).not.toContain("NaN");
  });
});

describe("rayBox", () => {
  it("hits the right border for a rightward ray from centre", () => {
    const c = { x: BOX.x + BOX.w / 2, y: BOX.y + BOX.h / 2 };
    const p = rayBox(c.x, c.y, 1000, c.y, BOX);
    expect(p.x).toBeCloseTo(BOX.x + BOX.w);
    expect(p.y).toBeCloseTo(c.y);
  });
  it("hits the top border for an upward ray", () => {
    const c = { x: BOX.x + BOX.w / 2, y: BOX.y + BOX.h / 2 };
    const p = rayBox(c.x, c.y, c.x, -1000, BOX);
    expect(p.y).toBeCloseTo(BOX.y);
    expect(p.x).toBeCloseTo(c.x);
  });
  it("never returns NaN even for a zero-length ray", () => {
    const c = { x: BOX.x, y: BOX.y };
    const p = rayBox(c.x, c.y, c.x, c.y, BOX);
    expect(Number.isNaN(p.x)).toBe(false);
    expect(Number.isNaN(p.y)).toBe(false);
  });
});

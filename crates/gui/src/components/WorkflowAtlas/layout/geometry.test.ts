import { describe, expect, it } from "vitest";
import type { Point, Rect } from "./types";
import {
  anchorEdge,
  borderAnchor,
  edgePoints,
  rayBox,
  roundedPath,
  shortId,
  splitRef,
} from "./geometry";

const BOX: Rect = { x: 100, y: 100, w: 200, h: 80 };

/** Assert no coordinate in a point list (or path d-string) is NaN. */
function noNaNPoints(pts: Point[]): void {
  for (const p of pts) {
    expect(Number.isNaN(p.x)).toBe(false);
    expect(Number.isNaN(p.y)).toBe(false);
  }
}

describe("splitRef", () => {
  it("splits on the first dot", () => {
    expect(splitRef("wf-1.step-a")).toEqual(["wf-1", "step-a"]);
  });
  it("keeps later dots in the step id", () => {
    expect(splitRef("wf.step.with.dots")).toEqual(["wf", "step.with.dots"]);
  });
});

describe("shortId", () => {
  it("is deterministic and 8 hex chars", () => {
    const a = shortId("workflow-abc");
    const b = shortId("workflow-abc");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });
  it("distinguishes different inputs", () => {
    expect(shortId("alpha")).not.toBe(shortId("beta"));
  });
  it("pads short hashes to 8 chars", () => {
    // empty string hashes to 0 → "00000000"
    expect(shortId("")).toBe("00000000");
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

describe("borderAnchor", () => {
  it("snaps to the top face for a vertical approach from above", () => {
    const nb = { x: BOX.x + 50, y: BOX.y - 40 };
    const p = borderAnchor(BOX, nb);
    expect(p.y).toBe(BOX.y);
    expect(p.x).toBe(nb.x);
  });
  it("snaps to the left face for a horizontal approach from the left", () => {
    const nb = { x: BOX.x - 50, y: BOX.y + 40 };
    const p = borderAnchor(BOX, nb);
    expect(p.x).toBe(BOX.x);
    expect(p.y).toBe(nb.y);
  });
  it("trims to the border via rayBox for a diagonal approach", () => {
    const nb = { x: BOX.x - 100, y: BOX.y - 100 };
    const p = borderAnchor(BOX, nb);
    // should land on the box perimeter, no NaN
    expect(Number.isNaN(p.x)).toBe(false);
    expect(Number.isNaN(p.y)).toBe(false);
  });
});

describe("anchorEdge", () => {
  const A: Rect = { x: 0, y: 0, w: 100, h: 100 };
  const B: Rect = { x: 400, y: 0, w: 100, h: 100 };

  it("returns input unchanged when fewer than 2 points", () => {
    expect(anchorEdge([{ x: 1, y: 1 }], A, B)).toEqual([{ x: 1, y: 1 }]);
  });
  it("snaps both ends onto the source and target borders", () => {
    const pts: Point[] = [
      { x: 50, y: 50 }, // inside A (centre)
      { x: 250, y: 50 }, // between
      { x: 450, y: 50 }, // inside B (centre)
    ];
    const out = anchorEdge(pts, A, B);
    expect(out[0].x).toBe(A.x + A.w); // right face of A
    expect(out[out.length - 1].x).toBe(B.x); // left face of B
    noNaNPoints(out);
  });
});

describe("edgePoints", () => {
  it("returns [] for a missing section", () => {
    expect(edgePoints(undefined, 0, 0)).toEqual([]);
  });
  it("flattens start → bends → end and applies the offset", () => {
    const section = {
      id: "s",
      startPoint: { x: 0, y: 0 },
      bendPoints: [{ x: 5, y: 5 }],
      endPoint: { x: 10, y: 10 },
    };
    const out = edgePoints(section, 100, 200);
    expect(out).toEqual([
      { x: 100, y: 200 },
      { x: 105, y: 205 },
      { x: 110, y: 210 },
    ]);
  });
});

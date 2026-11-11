import { describe, expect, it } from "vitest";
import {
  CLAMP_SPRING,
  POP_SPRING,
  clamp,
  held,
  loopFade,
  pop,
  slide,
  smoothstep,
  spring,
  thrown,
  track,
  valueAt,
  windowed,
} from "./motion";

const peak = (f: (dt: number) => number, until = 2) => {
  let max = 0;
  for (let dt = 0; dt <= until; dt += 0.001) max = Math.max(max, f(dt));
  return max;
};

describe("spring", () => {
  it("starts at rest and settles on the target", () => {
    expect(spring(0, 260, 11)).toBe(0);
    expect(spring(-1, 260, 11)).toBe(0);
    expect(spring(5, 260, 11)).toBeCloseTo(1, 6);
  });

  it("handles critically and over-damped springs without oscillating", () => {
    for (const c of [2 * Math.sqrt(100), 40]) {
      let prev = 0;
      for (let dt = 0.01; dt < 2; dt += 0.01) {
        const v = spring(dt, 100, c);
        expect(v).toBeGreaterThanOrEqual(prev);
        expect(v).toBeLessThanOrEqual(1);
        prev = v;
      }
    }
  });

  it("uses the VL-06 constants for pop and clamp", () => {
    expect(POP_SPRING).toEqual({ k: 260, c: 11 });
    expect(CLAMP_SPRING).toEqual({ k: 420, c: 30 });
    expect(pop(0.3)).toBe(spring(0.3, 260, 11));
    expect(clamp(0.3)).toBe(spring(0.3, 420, 30));
  });

  it("pops with a visible overshoot and clamps nearly flat", () => {
    expect(peak(pop)).toBeGreaterThan(1.3);
    const clampPeak = peak(clamp);
    expect(clampPeak).toBeGreaterThan(1);
    expect(clampPeak).toBeLessThan(1.05);
  });
});

describe("thrown", () => {
  it("first reaches the target exactly at the leg duration, then overshoots", () => {
    for (const d of [0.35, 0.6, 0.7]) {
      expect(thrown(d, d)).toBeCloseTo(1, 9);
      expect(thrown(d * 0.9, d)).toBeLessThan(1);
      expect(thrown(d * 1.2, d)).toBeGreaterThan(1);
      expect(thrown(10, d)).toBeCloseTo(1, 6);
    }
  });

  it("is monotonic before arrival", () => {
    let prev = 0;
    for (let dt = 0.01; dt <= 0.6; dt += 0.01) {
      const v = thrown(dt, 0.6);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });

  it("slide is a 0.35 s throw", () => {
    expect(slide(0.35)).toBeCloseTo(1, 9);
  });
});

describe("smoothstep and windows", () => {
  it("clamps and eases between the edges", () => {
    expect(smoothstep(1, 2, 0)).toBe(0);
    expect(smoothstep(1, 2, 3)).toBe(1);
    expect(smoothstep(1, 2, 1.5)).toBe(0.5);
    expect(smoothstep(0, 1, 0.25)).toBeCloseTo(0.15625, 10);
  });

  it("windowed rises over 0.15 s and falls over 0.25 s", () => {
    expect(windowed(1, 1, 2)).toBe(0);
    expect(windowed(1.15, 1, 2)).toBe(1);
    expect(windowed(2, 1, 2)).toBe(1);
    expect(windowed(2.25, 1, 2)).toBe(0);
  });

  it("held engages at a and releases at b", () => {
    expect(held(0.9, 1, 2)).toBe(0);
    expect(held(1.8, 1, 2)).toBeCloseTo(1, 2);
    expect(held(3, 1, 2)).toBeCloseTo(0, 3);
    expect(held(5, 1, 2)).toBeGreaterThanOrEqual(0);
  });

  it("the last 0.6 s of a loop fades to idle", () => {
    expect(loopFade(4, 3.4)).toBe(1);
    expect(loopFade(4, 3.6)).toBeCloseTo(0.5, 9);
    expect(loopFade(4, 3.8)).toBe(0);
  });
});

describe("track and valueAt", () => {
  const list = [
    [0, 10],
    [1, 20],
    [2, 0],
  ] as const;

  it("holds the first value and springs between later entries", () => {
    expect(track(list, 0.5, slide)).toBe(10);
    expect(track(list, 1, slide)).toBe(10);
    expect(track(list, 1.35, slide)).toBeCloseTo(20, 6);
    expect(track(list, 9, slide)).toBeCloseTo(0, 6);
  });

  it("valueAt picks the latest entry at or before t", () => {
    expect(valueAt(list, -1)).toBe(10);
    expect(valueAt(list, 1)).toBe(20);
    expect(valueAt(list, 1.99)).toBe(20);
    expect(valueAt(list, 2)).toBe(0);
  });
});

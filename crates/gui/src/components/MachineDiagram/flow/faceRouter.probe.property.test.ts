/**
 * Property test of the face router's windowed parallel-segment probe
 * (`parallelProbe`). The router asks, for every grid step it prices, whether
 * a drawn rail runs beside the step within a distance band; the probe answers
 * from per-orientation lists sorted by line coordinate, scanning only the
 * lines within `reach`. It must answer exactly as a scan of every drawn
 * segment does, for any segments, step and band the router can ask about —
 * including segments a hair off orthogonal, distances on the band's edges and
 * lines just outside the window.
 */
import { test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { Point } from "../route";
import { parallelProbe } from "./faceRouter";

const SNAP = 0.5;
const CLEAR = 0.6;

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/** The scan the probe replaced: every drawn segment, every query. */
function bruteForce(
  drawn: readonly (readonly [Point, Point])[],
  a: Point,
  b: Point,
  lo: number,
  hi: number,
  open: boolean
): boolean {
  const horizontal = Math.abs(a[1] - b[1]) < SNAP;
  const k = horizontal ? 1 : 0;
  const j = 1 - k;
  const m = (a[k] + b[k]) / 2;
  return drawn.some(([p, q]) => {
    if (Math.abs(p[k] - q[k]) >= SNAP) return false;
    const d = Math.abs(p[k] - m);
    if (d < lo || (open ? d >= hi : d > hi)) return false;
    return (
      Math.min(p[j], q[j]) < Math.max(a[j], b[j]) &&
      Math.min(a[j], b[j]) < Math.max(p[j], q[j])
    );
  });
}

/** Grid coordinates with small offsets, so distances land on band edges. */
const coordinate = gs.composite<number>((tc) => {
  const cell = tc.draw(gs.integers({ minValue: 0, maxValue: 24 })) * 6;
  const nudge = tc.draw(
    gs.oneOf(
      gs.just(0),
      gs.sampledFrom([-SNAP, SNAP, -CLEAR, CLEAR, 0.01, -0.01, 0.49, -0.49]),
      gs.floats({ minValue: -1, maxValue: 1 })
    )
  );
  return cell + nudge;
});

/** A drawn segment: mostly orthogonal, sometimes a hair (or more) off. */
const segment = gs.composite<readonly [Point, Point]>((tc) => {
  const x = tc.draw(coordinate);
  const y = tc.draw(coordinate);
  const length = tc.draw(gs.integers({ minValue: 1, maxValue: 60 }));
  const skew = tc.draw(
    gs.oneOf(gs.just(0), gs.floats({ minValue: -1.2, maxValue: 1.2 }))
  );
  return tc.draw(gs.booleans())
    ? [
        [x, y],
        [x + length, y + skew],
      ]
    : [
        [x, y],
        [x + skew, y + length],
      ];
});

/** A grid step: one axis-aligned move between neighbouring grid lines. */
const step = gs.composite<readonly [Point, Point]>((tc) => {
  const a: Point = [tc.draw(coordinate), tc.draw(coordinate)];
  const length = tc.draw(gs.floats({ minValue: 0.5, maxValue: 40 }));
  const b: Point = tc.draw(gs.booleans())
    ? [a[0] + length, a[1]]
    : [a[0], a[1] + length];
  return tc.draw(gs.booleans()) ? [a, b] : [b, a];
});

test("the windowed probe finds a parallel rail exactly when a full scan does", () =>
  hegel.test(
    (tc) => {
      const drawn = tc.draw(gs.arrays(segment, { maxSize: 40 }));
      const gap = tc.draw(gs.floats({ minValue: 2, maxValue: 48 }));
      const probe = parallelProbe(drawn, Math.max(CLEAR, gap));
      // The two bands the router prices: "the same line" and "near".
      const bands: [number, number, boolean][] = [
        [0.01, CLEAR, true],
        [SNAP, gap - SNAP, false],
      ];
      const steps = tc.draw(gs.arrays(step, { minSize: 1, maxSize: 12 }));
      for (const [a, b] of steps)
        for (const [lo, hi, open] of bands) {
          const want = bruteForce(drawn, a, b, lo, hi, open);
          check(
            probe(a, b, lo, hi, open) === want,
            `step ${JSON.stringify([a, b])} band [${lo}, ${hi}${open ? ")" : "]"}: probe disagrees with the full scan (want ${want})`
          );
        }
    },
    { testCases: 400 }
  ));

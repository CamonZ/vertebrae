import { expect, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import {
  planReturnLanes,
  preferredChannel,
  type ReturnSpan,
} from "./lanePlanner";

/** Count intersections of abstract U routes directly, independent of interval colouring. */
function intersections(
  spans: readonly ReturnSpan[],
  lanes: readonly number[]
): number {
  let count = 0;
  for (let i = 0; i < spans.length; i++)
    for (let j = 0; j < i; j++) {
      for (const [h, v] of [
        [i, j],
        [j, i],
      ]) {
        if (
          lanes[h] * lanes[v] <= 0 ||
          Math.abs(lanes[h]) >= Math.abs(lanes[v])
        )
          continue;
        for (const x of [spans[v].x0, spans[v].x1])
          if (spans[h].x0 < x && x < spans[h].x1) count++;
      }
    }
  return count;
}

/** Exhaustive channel and lane-order oracle, stopping at the proven lower bound zero. */
function minimum(spans: readonly ReturnSpan[]): number {
  let best = Infinity;
  const order: number[] = [];
  const visit = () => {
    if (order.length === spans.length) {
      for (let mask = 0; mask < 2 ** spans.length; mask++) {
        const lanes = spans.map(
          (_, i) => (order.indexOf(i) + 1) * (mask & (1 << i) ? -1 : 1)
        );
        best = Math.min(best, intersections(spans, lanes));
        if (best === 0) return;
      }
    } else
      for (let i = 0; i < spans.length; i++) {
        if (order.includes(i)) continue;
        order.push(i);
        visit();
        order.pop();
        if (best === 0) return;
      }
  };
  visit();
  return best;
}

test(
  "lane planner attains the exhaustive two-channel minimum for up to six spans",
  () =>
    hegel.test(
      (tc) => {
        const count = tc.draw(gs.integers({ minValue: 1, maxValue: 6 }));
        const spans = Array.from({ length: count }, (_, i) => {
          const a =
            tc.draw(gs.integers({ minValue: 0, maxValue: 12 })) + i / 100;
          const b =
            tc.draw(gs.integers({ minValue: 0, maxValue: 12 })) +
            (i + count) / 100;
          return { x0: Math.min(a, b), x1: Math.max(a, b), y0: 0, y1: 0 };
        });
        const plan = planReturnLanes(spans, 1, 1);
        expect(
          intersections(
            spans,
            plan.map((p) => p.lane)
          )
        ).toBe(minimum(spans));
        expect(planReturnLanes(spans, 1, 1)).toEqual(plan);
      },
      { testCases: 500 }
    ),
  120_000
);

test("stacked spans reuse local lanes and nested spans put the inner lane first", () => {
  const plan = planReturnLanes([
    { x0: 0, x1: 20, y0: 0, y1: 10 },
    { x0: 0, x1: 20, y0: 200, y1: 210 },
    { x0: 2, x1: 18, y0: 0, y1: 10 },
  ]);
  expect(plan[0].lane).toBeGreaterThan(plan[2].lane);
  expect(plan[0].lane).toBeLessThan(200);
  expect(plan[1].lane).toBe(250);
});

test("port-side preferences and drop order keep stacked side ports crossing free", () =>
  hegel.test(
    (tc) => {
      const count = tc.draw(gs.integers({ minValue: 2, maxValue: 6 }));
      const side = tc.draw(gs.sampledFrom(["E", "W"] as const));
      const channel = tc.draw(gs.sampledFrom(["top", "bottom"] as const));
      const spans = Array.from({ length: count }, (_, i) => ({
        x0: 0,
        x1: 100,
        y0: 0,
        y1: 100,
        preferred: channel,
        from: { part: "part", port: `p${i}`, side, order: i, count },
        to: { part: "other", port: `p${i}`, side, order: i, count },
      }));
      const plan = planReturnLanes(spans, 40, 20);
      const paths = plan.map((p, i) => {
        const y = 10 + i * 10;
        const x = 120 + p.fromDrop * 20;
        return [
          [100, y],
          [x, y],
          [x, p.lane],
        ];
      });
      let crossings = 0;
      for (let i = 0; i < count; i++)
        for (let j = 0; j < count; j++)
          if (i !== j) {
            const [a, b] = paths[i];
            const [v, w] = paths[j].slice(1);
            if (
              Math.min(a[0], b[0]) < v[0] &&
              v[0] < Math.max(a[0], b[0]) &&
              Math.min(v[1], w[1]) < a[1] &&
              a[1] < Math.max(v[1], w[1])
            )
              crossings++;
          }
      // Exhaustive permutations of drop order cannot improve on this zero lower bound.
      expect(crossings).toBe(0);
      expect(
        preferredChannel({
          ...spans[0],
          preferred: undefined,
          to: spans[0].from,
        })
      ).toBe("top");
      expect(
        preferredChannel({
          ...spans.at(-1)!,
          preferred: undefined,
          to: spans.at(-1)!.from,
        })
      ).toBe("bottom");
    },
    { testCases: 500 }
  ));

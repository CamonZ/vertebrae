import { expect, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { crossingJumps, railCrossings } from "./crossings";
import { pointAt, route, type Point } from "../route";

const orient = (a: Point, b: Point, c: Point) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

test("crossing detector agrees with independent orientation predicate", () =>
  hegel.test(
    (tc) => {
      const path = (): Point[] => {
        const points: Point[] = [
          [
            tc.draw(gs.integers({ minValue: -10, maxValue: 10 })),
            tc.draw(gs.integers({ minValue: -10, maxValue: 10 })),
          ],
        ];
        for (let i = 0; i < 4; i++) {
          const p = points.at(-1)!;
          const coordinate = tc.draw(
            gs.integers({ minValue: -10, maxValue: 10 })
          );
          points.push(i % 2 ? [p[0], coordinate] : [coordinate, p[1]]);
        }
        return points;
      };
      const a = path();
      const b = path();
      let expected = 0;
      for (let i = 1; i < a.length; i++)
        for (let j = 1; j < b.length; j++)
          if (
            orient(a[i - 1], a[i], b[j - 1]) * orient(a[i - 1], a[i], b[j]) <
              0 &&
            orient(b[j - 1], b[j], a[i - 1]) * orient(b[j - 1], b[j], a[i]) < 0
          )
            expected++;
      expect(railCrossings(a, b)).toHaveLength(expected);
    },
    { testCases: 500 }
  ));

test("a hop is on the later rail and drawing/motion traverse the same arc", () => {
  const paths: Point[][] = [
    [
      [0, 50],
      [100, 50],
    ],
    [
      [50, 0],
      [50, 100],
    ],
  ];
  const jumps = crossingJumps(paths);
  expect(jumps).toEqual([[], [{ at: [50, 50], segment: 0 }]]);
  const r = route(paths[1], undefined, { jumps: jumps[1] });
  expect(pointAt(r, 0.5)[0]).toBeCloseTo(56);
  expect(r.length).toBeGreaterThan(100);
  expect(pointAt(r, 0)).toEqual([50, 0]);
  expect(pointAt(r, 1)).toEqual([50, 100]);
});

test("shared endpoints and collinear runs are not crossings", () => {
  expect(
    railCrossings(
      [
        [0, 0],
        [10, 0],
      ],
      [
        [10, 0],
        [10, 10],
      ]
    )
  ).toEqual([]);
  expect(
    railCrossings(
      [
        [0, 0],
        [10, 0],
      ],
      [
        [2, 0],
        [8, 0],
      ]
    )
  ).toEqual([]);
  expect(
    crossingJumps([
      [
        [0, 0],
        [10, 0],
      ],
      [
        [10, 0],
        [10, 10],
      ],
    ])
  ).toEqual([[], []]);
});

test("coincident intersections keep one hopping orientation per segment pair", () => {
  const paths: Point[][] = [
    [
      [0, 50],
      [100, 50],
    ],
    [
      [50, 0],
      [50, 100],
    ],
    [
      [0, 50],
      [100, 50],
    ],
  ];
  expect(crossingJumps(paths)).toEqual([
    [{ at: [50, 50], segment: 0 }],
    [],
    [{ at: [50, 50], segment: 0 }],
  ]);
});

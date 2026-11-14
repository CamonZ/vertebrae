import { expect, test } from "vitest";
import { pointAt, route } from "./route";

test("a bus corner uses room left by a small adjacent fan-out corner", () => {
  const r = route(
    [
      [0, 0],
      [100, 0],
      [100, 40],
      [200, 40],
    ],
    22,
    { cornerRadii: [0, 32, 2, 0] }
  );
  expect(r.points).toContainEqual([68, 0]);
  expect(r.points).toContainEqual([100, 32]);
  expect(r.points).toContainEqual([100, 38]);
});

test("collinear and repeated fan-out vertices do not truncate concentric corners", () => {
  const points = [
    [0, 0],
    [20, 0],
    [20, 0],
    [100, 0],
    [100, 40],
    [200, 40],
  ] as const;
  const style = { cornerRadii: [0, 2, 2, 32, 2, 0] };
  expect(route(points, 22, style).points).toEqual(
    route(
      [
        [0, 0],
        [100, 0],
        [100, 40],
        [200, 40],
      ],
      22,
      { cornerRadii: [0, 32, 2, 0] }
    ).points
  );
  const hopped = route(points, 22, {
    ...style,
    jumps: [{ at: [50, 0], segment: 2 }],
  });
  expect(hopped.points).toContainEqual([50, -6]);
  expect(pointAt(hopped, 0)).toEqual(points[0]);
  expect(pointAt(hopped, 1)).toEqual(points.at(-1));
});

test("oversized adjacent custom radii share their segment without overlapping", () => {
  const r = route(
    [
      [0, 0],
      [100, 0],
      [100, 40],
      [200, 40],
    ],
    22,
    { cornerRadii: [0, 50, 50, 0] }
  );
  expect(r.points.every((p) => p.every(Number.isFinite))).toBe(true);
  expect(
    r.cumulative.every((d, i) => i === 0 || d >= r.cumulative[i - 1])
  ).toBe(true);
});

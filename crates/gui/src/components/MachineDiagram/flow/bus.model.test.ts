import { expect, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { groupBundles, offsetBusTracks, type BusCandidate } from "./bus";
import { route } from "../route";

/** Exhaust all subsets and choose maximal compatible groups, independent of
 * the production consecutive-track scan. */
function reference(rails: readonly BusCandidate[]): number[][] {
  const valid: number[][] = [];
  for (let mask = 0; mask < 2 ** rails.length; mask++) {
    const members = rails
      .map((_, i) => i)
      .filter((i) => mask & (1 << i))
      .sort((a, b) => rails[a].from.order - rails[b].from.order);
    if (members.length < 2) continue;
    const first = rails[members[0]];
    const lo = Math.max(...members.map((i) => rails[i].corridor[0]));
    const hi = Math.min(...members.map((i) => rails[i].corridor[1]));
    if (hi - lo < 80) continue;
    if (
      !members.every(
        (i, k) =>
          rails[i].direction === first.direction &&
          rails[i].from.part === first.from.part &&
          rails[i].from.side === first.from.side &&
          rails[i].to.part === first.to.part &&
          rails[i].to.side === first.to.side &&
          rails[i].from.order === first.from.order + k &&
          rails[i].to.order === first.to.order + k
      )
    )
      continue;
    const minY = Math.min(...members.map((i) => rails[i].y));
    const maxY = Math.max(...members.map((i) => rails[i].y));
    if (
      rails.some(
        (r, i) =>
          !members.includes(i) &&
          minY < r.y &&
          r.y < maxY &&
          r.corridor[0] < hi &&
          lo < r.corridor[1]
      )
    )
      continue;
    valid.push(members);
  }
  const used = new Set<number>();
  return valid
    .sort((a, b) => b.length - a.length || a[0] - b[0])
    .filter((group) => {
      if (group.some((i) => used.has(i))) return false;
      for (const i of group) used.add(i);
      return true;
    })
    .sort((a, b) => a[0] - b[0]);
}

test("bundle grouping equals exhaustive maximal-subset oracle", () =>
  hegel.test(
    (tc) => {
      const count = tc.draw(gs.integers({ minValue: 1, maxValue: 6 }));
      const rails: BusCandidate[] = Array.from({ length: count }, (_, i) => ({
        from: { part: "from", side: "E", order: i },
        to: {
          part: "to",
          side: "W",
          order: tc.draw(gs.integers({ minValue: 0, maxValue: count - 1 })),
        },
        direction: tc.draw(gs.booleans()) ? 1 : -1,
        corridor: [
          tc.draw(gs.integers({ minValue: 0, maxValue: 30 })),
          tc.draw(gs.integers({ minValue: 70, maxValue: 160 })),
        ],
        y: i * 20,
      }));
      expect(groupBundles(rails).sort((a, b) => a[0] - b[0])).toEqual(
        reference(rails)
      );
    },
    { testCases: 500 }
  ));

test("offset tracks keep exact pitch and concentric corner radii, including clamping", () =>
  hegel.test(
    (tc) => {
      const count = tc.draw(gs.integers({ minValue: 2, maxValue: 10 }));
      const tracks = offsetBusTracks(
        [
          [0, 0],
          [400, 0],
          [400, 400],
          [800, 400],
        ],
        count
      );
      for (let i = 1; i < count; i++) {
        expect(tracks[i].points[0][1] - tracks[i - 1].points[0][1]).toBe(20);
        expect(tracks[i - 1].points[1][0] - tracks[i].points[1][0]).toBe(20);
        expect(tracks[i].points[3][1] - tracks[i - 1].points[3][1]).toBe(20);
      }
      for (const [i, track] of tracks.entries()) {
        const offset = (i - (count - 1) / 2) * 20;
        expect(track.cornerRadii[1]).toBe(Math.max(2, 22 - offset));
        expect(track.cornerRadii[2]).toBe(Math.max(2, 22 + offset));
        const rounded = route(track.points, undefined, track);
        expect(rounded.points.every((p) => p.every(Number.isFinite))).toBe(
          true
        );
        expect(rounded.length).toBeGreaterThan(0);
      }
    },
    { testCases: 500 }
  ));

test("a short leading corridor does not consume a larger compatible bundle", () => {
  const rails: BusCandidate[] = [
    [0, 100],
    [0, 200],
    [50, 200],
    [50, 200],
  ].map(([x0, x1], i) => ({
    from: { part: "a", side: "E", order: i },
    to: { part: "b", side: "W", order: i },
    direction: 1,
    corridor: [x0, x1],
    y: i * 20,
  }));
  expect(groupBundles(rails)).toEqual([[1, 2, 3]]);
  expect(groupBundles(rails)).toEqual(reference(rails));
});

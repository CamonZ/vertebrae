import { RAIL_RADIUS, type Point, type PortSide } from "../route";

export const BUS_MIN_LENGTH = 80;
export const BUS_PITCH = 20;
export const MIN_CORNER_RADIUS = 2;

export interface BusEnd {
  readonly part: string;
  readonly side: PortSide;
  /** Geometric port order on this side, including unused ports. */
  readonly order: number;
}
export interface BusCandidate {
  readonly from: BusEnd;
  readonly to: BusEnd;
  readonly direction: -1 | 1;
  readonly corridor: readonly [number, number];
  readonly y: number;
}

/** Maximal consecutive, order-preserving tracks with a common corridor.
 * Non-members in the corridor split a bundle rather than being enclosed by it.
 */
export function groupBundles(
  rails: readonly BusCandidate[],
  minimum = BUS_MIN_LENGTH
): number[][] {
  const same = (a: BusEnd, b: BusEnd) => a.part === b.part && a.side === b.side;
  const order = rails
    .map((r, i) => ({ r, i }))
    .sort((a, b) => a.r.from.order - b.r.from.order || a.i - b.i);
  const candidates: number[][] = [];
  const grow = (group: number[], lo: number, hi: number) => {
    const first = rails[group[0]];
    const last = rails[group[group.length - 1]];
    if (group.length > 1) {
      const lowY = Math.min(...group.map((k) => rails[k].y));
      const highY = Math.max(...group.map((k) => rails[k].y));
      const between = rails.filter(
        (other, k) =>
          !group.includes(k) &&
          lowY < other.y &&
          other.y < highY &&
          other.corridor[0] < hi &&
          lo < other.corridor[1]
      );
      if (!between.length) candidates.push(group);
      // A covered interloper that cannot be a future consecutive member
      // remains between the tracks for every narrower extension of this run.
      if (
        between.some(
          (other) =>
            other.corridor[0] <= lo &&
            other.corridor[1] >= hi &&
            (!same(first.from, other.from) ||
              !same(first.to, other.to) ||
              first.direction !== other.direction ||
              other.from.order <= last.from.order ||
              other.to.order - first.to.order !==
                other.from.order - first.from.order)
        )
      )
        return;
    }
    for (const { r: next, i } of order) {
      if (
        !same(first.from, next.from) ||
        !same(first.to, next.to) ||
        first.direction !== next.direction ||
        next.from.order !== last.from.order + 1 ||
        next.to.order !== last.to.order + 1
      )
        continue;
      const left = Math.max(lo, next.corridor[0]);
      const right = Math.min(hi, next.corridor[1]);
      if (right - left >= minimum) grow([...group, i], left, right);
    }
  };
  for (const { r, i } of order)
    if (r.corridor[1] - r.corridor[0] >= minimum)
      grow([i], r.corridor[0], r.corridor[1]);
  const used = new Set<number>();
  return candidates
    .sort((a, b) => b.length - a.length || a[0] - b[0])
    .filter((group) => {
      if (group.some((i) => used.has(i))) return false;
      for (const i of group) used.add(i);
      return true;
    })
    .sort((a, b) => a[0] - b[0]);
}

export interface BusTrack {
  readonly points: readonly Point[];
  readonly cornerRadii: readonly number[];
}

/** Offset an orthogonal backbone with mitered vertices and concentric corners.
 * Each track remains a separate line; the caller supplies its port fan-outs.
 */
export function offsetBusTracks(
  spine: readonly Point[],
  count: number,
  pitch = BUS_PITCH
): BusTrack[] {
  if (spine.length < 2 || count < 1) return [];
  const headings = spine.slice(1).map((b, i): Point => {
    const a = spine[i];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length === 0 || (a[0] !== b[0] && a[1] !== b[1]))
      throw new Error("Bus backbone must have nonzero orthogonal segments");
    return [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
  });
  return Array.from({ length: count }, (_, k) => {
    const offset = (k - (count - 1) / 2) * pitch;
    const cornerRadii: number[] = [];
    const points = spine.map((p, i): Point => {
      const incoming = headings[Math.max(0, i - 1)];
      const outgoing = headings[Math.min(i, headings.length - 1)];
      const turn = incoming[0] * outgoing[1] - incoming[1] * outgoing[0];
      cornerRadii.push(
        Math.max(MIN_CORNER_RADIUS, RAIL_RADIUS - turn * offset)
      );
      if (turn === 0)
        return [p[0] - incoming[1] * offset, p[1] + incoming[0] * offset];
      return [
        p[0] - (incoming[1] + outgoing[1]) * offset,
        p[1] + (incoming[0] + outgoing[0]) * offset,
      ];
    });
    return { points, cornerRadii };
  });
}

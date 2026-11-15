/**
 * Rail label boxes and spots beside a route, shared by auto-layout and the
 * compiler's turned (non left-to-right) placement.
 */
import type { Point } from "../route";
import { LINE_EM, RAIL_LABEL_SIZE, textWidth, type Box } from "./extent";

export const LABEL_PAD_X = 12;
export const LABEL_PAD_Y = 4;
export const SNAP = 0.5;

export type Segment = readonly [Point, Point];

export const segments = (points: readonly Point[]): Segment[] =>
  points.slice(1).map((p, i) => [points[i], p] as const);

export const segmentBox = ([a, b]: Segment): Box => ({
  x0: Math.min(a[0], b[0]),
  y0: Math.min(a[1], b[1]),
  x1: Math.max(a[0], b[0]),
  y1: Math.max(a[1], b[1]),
});

/** Strict overlap that also works for zero-width segment boxes. */
export const crosses = (a: Box, b: Box) =>
  a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

export const labelBox = (
  [x, y]: Point,
  text: string,
  size = RAIL_LABEL_SIZE
): Box => {
  const w = textWidth(text, size) + LABEL_PAD_X;
  const h = labelHeight(size);
  return {
    x0: x - w / 2,
    y0: y - h / 2,
    x1: x + w / 2,
    y1: y + h / 2,
  };
};

export const labelHeight = (size: number) => size * LINE_EM + LABEL_PAD_Y;

/** Keep a rerouted rail's label beside a clear run, rather than its old ELK run. */
export function labelOnRoute(
  points: readonly Point[],
  text: string,
  obstacles: readonly Box[],
  size = RAIL_LABEL_SIZE
): Point | undefined {
  const runs = segments(points);
  const width = textWidth(text, size) + LABEL_PAD_X;
  const height = labelHeight(size);
  const lift = height / 2 + 5;
  for (const [a, b] of [...runs].sort(
    (s, t) => Math.abs(t[1][0] - t[0][0]) - Math.abs(s[1][0] - s[0][0])
  )) {
    const x = (a[0] + b[0]) / 2;
    const y = (a[1] + b[1]) / 2;
    // Centred, then flush with either end (overhanging the run when the
    // label is longer than it), then just clear of each obstacle.
    const positions = (lo: number, hi: number, half: number, axis: 0 | 1) => [
      (lo + hi) / 2,
      lo + half + 5,
      hi - half - 5,
      ...obstacles
        .flatMap((e) =>
          axis === 0
            ? [e.x0 - half - 5, e.x1 + half + 5]
            : [e.y0 - half - 5, e.y1 + half + 5]
        )
        .filter((n) => n >= lo + half && n <= hi - half),
    ];
    const candidates: Point[] =
      Math.abs(a[1] - b[1]) < SNAP
        ? positions(
            Math.min(a[0], b[0]),
            Math.max(a[0], b[0]),
            width / 2,
            0
          ).flatMap((x): Point[] => [
            [x, y - lift],
            [x, y + lift],
          ])
        : positions(
            Math.min(a[1], b[1]),
            Math.max(a[1], b[1]),
            height / 2,
            1
          ).flatMap((y): Point[] => [
            [x + width / 2 + 5, y],
            [x - width / 2 - 5, y],
          ]);
    for (const at of candidates) {
      const box = labelBox(at, text, size);
      if (![...obstacles, ...runs.map(segmentBox)].some((e) => crosses(box, e)))
        return at;
    }
  }
  return clearSpotNear(runs, text, size, obstacles);
}

/** Farthest a fallback label may sit from its rail. */
const LABEL_REACH = 160;

/**
 * Fallback when no spot right beside the route is free: slide along each run
 * and step away from it past whatever is in the way (up to LABEL_REACH), and
 * take the free spot nearest the route. Never over a part, label or rail.
 */
function clearSpotNear(
  runs: readonly Segment[],
  text: string,
  size: number,
  obstacles: readonly Box[]
): Point | undefined {
  const width = textWidth(text, size) + LABEL_PAD_X;
  const height = labelHeight(size);
  const solid = [...obstacles, ...runs.map(segmentBox)];
  let best: { at: Point; distance: number } | undefined;
  for (const [a, b] of runs) {
    const horizontal = Math.abs(a[1] - b[1]) < SNAP;
    // Along the run (k) and across it (j).
    const k = horizontal ? 0 : 1;
    const j = 1 - k;
    const acrossHalf = horizontal ? height / 2 : width / 2;
    const lo = Math.min(a[k], b[k]);
    const hi = Math.max(a[k], b[k]);
    const line = a[j];
    const steps = Math.min(40, Math.max(1, Math.ceil((hi - lo) / 16)));
    const along = Array.from(
      { length: steps + 1 },
      (_, i) => lo + ((hi - lo) * i) / steps
    );
    const near = solid.filter((e) => {
      const [e0, e1] = j === 0 ? [e.x0, e.x1] : [e.y0, e.y1];
      return e1 >= line - LABEL_REACH && e0 <= line + LABEL_REACH;
    });
    const across = [
      line - acrossHalf - 5,
      line + acrossHalf + 5,
      ...near.flatMap((e) =>
        j === 0
          ? [e.x0 - acrossHalf - 5, e.x1 + acrossHalf + 5]
          : [e.y0 - acrossHalf - 5, e.y1 + acrossHalf + 5]
      ),
    ].filter((c) => Math.abs(c - line) - acrossHalf <= LABEL_REACH);
    for (const u of along)
      for (const v of across) {
        const distance = Math.max(0, Math.abs(v - line) - acrossHalf);
        if (best && distance >= best.distance) continue;
        const at: Point = horizontal ? [u, v] : [v, u];
        const box = labelBox(at, text, size);
        if (!solid.some((e) => crosses(box, e))) best = { at, distance };
      }
  }
  return best?.at;
}

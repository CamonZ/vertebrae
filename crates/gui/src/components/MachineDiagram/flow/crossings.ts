import type { LineJump, Point } from "../route";

export interface RailCrossing {
  readonly at: Point;
  /** Zero-based segment indices in the two polylines. */
  readonly a: number;
  readonly b: number;
}

/** Interior perpendicular intersections; a common endpoint is a connection. */
export function railCrossings(
  a: readonly Point[],
  b: readonly Point[]
): RailCrossing[] {
  const found: RailCrossing[] = [];
  const inside = (n: number, x: number, y: number) =>
    Math.min(x, y) + 0.01 < n && n < Math.max(x, y) - 0.01;
  for (let i = 1; i < a.length; i++)
    for (let j = 1; j < b.length; j++) {
      const [p, q, r, s] = [a[i - 1], a[i], b[j - 1], b[j]];
      const ah = Math.abs(p[1] - q[1]) < 0.01;
      const bh = Math.abs(r[1] - s[1]) < 0.01;
      if (ah === bh) continue;
      const [h, k, v, w] = ah ? [p, q, r, s] : [r, s, p, q];
      if (inside(v[0], h[0], k[0]) && inside(h[1], v[1], w[1]))
        found.push({ at: [v[0], h[1]], a: i - 1, b: j - 1 });
    }
  return found;
}

/** One jumping orientation at each intersection. Usually this is the later
 * rail; coincident multi-rail intersections use its orientation consistently. */
export function crossingJumps(
  paths: readonly (readonly Point[])[]
): LineJump[][] {
  const result: LineJump[][] = paths.map(() => []);
  const sites: {
    at: Point;
    members: { rail: number; segment: number; horizontal: boolean }[];
  }[] = [];
  for (let i = 0; i < paths.length; i++)
    for (let j = 0; j < i; j++) {
      for (const hit of railCrossings(paths[j], paths[i])) {
        let site = sites.find(
          (s) => Math.hypot(s.at[0] - hit.at[0], s.at[1] - hit.at[1]) < 0.01
        );
        if (!site) {
          site = { at: hit.at, members: [] };
          sites.push(site);
        }
        for (const [rail, segment] of [
          [j, hit.a],
          [i, hit.b],
        ])
          if (
            !site.members.some((m) => m.rail === rail && m.segment === segment)
          )
            site.members.push({
              rail,
              segment,
              horizontal:
                Math.abs(
                  paths[rail][segment][1] - paths[rail][segment + 1][1]
                ) < 0.01,
            });
      }
    }
  for (const site of sites) {
    const last = site.members.reduce((a, b) => (b.rail > a.rail ? b : a));
    for (const m of site.members)
      if (m.horizontal === last.horizontal)
        result[m.rail].push({ at: site.at, segment: m.segment });
  }
  return result;
}

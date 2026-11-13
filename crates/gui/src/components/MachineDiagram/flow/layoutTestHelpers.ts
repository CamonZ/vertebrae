import type { DiagramRail } from "./compile";

/** A shared stretch must connect straight to a common end port. */
export function sharesBadStretch(a: DiagramRail, b: DiagramRail): boolean {
  const near = (x: number, y: number) => Math.abs(x - y) < 0.5;
  const ends = (r: DiagramRail) => [
    { port: r.from, points: r.points },
    { port: r.to, points: [...r.points].reverse() },
  ];
  const connected = (
    points: DiagramRail["points"],
    k: number,
    line: number,
    lo: number,
    hi: number
  ) => {
    const stop = points.findIndex((p) => !near(p[1 - k], line));
    const prefix = points.slice(0, stop < 0 ? points.length : stop);
    return (
      prefix.length > 0 &&
      Math.min(...prefix.map((p) => p[k])) <= lo + 0.5 &&
      Math.max(...prefix.map((p) => p[k])) >= hi - 0.5
    );
  };
  for (let i = 1; i < a.points.length; i++)
    for (let j = 1; j < b.points.length; j++) {
      const [p, q, r, s] = [
        a.points[i - 1],
        a.points[i],
        b.points[j - 1],
        b.points[j],
      ];
      for (const k of [0, 1] as const) {
        const o = 1 - k;
        if (!near(p[o], q[o]) || !near(r[o], s[o]) || !near(p[o], r[o]))
          continue;
        const lo = Math.max(Math.min(p[k], q[k]), Math.min(r[k], s[k]));
        const hi = Math.min(Math.max(p[k], q[k]), Math.max(r[k], s[k]));
        if (hi - lo <= 1) continue;
        const allowed = ends(a).some((x) =>
          ends(b).some(
            (y) =>
              x.port.part === y.port.part &&
              x.port.port === y.port.port &&
              connected(x.points, k, p[o], lo, hi) &&
              connected(y.points, k, p[o], lo, hi)
          )
        );
        if (!allowed) return true;
      }
    }
  return false;
}

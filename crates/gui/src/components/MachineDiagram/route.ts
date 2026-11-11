/**
 * Rails: polyline routes with rounded corners (VL-05, radius 22), sampled by
 * arc length. Positions past the end extrapolate along the last segment so a
 * spring that overshoots (`u > 1`) carries the card slightly beyond its stop.
 */

export type Point = readonly [number, number];

export interface Route {
  /** Flattened points, corners replaced by quadratic samples. */
  readonly points: readonly Point[];
  /** Cumulative arc length at each point. */
  readonly cumulative: readonly number[];
  readonly length: number;
}

/** Rail corner radius (VL-05). */
export const RAIL_RADIUS = 22;
const CORNER_SAMPLES = 8;
/** Overshoot extrapolation is capped so a runaway spring cannot fly away. */
const MAX_OVERSHOOT = 160;

export function route(pts: readonly Point[], radius = RAIL_RADIUS): Route {
  if (pts.length === 0) throw new Error("route needs at least one point");
  const out: Point[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1];
    const p = pts[i];
    const b = pts[i + 1];
    const d1 = Math.hypot(p[0] - a[0], p[1] - a[1]) || 1;
    const d2 = Math.hypot(b[0] - p[0], b[1] - p[1]) || 1;
    const r = Math.min(radius, d1 / 2, d2 / 2);
    const s: Point = [
      p[0] + ((a[0] - p[0]) * r) / d1,
      p[1] + ((a[1] - p[1]) * r) / d1,
    ];
    const e: Point = [
      p[0] + ((b[0] - p[0]) * r) / d2,
      p[1] + ((b[1] - p[1]) * r) / d2,
    ];
    for (let k = 0; k <= CORNER_SAMPLES; k++) {
      const u = k / CORNER_SAMPLES;
      const v = 1 - u;
      out.push([
        v * v * s[0] + 2 * u * v * p[0] + u * u * e[0],
        v * v * s[1] + 2 * u * v * p[1] + u * u * e[1],
      ]);
    }
  }
  if (pts.length > 1) out.push(pts[pts.length - 1]);
  const cumulative = [0];
  for (let i = 1; i < out.length; i++) {
    cumulative.push(
      cumulative[i - 1] +
        Math.hypot(out[i][0] - out[i - 1][0], out[i][1] - out[i - 1][1])
    );
  }
  return { points: out, cumulative, length: cumulative[cumulative.length - 1] };
}

/** Point at fraction `u` of the route's arc length; `u > 1` overshoots. */
export function pointAt(r: Route, u: number): Point {
  const p = r.points;
  const n = p.length;
  const d = u * r.length;
  if (n === 1) return p[0];
  if (d >= r.length) {
    const a = p[n - 2];
    const b = p[n - 1];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const x = Math.min(d - r.length, MAX_OVERSHOOT);
    return [b[0] + ((b[0] - a[0]) / l) * x, b[1] + ((b[1] - a[1]) / l) * x];
  }
  if (d <= 0) return p[0];
  let i = 1;
  while (r.cumulative[i] < d) i++;
  const f =
    (d - r.cumulative[i - 1]) / (r.cumulative[i] - r.cumulative[i - 1] || 1);
  return [
    p[i - 1][0] + (p[i][0] - p[i - 1][0]) * f,
    p[i - 1][1] + (p[i][1] - p[i - 1][1]) * f,
  ];
}

const fmt = (n: number) => {
  const v = Math.round(n * 100) / 100;
  return Object.is(v, -0) ? "0" : String(v);
};

/** SVG path data for a route (stable formatting, so equal routes compare equal). */
export function routePath(r: Route): string {
  return r.points
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${fmt(x)} ${fmt(y)}`)
    .join(" ");
}

/** A port is where a rail meets a part frame: a point and the side it faces. */
export type PortSide = "W" | "E" | "N" | "S";
export interface Port {
  readonly x: number;
  readonly y: number;
  readonly side: PortSide;
}

const isHorizontal = (side: PortSide) => side === "W" || side === "E";

/**
 * Orthogonal rail points from one port to another: straight when aligned,
 * otherwise one elbow pair at the midpoint along the leaving direction.
 * Pass the result to `route` for rounded corners.
 */
export function railBetween(from: Port, to: Port): Point[] {
  const a: Point = [from.x, from.y];
  const b: Point = [to.x, to.y];
  if (from.x === to.x || from.y === to.y) return [a, b];
  if (isHorizontal(from.side)) {
    if (!isHorizontal(to.side)) return [a, [to.x, from.y], b];
    const mx = (from.x + to.x) / 2;
    return [a, [mx, from.y], [mx, to.y], b];
  }
  if (isHorizontal(to.side)) return [a, [from.x, to.y], b];
  const my = (from.y + to.y) / 2;
  return [a, [from.x, my], [to.x, my], b];
}

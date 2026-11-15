/**
 * Topology-first rail routing. A crossing-free drawing exists exactly when the
 * fixed port order admits a planar embedding (see `portEmbedding`), and then
 * it exists for any placement of the parts. So routing is done in two steps:
 *
 * 1. Choose the embedding: for every port, the clockwise order of the rails
 *    that share it. A crossing-free forest of the current routes is kept and
 *    fixes its part of that order.
 * 2. Realize it. The other rails are drawn one at a time, those completing
 *    a spanning forest first, each by a grid search that may not touch any
 *    drawn rail and must leave and enter its ports in the slot the embedding
 *    gives it. Once a component's spanning tree is down, a further rail's two
 *    ends lie on one face of the drawing so far, which the search can reach
 *    as long as earlier rails left room. To keep room:
 *    - rails keep a halo from parts and stay out of other ports' openings;
 *    - the first pass peels off and joins port runs half a stub out, and only
 *      a fine retry uses the sliver inside, on a grid with a line in every
 *      gap between obstacle coordinates;
 *    - a rail that still finds no room (or no room for its label) is ripped
 *      up and drawn first on the next of a few attempts.
 *    A label with no room beside the shortest route moves to a route through
 *    the outer lane, whose long run carries it.
 *
 * Labels and region headers cost extra to cross but never block, so they
 * cannot cut a face in two. When realization fails, the caller keeps its
 * routes and their crossings are drawn with jumps.
 */
import type { Point, PortSide } from "../route";
import type { DiagramTimeline, RailRoute } from "./compile";
import type { Box } from "./extent";
import { railCrossings } from "./crossings";
import { portEmbedding, type Dart } from "./portTopology";

export interface FaceEnd {
  readonly part: string;
  readonly port: string;
  readonly side: PortSide;
  /** The port, and where its stub meets the part's border. */
  readonly at: Point;
  readonly border: Point;
}

export interface FaceRail {
  readonly id: string;
  readonly from: FaceEnd;
  readonly to: FaceEnd;
  /** The current route, if any. */
  readonly route?: RailRoute;
  /** False for rails whose route must stay (hand-placed endpoints). */
  readonly movable: boolean;
  readonly label?: string;
}

export interface FaceRouting {
  readonly diagram: Pick<DiagramTimeline, "parts" | "rails">;
  /** Same order and ids as `diagram.rails`. */
  readonly rails: readonly FaceRail[];
  /** Part extents, which rails may not enter. */
  readonly parts: readonly Box[];
  /** Region headers: crossing them costs extra. */
  readonly soft: readonly Box[];
  /** Rails to keep where they are if the embedding allows, best first. */
  readonly preference: readonly string[];
  readonly gap: number;
  readonly stub: number;
  readonly labelBox: (at: Point, text: string) => Box;
  readonly placeLabel: (
    points: readonly Point[],
    text: string,
    obstacles: readonly Box[]
  ) => Point | undefined;
}

const SNAP = 0.5;
const BEND = 120;
/** Extra cost per px of running closer than a rail gap beside a rail or part. */
const NEAR = 3;
/** Extra cost per px of running over a label or region header. */
const OVER = 8;
const BIG = 1e6;

const OUTWARD: Record<PortSide, Point> = {
  W: [-1, 0],
  E: [1, 0],
  N: [0, -1],
  S: [0, 1],
};
const MOVES: readonly Point[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1];
const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]];
/** The side clockwise order visits first at a port: outward turned left. */
const firstSide = (o: Point): Point => [o[1], -o[0]];

/**
 * Where a rail end sits in the clockwise order of the rails sharing its
 * port. Rails leave a port together along its stub and peel off one by one;
 * the earliest to peel towards the first side is first, the earliest to peel
 * the other way is last, and one that never peels is in the middle.
 */
export function slotKey(points: readonly Point[], end: FaceEnd): number {
  const o = OUTWARD[end.side];
  const f = firstSide(o);
  for (let i = 1; i < points.length; i++) {
    if (Math.abs(dot(sub(points[i], end.at), f)) < SNAP) continue;
    const t = dot(sub(points[i - 1], end.at), o);
    return dot(sub(points[i], points[i - 1]), f) > 0 ? t : 2 * BIG - t;
  }
  return BIG;
}

const fromStart = (points: readonly Point[], toEnd: boolean) =>
  toEnd ? [...points].reverse() : points;

const portKey = (e: FaceEnd) => `${e.part}.${e.port}`;

class Components {
  private readonly parent = new Map<string, string>();
  root(a: string): string {
    let r = a;
    while (this.parent.has(r)) r = this.parent.get(r)!;
    return r;
  }
  join(a: string, b: string): boolean {
    const [x, y] = [this.root(a), this.root(b)];
    if (x === y) return false;
    this.parent.set(x, y);
    return true;
  }
}

function segmentsOf(points: readonly Point[]): [Point, Point][] {
  return points.slice(1).map((p, i) => [points[i], p]);
}

function collinearOverlap(a: [Point, Point], b: [Point, Point]): boolean {
  for (const k of [0, 1] as const) {
    const o = 1 - k;
    if (
      Math.abs(a[0][o] - a[1][o]) < SNAP &&
      Math.abs(b[0][o] - b[1][o]) < SNAP &&
      Math.abs(a[0][o] - b[0][o]) < SNAP
    ) {
      const lo = Math.max(
        Math.min(a[0][k], a[1][k]),
        Math.min(b[0][k], b[1][k])
      );
      const hi = Math.min(
        Math.max(a[0][k], a[1][k]),
        Math.max(b[0][k], b[1][k])
      );
      if (hi - lo > SNAP) return true;
    }
  }
  return false;
}

/** The straight run from a rail end's port until the rail first turns. */
function portRun(points: readonly Point[], end: FaceEnd): [Point, Point] {
  const f = firstSide(OUTWARD[end.side]);
  let i = 1;
  while (i < points.length && Math.abs(dot(sub(points[i], end.at), f)) < SNAP)
    i++;
  return [points[0], points[i - 1]];
}

/** Two drawn rails meet only on the opening run of a port they share, as
 * far as both still run along it. */
export function compatible(
  a: FaceRail,
  pa: readonly Point[],
  b: FaceRail,
  pb: readonly Point[]
): boolean {
  if (railCrossings(pa, pb).length) return false;
  const runs = (r: FaceRail, p: readonly Point[]) => [
    { key: portKey(r.from), end: r.from, run: portRun(p, r.from) },
    { key: portKey(r.to), end: r.to, run: portRun([...p].reverse(), r.to) },
  ];
  const shared = runs(a, pa).flatMap((x) =>
    runs(b, pb)
      .filter((y) => y.key === x.key)
      .map((y): [Point, Point] => {
        const o = OUTWARD[x.end.side];
        const reach = (run: [Point, Point]) => dot(sub(run[1], run[0]), o);
        return reach(x.run) <= reach(y.run) ? x.run : y.run;
      })
  );
  return !segmentsOf(pa).some((s) =>
    segmentsOf(pb).some(
      (t) => collinearOverlap(s, t) && !shared.some((run) => within(s, t, run))
    )
  );
}

/** The overlap of two collinear segments lies inside a port run. */
function within(s: [Point, Point], t: [Point, Point], run: [Point, Point]) {
  if (!collinearOverlap(s, run) && !collinearOverlap(t, run)) return false;
  const k = Math.abs(s[0][0] - s[1][0]) < SNAP ? 1 : 0;
  const lo = Math.max(Math.min(s[0][k], s[1][k]), Math.min(t[0][k], t[1][k]));
  const hi = Math.min(Math.max(s[0][k], s[1][k]), Math.max(t[0][k], t[1][k]));
  const [r0, r1] = [
    Math.min(run[0][k], run[1][k]),
    Math.max(run[0][k], run[1][k]),
  ];
  return (
    Math.abs(run[0][1 - k] - s[0][1 - k]) < SNAP &&
    lo >= r0 - SNAP &&
    hi <= r1 + SNAP
  );
}

/**
 * Route every movable rail crossing-free, keeping as many current routes as
 * the embedding allows. Undefined when the port order has no planar
 * embedding or a rail cannot be realized (then the caller keeps its routes).
 */
export function routeByTopology(
  o: FaceRouting
): Record<string, RailRoute> | undefined {
  const byId = new Map(o.rails.map((r, i) => [r.id, { r, i }]));
  const drawnOrder = (keep: ReadonlySet<string>): Map<string, Dart[]> => {
    const at = new Map<string, { dart: Dart; key: number }[]>();
    o.rails.forEach((r, i) => {
      if (!keep.has(r.id) || !r.route) return;
      for (const [end, dart, toEnd] of [
        [r.from, 2 * i, false],
        [r.to, 2 * i + 1, true],
      ] as const) {
        const list = at.get(portKey(end)) ?? [];
        list.push({
          dart,
          key: slotKey(fromStart(r.route.points, toEnd), end),
        });
        at.set(portKey(end), list);
      }
    });
    return new Map(
      [...at].map(([k, v]) => [
        k,
        v.sort((a, b) => a.key - b.key).map((x) => x.dart),
      ])
    );
  };
  const everything = new Set(o.rails.filter((r) => r.route).map((r) => r.id));
  const preferred = drawnOrder(everything);

  // Kept rails: fixed ones, then a greedy crossing-free forest of the rest.
  const fixed = o.rails.filter((r) => !r.movable && r.route);
  const choose = (forest: boolean) => {
    const keep = new Set(fixed.map((r) => r.id));
    if (!forest) return keep;
    const joined = new Components();
    for (const r of fixed) joined.join(r.from.part, r.to.part);
    for (const id of o.preference) {
      const r = byId.get(id)?.r;
      if (!r?.route || !r.movable) continue;
      const p = r.route.points as Point[];
      if (blocksOpening(o, r, p) || hugsPart(o, r, p)) continue;
      if (
        [...keep].some(
          (k) =>
            !compatible(
              r,
              p,
              byId.get(k)!.r,
              byId.get(k)!.r.route!.points as Point[]
            )
        )
      )
        continue;
      if (!joined.join(r.from.part, r.to.part)) continue;
      keep.add(id);
    }
    return keep;
  };
  const drawAll = (
    keep: ReadonlySet<string>,
    embedding: ReadonlyMap<string, readonly Dart[]>
  ): Map<string, RailRoute> | undefined => {
    // Draw the rest: rails that join two components first, then the others.
    // A rail that finds no room is ripped up with everything drawn after the
    // kept rails and goes first next time (a few attempts at most).
    const promoted: string[] = [];
    const attempt = (lenient: boolean): Map<string, RailRoute> | string => {
      const joined = new Components();
      for (const id of keep) {
        const r = byId.get(id)!.r;
        joined.join(r.from.part, r.to.part);
      }
      const movable = o.preference.filter(
        (id) => !keep.has(id) && byId.get(id)?.r.movable
      );
      const rest = [
        ...promoted,
        ...movable.filter((id) => !promoted.includes(id)),
      ];
      const order: string[] = [];
      for (let grew = true; grew; ) {
        grew = false;
        for (const id of rest) {
          if (order.includes(id)) continue;
          const r = byId.get(id)!.r;
          if (joined.join(r.from.part, r.to.part)) {
            order.push(id);
            grew = true;
          }
        }
      }
      order.push(...rest.filter((id) => !order.includes(id)));
      const routes = new Map<string, RailRoute>();
      for (const id of keep) routes.set(id, byId.get(id)!.r.route!);
      for (const id of order) {
        const { r, i } = byId.get(id)!;
        let route =
          realize(o, r, i, routes, embedding!) ??
          realize(o, r, i, routes, embedding!, true);
        // No room for the label beside the shortest route: run through the
        // outer lane below (or above) everything, whose long run carries it.
        if (route && r.label && !route.labelAt)
          for (const via of ["bottom", "top"] as const) {
            const roomy = realize(o, r, i, routes, embedding!, false, via);
            if (roomy?.labelAt) {
              route = roomy;
              break;
            }
          }
        // A label with no room anywhere: rip up and draw this rail earlier,
        // accepting a missing label only on the last attempt.
        if (!route || (r.label && !route.labelAt && !lenient)) return id;
        routes.set(id, route);
      }
      return routes;
    };
    let routes: Map<string, RailRoute> | undefined;
    for (let tries = 0; tries < 6 && !routes; tries++) {
      const result = attempt(false);
      if (typeof result !== "string") routes = result;
      else {
        if (promoted[0] === result) break;
        const at = promoted.indexOf(result);
        if (at >= 0) promoted.splice(at, 1);
        promoted.unshift(result);
      }
    }
    if (!routes) {
      const result = attempt(true);
      if (typeof result === "string") return undefined;
      routes = result;
    }
    return routes;
  };

  const compatibleAll = (routes: Map<string, RailRoute>) => {
    const all = [...routes];
    for (const [i, [a, ra]] of all.entries())
      for (const [b, rb] of all.slice(i + 1))
        if (
          !compatible(
            byId.get(a)!.r,
            ra.points as Point[],
            byId.get(b)!.r,
            rb.points as Point[]
          )
        )
          return false;
    return true;
  };

  // Keep a crossing-free forest of the current routes if that works out;
  // otherwise draw every movable rail afresh.
  // A preferred embedding may be planar but leave no room for this bounded
  // geometric realization. Retry the canonical rotation before keeping jumps.
  const orders = preferred.size
    ? [preferred, new Map<string, Dart[]>()]
    : [preferred];
  for (const order of orders) {
    let lastKeep: string | undefined;
    for (const forest of [true, false]) {
      const keep = choose(forest);
      const id = [...keep].join(" ");
      if (id === lastKeep) continue;
      lastKeep = id;
      const embedding = portEmbedding(o.diagram, drawnOrder(keep), order);
      if (!embedding) continue;
      const routes = drawAll(keep, embedding);
      if (routes && compatibleAll(routes)) return Object.fromEntries(routes);
    }
  }
  return undefined;
}

/** Rails keep this far from every part (beyond its 1px padding) except
 * along their own port runs. */
const HALO = 3;

/** Whether a route comes within the halo of a part off its own port runs. */
function hugsPart(o: FaceRouting, r: FaceRail, points: Point[]) {
  const onRun = (p: Point) =>
    [r.from, r.to].some((e) => {
      const d = OUTWARD[e.side];
      return (
        Math.abs(dot(sub(p, e.at), firstSide(d))) < 0.01 &&
        dot(sub(p, e.at), d) >= -0.01
      );
    });
  return segmentsOf(points).some(([a, b]) => {
    if (onRun(a) && onRun(b)) return false;
    return o.parts.some((e) => {
      // Beyond the halo, room for one more rail line on either side.
      const h = 1 + HALO + 2;
      return (
        Math.min(a[0], b[0]) < e.x1 + h &&
        e.x0 - h < Math.max(a[0], b[0]) &&
        Math.min(a[1], b[1]) < e.y1 + h &&
        e.y0 - h < Math.max(a[1], b[1])
      );
    });
  });
}

/** Whether a route passes within half a stub of another port's border. */
function blocksOpening(o: FaceRouting, r: FaceRail, points: Point[]) {
  const mine = new Set([portKey(r.from), portKey(r.to)]);
  const meets = (a: [Point, Point], b: [Point, Point]) =>
    Math.max(Math.min(a[0][0], a[1][0]), Math.min(b[0][0], b[1][0])) <=
      Math.min(Math.max(a[0][0], a[1][0]), Math.max(b[0][0], b[1][0])) + 0.01 &&
    Math.max(Math.min(a[0][1], a[1][1]), Math.min(b[0][1], b[1][1])) <=
      Math.min(Math.max(a[0][1], a[1][1]), Math.max(b[0][1], b[1][1])) + 0.01;
  return o.rails.some((q) =>
    [q.from, q.to].some((e) => {
      if (mine.has(portKey(e))) return false;
      const d = OUTWARD[e.side];
      const opening: [Point, Point] = [
        e.border,
        [e.border[0] + d[0] * (o.stub / 2), e.border[1] + d[1] * (o.stub / 2)],
      ];
      return segmentsOf(points).some((s) => meets(s, opening));
    })
  );
}

/** Bounds of the allowed slot for a new end among the ends already drawn. */
function slotBounds(
  o: FaceRouting,
  end: FaceEnd,
  dart: Dart,
  routes: ReadonlyMap<string, RailRoute>,
  embedding: ReadonlyMap<string, readonly Dart[]>
): [number, number] {
  const order = embedding.get(portKey(end)) ?? [];
  const keyOf = (d: Dart): number | undefined => {
    const r = o.rails[d >> 1];
    const route = routes.get(r.id);
    if (!route) return undefined;
    return slotKey(fromStart(route.points, d % 2 === 1), end);
  };
  const at = order.indexOf(dart);
  let lo = -Infinity;
  let hi = Infinity;
  for (let j = at - 1; j >= 0; j--) {
    const k = keyOf(order[j]);
    if (k !== undefined) {
      lo = k;
      break;
    }
  }
  for (let j = at + 1; j < order.length; j++) {
    const k = keyOf(order[j]);
    if (k !== undefined) {
      hi = k;
      break;
    }
  }
  return [lo, hi];
}

function uniq(values: number[]): number[] {
  return [
    ...new Map(values.map((n) => [Math.round(n * 100), n] as const)).values(),
  ].sort((a, b) => a - b);
}

/** Draw one rail in its face, entering and leaving its ports in their slots. */
function realize(
  o: FaceRouting,
  r: FaceRail,
  index: number,
  routes: ReadonlyMap<string, RailRoute>,
  embedding: ReadonlyMap<string, readonly Dart[]>,
  fine = false,
  via?: "top" | "bottom"
): RailRoute | undefined {
  // A loop from a port back into it leaves and rejoins one run.
  const same = portKey(r.from) === portKey(r.to);
  const drawn = [...routes].map(([id, route]) => ({
    rail: byIndex(o, id),
    points: route.points,
  }));
  const [srcLo, srcHi] = slotBounds(o, r.from, 2 * index, routes, embedding);
  const [dstLo, dstHi] = slotBounds(o, r.to, 2 * index + 1, routes, embedding);
  const os = OUTWARD[r.from.side];
  const ot = OUTWARD[r.to.side];
  // The normal pass peels off a run no nearer the part than half a stub,
  // leaving the sliver inside for a later rail that must peel earlier; the
  // fine retry may use that sliver.
  const lead = fine ? 1.25 : 2;
  const minPeel = fine ? lead + 0.6 : o.stub / 2;
  const start: Point = [
    r.from.border[0] + os[0] * lead,
    r.from.border[1] + os[1] * lead,
  ];
  const goal: Point = [
    r.to.border[0] + ot[0] * lead,
    r.to.border[1] + ot[1] * lead,
  ];

  // Opening runs of drawn rails at this rail's two ports may be shared.
  const runsAt = (end: FaceEnd) =>
    drawn.flatMap(({ rail, points }) =>
      [
        portKey(rail.from) === portKey(end)
          ? portRun(points, rail.from)
          : undefined,
        portKey(rail.to) === portKey(end)
          ? portRun([...points].reverse(), rail.to)
          : undefined,
      ]
        .filter((x): x is [Point, Point] => x !== undefined)
        .map((run) => ({ id: rail.id, run }))
    );
  const srcRuns = runsAt(r.from);
  const dstRuns = runsAt(r.to);
  const drawnSegments = drawn.flatMap(({ rail, points }) =>
    segmentsOf(points).map((s) => ({ id: rail.id, s }))
  );
  const labels = drawn.flatMap(({ rail }) => {
    const route = routes.get(rail.id)!;
    return rail.label && route.labelAt
      ? [o.labelBox(route.labelAt, rail.label)]
      : [];
  });
  const parts = o.parts.map((e) => ({
    x0: e.x0 - 1,
    y0: e.y0 - 1,
    x1: e.x1 + 1,
    y1: e.y1 + 1,
  }));
  const soft = [...o.soft, ...labels];

  // Grid: every obstacle coordinate, comfortable offsets from them, and a
  // line inside every gap between two obstacle coordinates.
  const hard: number[][] = [[], []];
  const extra: number[][] = [[], []];
  // Rails keep a halo from every part except along their own port runs, so
  // a gap beside a part is always wide enough for another rail.
  const halos = parts.map((b) => ({
    x0: b.x0 - HALO,
    y0: b.y0 - HALO,
    x1: b.x1 + HALO,
    y1: b.y1 + HALO,
  }));
  const ownRun = (p: Point) =>
    [r.from, r.to].some((e) => {
      const d = OUTWARD[e.side];
      return (
        Math.abs(dot(sub(p, e.at), firstSide(d))) < 0.01 &&
        dot(sub(p, e.border), d) >= -0.01
      );
    });
  for (const b of [...parts, ...halos]) {
    hard[0].push(b.x0, b.x1);
    hard[1].push(b.y0, b.y1);
    extra[0].push(b.x0 - o.stub, b.x1 + o.stub);
    extra[1].push(b.y0 - o.stub, b.y1 + o.stub);
  }
  for (const b of soft) {
    extra[0].push(b.x0 - 2, b.x1 + 2);
    extra[1].push(b.y0 - 2, b.y1 + 2);
  }
  for (const {
    s: [a, b],
  } of drawnSegments)
    for (const p of [a, b])
      for (const k of [0, 1]) {
        hard[k].push(p[k]);
        extra[k].push(p[k] - o.gap, p[k] + o.gap);
      }
  // Every other used port keeps its opening clear out to half a stub: a
  // rail squeezed between a port and its opening would wall the port in.
  const mine = new Set([portKey(r.from), portKey(r.to)]);
  const openings = new Map<string, [Point, Point]>();
  for (const q of o.rails)
    for (const e of [q.from, q.to])
      if (!mine.has(portKey(e)) && !openings.has(portKey(e))) {
        const d = OUTWARD[e.side];
        openings.set(portKey(e), [
          e.border,
          [
            e.border[0] + d[0] * (o.stub / 2),
            e.border[1] + d[1] * (o.stub / 2),
          ],
        ]);
      }
  for (const [a, b] of openings.values())
    for (const p of [a, b]) for (const k of [0, 1]) hard[k].push(p[k]);
  // Lines where peeling off (or joining) first becomes allowed.
  const limit = (e: FaceEnd, d: Point): Point => [
    e.border[0] + d[0] * minPeel,
    e.border[1] + d[1] * minPeel,
  ];
  for (const p of [
    start,
    goal,
    r.from.at,
    r.to.at,
    limit(r.from, os),
    limit(r.to, ot),
  ])
    for (const k of [0, 1]) hard[k].push(p[k]);
  // Lines keep CLEAR from every obstacle coordinate, so two parallel rails
  // are never within the collinearity tolerance of each other.
  const CLEAR = 0.6;
  const lines = [0, 1].map((k) => {
    const base = uniq(hard[k]);
    const clear = (v: number) =>
      !base.some((h) => Math.abs(h - v) < CLEAR && Math.abs(h - v) > 0.01);
    const all = uniq([...base, ...extra[k].filter(clear)]);
    const lo = all[0] - 3 * o.gap;
    const hi = all.at(-1)! + 3 * o.gap;
    const out = [...all, lo, lo + o.gap, hi, hi - o.gap];
    // A cramped gap gets a line only on the fine retry: a rail squeezed in
    // there beats a crossing, but not a roomier detour.
    const least = fine ? 2 * CLEAR : 4;
    for (let i = 1; i < base.length; i++) {
      const [a, b] = [base[i - 1], base[i]];
      if (b - a > least && !all.some((v) => v >= a + CLEAR && v <= b - CLEAR))
        out.push((a + b) / 2);
    }
    return uniq(out);
  });
  const [xs, ys] = lines;
  const W = xs.length;
  const H = ys.length;
  const find = (v: number[], n: number) =>
    v.findIndex((x) => Math.abs(x - n) < 0.01);
  const sx = find(xs, start[0]);
  const sy = find(ys, start[1]);
  const gx = find(xs, goal[0]);
  const gy = find(ys, goal[1]);
  if (sx < 0 || sy < 0 || gx < 0 || gy < 0) return undefined;

  const onSegment = (p: Point, [a, b]: readonly [Point, Point]) =>
    p[0] >= Math.min(a[0], b[0]) - 0.01 &&
    p[0] <= Math.max(a[0], b[0]) + 0.01 &&
    p[1] >= Math.min(a[1], b[1]) - 0.01 &&
    p[1] <= Math.max(a[1], b[1]) + 0.01;
  const strictlyInside = (p: Point, b: Box) =>
    b.x0 < p[0] && p[0] < b.x1 && b.y0 < p[1] && p[1] < b.y1;
  // 0 free, 1 only on a shareable source run, 2 only on a target run, 3 blocked.
  // Every obstacle edge is a grid line, so obstacles rasterize by index range.
  const cell = new Uint8Array(W * H);
  const first = (v: number[], n: number) => {
    let lo = 0;
    let hi = v.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (v[mid] < n - 0.01) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const cover = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    each: (at: number, p: Point) => void
  ) => {
    for (let iy = first(ys, y0); iy < H && ys[iy] <= y1 + 0.01; iy++)
      for (let ix = first(xs, x0); ix < W && xs[ix] <= x1 + 0.01; ix++)
        each(iy * W + ix, [xs[ix], ys[iy]]);
  };
  // On a part's (padded) edge counts as touching it: a rail run along an
  // edge would seal the gap between them and split a face.
  for (const b of parts)
    cover(b.x0, b.y0, b.x1, b.y1, (at) => {
      cell[at] = 3;
    });
  for (const b of halos)
    cover(b.x0, b.y0, b.x1, b.y1, (at, p) => {
      if (!ownRun(p)) cell[at] = 3;
    });
  const bounds = ([a, b]: readonly [Point, Point]) =>
    [
      Math.min(a[0], b[0]),
      Math.min(a[1], b[1]),
      Math.max(a[0], b[0]),
      Math.max(a[1], b[1]),
    ] as const;
  for (const segment of openings.values())
    cover(...bounds(segment), (at) => {
      cell[at] = 3;
    });
  const through = new Map<number, Set<string>>();
  for (const { id, s: segment } of drawnSegments)
    cover(...bounds(segment), (at) => {
      if (cell[at] === 3) return;
      const ids = through.get(at) ?? new Set<string>();
      ids.add(id);
      through.set(at, ids);
    });
  // Shareable only if every rail through p is one whose opening run at this
  // port contains p (p may be that rail's corner where it peels off).
  const shared = (
    p: Point,
    ids: Set<string>,
    runs: { id: string; run: [Point, Point] }[]
  ) =>
    [...ids].every((id) =>
      runs.some((x) => x.id === id && onSegment(p, x.run))
    );
  for (const [at, ids] of through) {
    const p: Point = [xs[at % W], ys[Math.floor(at / W)]];
    cell[at] =
      shared(p, ids, srcRuns) && !same ? 1 : shared(p, ids, dstRuns) ? 2 : 3;
  }
  // Step penalties, memoized per grid step (index of its lower end).
  const across = new Float64Array(W * H).fill(-1);
  const down = new Float64Array(W * H).fill(-1);
  const stepPenalty = (ix: number, iy: number, nx: number, ny: number) => {
    const memo = iy === ny ? across : down;
    const at = Math.min(iy, ny) * W + Math.min(ix, nx);
    if (memo[at] < 0) memo[at] = penalty([xs[ix], ys[iy]], [xs[nx], ys[ny]]);
    return memo[at];
  };
  const penalty = (a: Point, b: Point) => {
    const len = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
    const m: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const horizontal = Math.abs(a[1] - b[1]) < SNAP;
    // Beside a drawn rail but closer than CLEAR reads as the same line.
    const alongside = (lo: number, hi: number) =>
      drawnSegments.some(({ s: [p, q] }) => {
        const parallel = horizontal
          ? Math.abs(p[1] - q[1]) < SNAP
          : Math.abs(p[0] - q[0]) < SNAP;
        if (!parallel) return false;
        const k = horizontal ? 1 : 0;
        const d = Math.abs(p[k] - m[k]);
        const j = 1 - k;
        return (
          d >= lo &&
          d < hi &&
          Math.min(p[j], q[j]) < Math.max(a[j], b[j]) &&
          Math.min(a[j], b[j]) < Math.max(p[j], q[j])
        );
      });
    if (alongside(0.01, CLEAR)) return Infinity;
    let extraCost = 0;
    if (soft.some((box) => strictlyInside(m, box))) extraCost += OVER * len;
    const near =
      drawnSegments.some(({ s: [p, q] }) => {
        const parallel = horizontal
          ? Math.abs(p[1] - q[1]) < SNAP
          : Math.abs(p[0] - q[0]) < SNAP;
        if (!parallel) return false;
        const k = horizontal ? 1 : 0;
        const d = Math.abs(p[k] - m[k]);
        if (d < SNAP || d > o.gap - SNAP) return false;
        const j = 1 - k;
        return (
          Math.min(p[j], q[j]) < Math.max(a[j], b[j]) &&
          Math.min(a[j], b[j]) < Math.max(p[j], q[j])
        );
      }) ||
      parts.some((box) => {
        const grown = {
          x0: box.x0 - o.stub + SNAP,
          y0: box.y0 - o.stub + SNAP,
          x1: box.x1 + o.stub - SNAP,
          y1: box.y1 + o.stub - SNAP,
        };
        return strictlyInside(m, grown);
      });
    if (near) extraCost += NEAR * len;
    return extraCost;
  };

  // A start or goal on another rail is walled in on this grid.
  if (cell[sy * W + sx] === 3 || cell[gy * W + gx] === 3) return undefined;

  // Port-ray geometry.
  const srcT = (p: Point) => dot(sub(p, r.from.at), os);
  const dstT = (p: Point) => dot(sub(p, r.to.at), ot);
  const onSrcRay = (p: Point) =>
    Math.abs(dot(sub(p, r.from.at), firstSide(os))) < 0.01 &&
    srcT(p) >= srcT(start) - 0.01;
  const onDstRay = (p: Point) =>
    Math.abs(dot(sub(p, r.to.at), firstSide(ot))) < 0.01 &&
    dstT(p) >= dstT(goal) - 0.01;
  const inward: Point = [-ot[0], -ot[1]];
  const srcRoom = (p: Point) => srcT(p) - srcT(r.from.border) >= minPeel - 0.01;
  const dstRoom = (p: Point) => dstT(p) - dstT(r.to.border) >= minPeel - 0.01;
  const moveIndex = (d: Point) =>
    MOVES.findIndex((m) => m[0] === d[0] && m[1] === d[1]);
  const outIndex = moveIndex(os);
  const inIndex = moveIndex(inward);
  const srcKey = (p: Point, d: Point) =>
    dot(d, firstSide(os)) > 0 ? srcT(p) : 2 * BIG - srcT(p);
  // Joining the target run at p while moving along d: the side it came from.
  const dstKey = (p: Point, d: Point) =>
    dot(d, firstSide(ot)) < 0 ? dstT(p) : 2 * BIG - dstT(p);

  // State: (cell, heading). Heading 0: still on the source run, never turned.
  // One extra state past the grid: arrived at the port.
  const S = W * H * 5;
  const done = S;
  const cost = new Float64Array(S + 1).fill(Infinity);
  const from = new Int32Array(S + 1).fill(-1);
  const heap = new Heap();
  const at = (ix: number, iy: number, h: number) => (iy * W + ix) * 5 + h;
  const remaining = (ix: number, iy: number) =>
    aim >= 0
      ? Math.abs(ys[iy] - ys[aim])
      : Math.abs(xs[ix] - goal[0]) + Math.abs(ys[iy] - goal[1]);
  let aim = -1;
  let last = -1;
  /** Best path from a start state to the port, joining in (dstLo, dstHi),
   * or, given `until`, to any cell on that grid row. */
  const search = (
    first: number,
    firstCost: number,
    dstLo: number,
    dstHi: number,
    until = -1
  ): Point[] | undefined => {
    aim = until;
    cost.fill(Infinity);
    from.fill(-1);
    heap.clear();
    {
      const h = first % 5;
      const n = (first - h) / 5;
      cost[first] = firstCost;
      heap.push(firstCost + remaining(n % W, (n - (n % W)) / W), first);
    }
    let reached = -1;
    while (heap.size) {
      const priority = heap.topPriority();
      const k = heap.pop();
      const c = cost[k];
      if (k === done) {
        reached = from[done];
        break;
      }
      const h = k % 5;
      const n = (k - h) / 5;
      const ix = n % W;
      const iy = (n - ix) / W;
      if (priority > c + remaining(ix, iy) + 1e-9) continue;
      if (until >= 0) {
        if (iy === until && h !== 0) {
          reached = k;
          break;
        }
      }
      const p: Point = [xs[ix], ys[iy]];
      const heading = h === 0 ? os : MOVES[h - 1];
      const joined = h - 1 === inIndex && onDstRay(p);
      if (
        until < 0 &&
        ix === gx &&
        iy === gy &&
        h === 0 &&
        srcLo < BIG &&
        BIG < srcHi &&
        dstLo < BIG &&
        BIG < dstHi &&
        c < cost[done]
      ) {
        // Straight from port to facing port.
        cost[done] = c;
        from[done] = k;
        heap.push(c, done);
      }
      if (
        until < 0 &&
        ix === gx &&
        iy === gy &&
        h !== 0 &&
        h - 1 !== moveIndex(ot)
      ) {
        // Arriving across the run (not along it) joins it right here.
        // Turning into the port from across its run is a bend too.
        const total = joined
          ? c
          : dstRoom(p) &&
              dstLo < dstKey(p, heading) &&
              dstKey(p, heading) < dstHi
            ? c + BEND
            : Infinity;
        if (total < cost[done]) {
          cost[done] = total;
          from[done] = k;
          heap.push(total, done);
        }
      }
      for (let m = 0; m < 4; m++) {
        const d = MOVES[m];
        if (d[0] === -heading[0] && d[1] === -heading[1]) continue;
        // On the target run (or having just stepped onto it across a shared
        // stretch) the only way on is inward to the port.
        // (Still on the source run counts too: facing ports share a line.)
        const pending = !joined && cell[iy * W + ix] === 2;
        if ((joined || pending) && m !== inIndex) continue;
        const nx = ix + d[0];
        const ny = iy + d[1];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const q: Point = [xs[nx], ys[ny]];
        const straightOut = h === 0 && m === outIndex;
        const nh = straightOut ? 0 : m + 1;
        // Peeling off the source run must land in the source slot.
        if (h === 0 && !straightOut) {
          const key = srcKey(p, d);
          if (!srcRoom(p) || !(srcLo < key && key < srcHi)) continue;
        }
        // Turning onto the target run must enter the target slot.
        const state = cell[ny * W + nx];
        const nowJoined = m === inIndex && onDstRay(q) && onDstRay(p);
        // Going straight out of the source along a facing target's line
        // joins it only on stepping onto that target's shared run.
        if (nowJoined && !joined && (h !== 0 || state === 2) && !pending) {
          const key = h === 0 ? BIG : dstKey(p, heading);
          if (!dstRoom(p) || !(dstLo < key && key < dstHi)) continue;
          if (h === 0 && !(srcLo < BIG && BIG < srcHi)) continue;
        }
        if (state === 3) continue;
        if (state === 1 && !(nh === 0 && onSrcRay(q))) continue;
        if (state === 2 && !(nowJoined || joined || pending)) {
          // Stepping across onto a shared target run joins it there, in the slot.
          if (m === inIndex || m === moveIndex(ot) || !onDstRay(q)) continue;
          const key = dstKey(q, d);
          if (!dstRoom(q) || !(dstLo < key && key < dstHi)) continue;
        }
        const nc =
          c +
          Math.abs(q[0] - p[0]) +
          Math.abs(q[1] - p[1]) +
          (nh !== h && !(h === 0 && m === outIndex) && !(h === 0 && nh === 0)
            ? BEND
            : 0) +
          stepPenalty(ix, iy, nx, ny);
        const nk = at(nx, ny, nh);
        if (nc < cost[nk]) {
          cost[nk] = nc;
          from[nk] = k;
          heap.push(nc + remaining(nx, ny), nk);
        }
      }
    }
    if (reached < 0) {
      return undefined;
    }
    last = reached;
    const path: Point[] = [];
    for (let k = reached; k >= 0; k = from[k]) {
      const n = (k - (k % 5)) / 5;
      path.push([xs[n % W], ys[Math.floor(n / W)]]);
    }
    return path.reverse();
  };

  /** A search, or with `via` one out to the outer lane and one home that
   * may not touch the way out. */
  const travel = (
    first: number,
    firstCost: number,
    lo: number,
    hi: number
  ): Point[] | undefined => {
    if (!via) return search(first, firstCost, lo, hi);
    const out = search(first, firstCost, lo, hi, via === "top" ? 1 : H - 2);
    if (!out) return undefined;
    const lane = last;
    const saved = cell.slice();
    for (const [x, y] of out.slice(0, -1))
      cell[find(ys, y) * W + find(xs, x)] = 3;
    const home = search(lane, 0, lo, hi);
    cell.set(saved);
    return home && [...out, ...home.slice(1)];
  };
  let path: Point[] | undefined;
  if (!same) path = travel(at(sx, sy, 0), 0, dstLo, dstHi);
  else {
    // Choose where the loop peels off the run, nearest a comfortable stub
    // first, then search home; its own two ends keep their order too.
    const order = embedding.get(portKey(r.from)) ?? [];
    const srcFirst = order.indexOf(2 * index) < order.indexOf(2 * index + 1);
    const along = MOVES.findIndex((m) => m[0] === os[0] && m[1] === os[1]);
    const peels: { cell: number; t: number; at: Point; key: number }[] = [];
    for (let ix = sx, iy = sy; ix >= 0 && iy >= 0 && ix < W && iy < H; ) {
      const c = cell[iy * W + ix];
      if (c === 3) break;
      const pt: Point = [xs[ix], ys[iy]];
      for (const side of [1, -1]) {
        const f = firstSide(os);
        const d: Point = [f[0] * side, f[1] * side];
        const key = side > 0 ? srcT(pt) : 2 * BIG - srcT(pt);
        if (!srcRoom(pt) || !(srcLo < key && key < srcHi)) continue;
        const [nx, ny] = [ix + d[0], iy + d[1]];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        if (cell[ny * W + nx] !== 0) continue;
        peels.push({
          cell: at(
            nx,
            ny,
            MOVES.findIndex((m) => m[0] === d[0] && m[1] === d[1]) + 1
          ),
          t: srcT(pt),
          at: pt,
          key,
        });
      }
      ix += MOVES[along][0];
      iy += MOVES[along][1];
    }
    const comfortable = srcT(start) + o.stub;
    peels.sort(
      (a, b) => Math.abs(a.t - comfortable) - Math.abs(b.t - comfortable)
    );
    for (const peel of peels.slice(0, 8)) {
      const lo = srcFirst ? Math.max(dstLo, peel.key) : dstLo;
      const hi = srcFirst ? dstHi : Math.min(dstHi, peel.key);
      const found = travel(peel.cell, peel.t + o.gap + BEND, lo, hi);
      if (found) {
        path = [start, peel.at, ...found];
        break;
      }
    }
  }
  if (!path) {
    return undefined;
  }
  const points = simplify([
    r.from.at,
    r.from.border,
    ...path,
    r.to.border,
    r.to.at,
  ]);
  const obstacles = [
    ...o.parts,
    ...o.soft,
    ...labels,
    ...drawnSegments.map(({ s: [a, b] }) => ({
      x0: Math.min(a[0], b[0]),
      y0: Math.min(a[1], b[1]),
      x1: Math.max(a[0], b[0]),
      y1: Math.max(a[1], b[1]),
    })),
  ];
  const labelAt = r.label
    ? (o.placeLabel(points, r.label, obstacles) ??
      o.placeLabel(points, r.label, [...o.parts, ...o.soft, ...labels]))
    : undefined;
  return { points, ...(labelAt ? { labelAt } : {}) };
}

function byIndex(o: FaceRouting, id: string): FaceRail {
  return o.rails.find((r) => r.id === id)!;
}

/** Drop repeated points and points in the middle of a straight run. */
function simplify(points: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out.at(-1);
    if (
      last &&
      Math.abs(last[0] - p[0]) < 0.01 &&
      Math.abs(last[1] - p[1]) < 0.01
    )
      continue;
    const prev = out.at(-2);
    if (
      prev &&
      last &&
      ((Math.abs(prev[0] - last[0]) < 0.01 &&
        Math.abs(last[0] - p[0]) < 0.01) ||
        (Math.abs(prev[1] - last[1]) < 0.01 && Math.abs(last[1] - p[1]) < 0.01))
    )
      out.pop();
    out.push(p);
  }
  return out;
}

/** A binary min-heap of (priority, value) pairs in parallel arrays. */
class Heap {
  private readonly p: number[] = [];
  private readonly v: number[] = [];
  get size() {
    return this.v.length;
  }
  topPriority() {
    return this.p[0];
  }
  push(priority: number, value: number) {
    const { p, v } = this;
    let i = v.length;
    p.push(priority);
    v.push(value);
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (p[up] <= p[i]) break;
      [p[up], p[i]] = [p[i], p[up]];
      [v[up], v[i]] = [v[i], v[up]];
      i = up;
    }
  }
  clear() {
    this.p.length = 0;
    this.v.length = 0;
  }
  pop(): number {
    const { p, v } = this;
    const top = v[0];
    const lp = p.pop()!;
    const lv = v.pop()!;
    if (v.length) {
      p[0] = lp;
      v[0] = lv;
      for (let i = 0; ; ) {
        const l = 2 * i + 1;
        const rr = l + 1;
        let m = i;
        if (l < v.length && p[l] < p[m]) m = l;
        if (rr < v.length && p[rr] < p[m]) m = rr;
        if (m === i) break;
        [p[m], p[i]] = [p[i], p[m]];
        [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return top;
  }
}

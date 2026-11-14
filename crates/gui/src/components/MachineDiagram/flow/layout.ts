/**
 * Auto-layout for flow diagrams with elkjs (layered, left to right). The
 * compiler is synchronous and ELK is not, so layout runs between two
 * compiles: the first (row fallback) gives each part's real geometry —
 * frame, ports, gates, status texts, change tab — and the second places the
 * parts and routes the rails from the ELK result through `layoutFrom`.
 *
 * - Each part is a node the size of its extent in every arrangement, so
 *   Before and After share positions and labels never reach a neighbour.
 * - Ports are fixed where the part draws them; rails leave and enter there.
 * - The first unconditional rail out of a part is the main rail and is kept
 *   straight; other branches drop below it in spec order (crossing
 *   minimization is off, so the spec's order is the vertical order).
 * - Rails that run back against the flow are routed after ELK, as return
 *   rails in local top/bottom channels. Each leg searches between parts and
 *   earlier rails. A rail with no clean route falls back to a lane below
 *   everything; layout never fails on routing.
 * - Crossings left after that are removed topology-first when the port order
 *   admits a planar embedding (faceRouter): choose the embedding, then draw
 *   each rail inside its face. Only crossings that no drawing can avoid
 *   remain, and they are drawn with jumps.
 * - Compatible corridors use separate offset bus tracks. Remaining crossings
 *   carry hops shared by drawing and card motion.
 * - A labelled rail that ELK lifts over its neighbours to reach its label
 *   slot is redrawn as one step between its ports (a fork off a shared port).
 * - Regions are compound nodes with the root's spacing; rail labels are ELK
 *   edge labels.
 * - Parts with a hand-given position keep it, and rails touching them keep
 *   the compiler's `railBetween` route. Each drill-down level is laid out
 *   on its own.
 */
import { compatible, routeByTopology } from "./faceRouter";
import { groupBundles, offsetBusTracks, type BusCandidate } from "./bus";
import { planReturnLanes } from "./lanePlanner";
import { crossingJumps, railCrossings } from "./crossings";
import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk.bundled.js";
import { elk } from "../../../hooks/useElkLayout";
import type { Point, PortSide } from "../route";
import {
  compileFlow,
  rowLayout,
  type CompileOptions,
  type CompileResult,
  type CompiledFlow,
  type DiagramPart,
  type DiagramRail,
  type DiagramTimeline,
  type LayoutFn,
  type LevelLayout,
  type RailRoute,
} from "./compile";
import {
  LINE_EM,
  RAIL_LABEL_DY,
  RAIL_LABEL_SIZE,
  REGION_HEAD,
  REGION_PAD,
  partExtentLocal,
  regionLabels,
  railLabelText,
  pad,
  textWidth,
  union,
  type Box,
} from "./extent";
import type { Position } from "./spec";

/** A layout for every level of a flow: drill-downs keyed by the part drilled into. */
export interface FlowLayout extends LevelLayout {
  readonly drills?: Readonly<Record<string, FlowLayout>>;
}

/** Space between parts in one layer, and between layers. */
export const NODE_GAP = 48;
export const LAYER_GAP = 112;
/** Margin around the whole diagram. */
export const DIAGRAM_PAD = 40;
/** Clearance of a return channel from its span. */
export const LANE_GAP = 40;
export const LANE_STEP = 56;
/** How far a return rail leaves its port before turning. */
export const LANE_STUB = 20;
const LABEL_PAD_X = 12;
/** Space between parallel rails (ELK edge-edge spacing). */
export const RAIL_GAP = 20;
const LABEL_PAD_Y = 4;
/** Straightness priority of a part's main rail. */
const MAIN_RAIL_PRIORITY = "10";

const ELK_SIDE: Record<PortSide, string> = {
  W: "WEST",
  E: "EAST",
  N: "NORTH",
  S: "SOUTH",
};
const OUTWARD: Record<PortSide, Point> = {
  W: [-1, 0],
  E: [1, 0],
  N: [0, -1],
  S: [0, 1],
};

/** Spacing for the root and every region, which ELK does not inherit. */
const SPACING: Record<string, string> = {
  "elk.spacing.nodeNode": String(NODE_GAP),
  "elk.layered.spacing.nodeNodeBetweenLayers": String(LAYER_GAP),
  "elk.spacing.edgeNode": "24",
  "elk.spacing.edgeEdge": String(RAIL_GAP),
  "elk.spacing.edgeLabel": "4",
  "elk.layered.spacing.edgeNodeBetweenLayers": "24",
};

const portId = (part: string, port: string) => `${part}.${port}`;
const regionNodeId = (region: string) => `region:${region}`;

interface PartNode {
  readonly part: DiagramPart;
  /** Extent relative to the cell's top-left, over every arrangement. */
  readonly extent: Box;
  readonly given: boolean;
}

/** Rails reversed by ELK MODEL_ORDER, including self-loops and acyclic backward edges.
 * Remove these before ELK so our router owns every return, even between regions.
 */
export function returnRails(
  parts: readonly { id: string }[],
  rails: readonly { id: string; from: string; to: string }[]
): Set<string> {
  const order = new Map(parts.map((p, i) => [p.id, i]));
  return new Set(
    rails.filter((r) => order.get(r.to)! <= order.get(r.from)!).map((r) => r.id)
  );
}

/** Whether any part at any level waits for auto-layout. */
export function needsAutoLayout(flow: CompiledFlow): boolean {
  return flow.arrangements[0].parts.some(
    (p) =>
      p.positioned === "layout" ||
      (p.drill?.kind === "inline" && needsAutoLayout(p.drill.flow))
  );
}

/** Lay out every level of a compiled flow. */
export interface FlowLayoutOptions {
  /** Bypass value memoization for independent ELK/replay verification. */
  readonly cache?: boolean;
}

export async function layoutFlow(
  flow: CompiledFlow,
  options: FlowLayoutOptions = {}
): Promise<FlowLayout> {
  const level = await layoutLevel(flow.arrangements, options.cache !== false);
  const drills: Record<string, FlowLayout> = {};
  for (const p of flow.arrangements[0].parts)
    if (p.drill?.kind === "inline")
      drills[p.id] = await layoutFlow(p.drill.flow, options);
  return Object.keys(drills).length ? { ...level, drills } : level;
}

/** A synchronous `LayoutFn` that replays a precomputed layout. */
export function layoutFrom(layout: FlowLayout): LayoutFn {
  return (parts, rails, path) => {
    let at: FlowLayout | undefined = layout;
    for (const id of path) at = at?.drills?.[id];
    return at ?? rowLayout(parts, rails, path);
  };
}

/**
 * Compile a spec and auto-lay out the parts without a position. A spec
 * whose parts are all placed by hand compiles once, as `compileFlow` would.
 */
export async function compileFlowLaidOut(
  input: unknown,
  o: Omit<CompileOptions, "layout"> = {}
): Promise<CompileResult> {
  const first = compileFlow(input, o);
  if (!first.ok || !needsAutoLayout(first.flow)) return first;
  const layout = await layoutFlow(first.flow);
  return compileFlow(input, { ...o, layout: layoutFrom(layout) });
}

/** Text reserved by ELK and the router across the shared arrangement geometry. */
function longestRailLabel(
  arrangements: readonly DiagramTimeline[],
  id: string
): string | undefined {
  return arrangements
    .map((d) => {
      const rail = d.rails.find((r) => r.id === id);
      return rail && rail.presence !== "absent"
        ? railLabelText(rail)
        : undefined;
    })
    .reduce<string | undefined>(
      (a, b) => (b !== undefined && b.length > (a?.length ?? -1) ? b : a),
      undefined
    );
}

const levelCache = new Map<string, Promise<LevelLayout>>();

/** Forget every memoized level layout (test isolation and hot reload). */
export function resetLayoutCache(): void {
  levelCache.clear();
}

if (import.meta.hot) import.meta.hot.dispose(resetLayoutCache);

async function layoutLevel(
  arrangements: readonly DiagramTimeline[],
  useCache: boolean
): Promise<LevelLayout> {
  if (!useCache) return computeLevel(arrangements);
  const first = arrangements[0];
  // This is a value cache, not a spec/project cache: every input read by the
  // geometry engine is represented, while bands, captions and card payloads
  // are intentionally left to the compiler. Drill-downs are cached separately.
  const key = JSON.stringify([
    first.parts.map((p) => [
      p.id,
      p.scale,
      p.positioned,
      p.positioned === "given" ? [p.position.x, p.position.y] : null,
      Object.entries(p.ports).map(([id, port]) => [
        id,
        port.side,
        ...port.local,
      ]),
      union(
        arrangements.map((d) =>
          partExtentLocal(d.parts.find((q) => q.id === p.id)!)
        )
      ),
    ]),
    first.rails.map((r) => [
      r.id,
      r.from,
      r.to,
      r.conditional,
      longestRailLabel(arrangements, r.id),
    ]),
    first.regions.map((r) => [r.id, r.label, r.parts]),
  ]);
  const cached = levelCache.get(key);
  if (cached) {
    levelCache.delete(key);
    levelCache.set(key, cached);
    return cached;
  }
  const pending = computeLevel(arrangements).catch((error: unknown) => {
    if (levelCache.get(key) === pending) levelCache.delete(key);
    throw error;
  });
  if (levelCache.size >= 64) levelCache.delete(levelCache.keys().next().value!);
  levelCache.set(key, pending);
  return pending;
}

async function computeLevel(
  arrangements: readonly DiagramTimeline[]
): Promise<LevelLayout> {
  const first = arrangements[0];
  // Leg searches are pure; repair passes ask the same questions many times.
  const leg = memoizedLegs();
  if (first.parts.every((p) => p.positioned === "given"))
    return { positions: {} };
  const nodes = new Map<string, PartNode>(
    first.parts.map((p) => [
      p.id,
      {
        part: p,
        extent: union(
          arrangements.map((d) =>
            partExtentLocal(d.parts.find((q) => q.id === p.id)!)
          )
        ),
        given: p.positioned === "given",
      },
    ])
  );
  const rails = first.rails;
  const back = returnRails(
    first.parts,
    rails.map((r) => ({ id: r.id, from: r.from.part, to: r.to.part }))
  );
  const forward = rails.filter((r) => !back.has(r.id));
  // A rail's label can differ between arrangements (an added rail only
  // carries its "+" in After); reserve room for the longest one.
  const labelOf = (id: string) => longestRailLabel(arrangements, id);

  const graph = elkGraph(nodes, forward, first, labelOf);
  const laid = await elk.layout(graph);

  /* positions */
  const abs = new Map<string, { x: number; y: number }>();
  const walk = (n: ElkNode, ox: number, oy: number) => {
    for (const c of n.children ?? []) {
      const x = ox + (c.x ?? 0);
      const y = oy + (c.y ?? 0);
      abs.set(c.id, { x, y });
      walk(c, x, y);
    }
  };
  walk(laid, 0, 0);
  const cells = new Map<string, Position>();
  for (const [id, n] of nodes) {
    if (n.given) {
      cells.set(id, n.part.position);
      continue;
    }
    const at = abs.get(id)!;
    cells.set(id, { x: at.x - n.extent.x0, y: at.y - n.extent.y0 });
  }
  const positions: Record<string, Position> = {};
  for (const [id, n] of nodes) if (!n.given) positions[id] = cells.get(id)!;

  /* rails */
  const portAt = (part: string, port: string): Point => {
    const n = nodes.get(part)!;
    const c = cells.get(part)!;
    const [x, y] = n.part.ports[port].local;
    return [c.x + x * n.part.scale, c.y + y * n.part.scale];
  };
  /** Where the port meets the node's border (the rail's stub runs from the port to it). */
  const borderAt = (part: string, port: string): Point => {
    const n = nodes.get(part)!;
    const c = cells.get(part)!;
    const [px, py] = portAt(part, port);
    const e = n.extent;
    switch (n.part.ports[port].side) {
      case "W":
        return [c.x + e.x0, py];
      case "E":
        return [c.x + e.x1, py];
      case "N":
        return [px, c.y + e.y0];
      case "S":
        return [px, c.y + e.y1];
    }
  };
  const routes: Record<string, RailRoute> = {};
  const touchesGiven = (r: DiagramRail) =>
    nodes.get(r.from.part)!.given || nodes.get(r.to.part)!.given;
  const edges = collectEdges(laid);
  for (const r of forward) {
    if (touchesGiven(r)) continue;
    const e = edges.get(r.id);
    const section = e?.edge.sections?.[0];
    if (!e || !section) continue;
    const [ox, oy] = e.offset;
    const mid = [
      section.startPoint,
      ...(section.bendPoints ?? []),
      section.endPoint,
    ].map((p): Point => [ox + p.x, oy + p.y]);
    const label = e.edge.labels?.[0];
    routes[r.id] = {
      points: dedupe([
        portAt(r.from.part, r.from.port),
        ...mid,
        portAt(r.to.part, r.to.port),
      ]),
      ...(label
        ? {
            labelAt: [
              ox + (label.x ?? 0) + (label.width ?? 0) / 2,
              oy + (label.y ?? 0) + (label.height ?? 0) / 2,
            ] as Point,
          }
        : {}),
    };
  }

  /* detours: a rail that climbs over or dips under its neighbours to reach
     its label slot is redrawn as one step down (or up) between its ports */
  const extentOf = (id: string): Box => {
    const n = nodes.get(id)!;
    const c = cells.get(id)!;
    return {
      x0: c.x + n.extent.x0,
      y0: c.y + n.extent.y0,
      x1: c.x + n.extent.x1,
      y1: c.y + n.extent.y1,
    };
  };
  const extents = [...nodes.keys()].map(extentOf);
  const regionHeaders = first.regions.flatMap((g) => {
    const b = pad(union(g.parts.map(extentOf)), REGION_PAD, REGION_HEAD);
    return regionLabels({
      ...g,
      x: b.x0,
      y: b.y0,
      width: b.x1 - b.x0,
      height: b.y1 - b.y0,
    });
  });
  for (const r of forward) {
    const route = routes[r.id];
    if (!route) continue;
    const z = straightened(route, {
      from: borderAt(r.from.part, r.from.port),
      to: borderAt(r.to.part, r.to.port),
      fromSide: nodes.get(r.from.part)!.part.ports[r.from.port].side,
      toSide: nodes.get(r.to.part)!.part.ports[r.to.port].side,
      label: labelOf(r.id),
      extents,
      others: forward
        .filter((q) => q.id !== r.id && routes[q.id])
        .map((q) => ({
          route: routes[q.id],
          label: labelOf(q.id),
          sharesSource:
            q.from.part === r.from.part && q.from.port === r.from.port,
        })),
    });
    if (z) routes[r.id] = z;
  }

  // Keep ELK's geometry unless it merges beyond a port-connected fork/join.
  // Use the same search and reservations as return legs for a conflicting rail.
  const accepted: DiagramRail[] = [];
  for (const r of forward) {
    const route = routes[r.id];
    if (!route) continue;
    const reserved = accepted.flatMap((q) =>
      reservedRuns(r, q, routes[q.id].points)
    );
    if (
      segments(route.points).some((s) =>
        reserved.some((t) => collinear(s, t))
      ) ||
      accepted.some((q) =>
        reservedRuns(q, r, route.points).some((s) =>
          segments(routes[q.id].points).some((t) => collinear(s, t))
        )
      )
    ) {
      const fromSide = nodes.get(r.from.part)!.part.ports[r.from.port].side;
      const toSide = nodes.get(r.to.part)!.part.ports[r.to.port].side;
      const bf = borderAt(r.from.part, r.from.port);
      const bt = borderAt(r.to.part, r.to.port);
      const labels = Object.entries(routes).flatMap(([id, q]) => {
        const text = labelOf(id);
        return text && q.labelAt ? [labelBox(q.labelAt, text)] : [];
      });
      const findPath = (stub: number) =>
        leg(
          [
            bf[0] + OUTWARD[fromSide][0] * stub,
            bf[1] + OUTWARD[fromSide][1] * stub,
          ],
          fromSide,
          union([...extents, ...labels]).y1 + LANE_GAP,
          [...extents, ...labels],
          reserved.flatMap((s) => verticalRuns(s)),
          reserved.filter(([a, b]) => Math.abs(a[1] - b[1]) < SNAP),
          {
            point: [
              bt[0] + OUTWARD[toSide][0] * stub,
              bt[1] + OUTWARD[toSide][1] * stub,
            ],
            side: toSide,
          }
        );
      // ELK can put a bend within one rail gap of the usual stub. Search
      // from just outside the padded node too, so that bend cannot box us in.
      const path = findPath(LANE_STUB) ?? findPath(2);
      if (path) {
        const points = dedupe([
          portAt(r.from.part, r.from.port),
          bf,
          ...path,
          bt,
          portAt(r.to.part, r.to.port),
        ]);
        const text = labelOf(r.id);
        const labelAt = text
          ? labelOnRoute(points, text, [
              ...extents,
              ...Object.entries(routes)
                .filter(([id]) => id !== r.id)
                .flatMap(([id, q]) => {
                  const label = labelOf(id);
                  return [
                    ...segments(q.points).map(segmentBox),
                    ...(label && q.labelAt ? [labelBox(q.labelAt, label)] : []),
                  ];
                }),
            ])
          : undefined;
        routes[r.id] = {
          points,
          ...(labelAt
            ? { labelAt }
            : route.labelAt
              ? { labelAt: route.labelAt }
              : {}),
        };
      }
    }
    accepted.push(r);
  }

  /* Return channels are local to each span; try the opposite channel and
     rip up the two legs together before permitting an explicit jumped crossing. */
  const returns = rails.filter((r) => back.has(r.id) && !touchesGiven(r));
  const plans = planReturnLanes(
    returns.map((r) => {
      const a = extentOf(r.from.part);
      const b = extentOf(r.to.part);
      const end = (endpoint: DiagramRail["from"]) => {
        const part = nodes.get(endpoint.part)!.part;
        const port = part.ports[endpoint.port];
        const axis = port.side === "N" || port.side === "S" ? 0 : 1;
        const ports = Object.entries(part.ports)
          .filter(([, p]) => p.side === port.side)
          .sort(([, p], [, q]) => p.local[axis] - q.local[axis]);
        return {
          part: endpoint.part,
          port: endpoint.port,
          side: port.side,
          order: ports.findIndex(([name]) => name === endpoint.port),
          count: ports.length,
        };
      };
      return {
        x0: Math.min(a.x0, b.x0),
        x1: Math.max(a.x1, b.x1),
        y0: Math.min(a.y0, b.y0),
        y1: Math.max(a.y1, b.y1),
        from: end(r.from),
        to: end(r.to),
      };
    }),
    LANE_GAP,
    RAIL_GAP
  );
  const routedReturns: DiagramRail[] = [];
  const sharesReserved = (
    r: DiagramRail,
    points: readonly Point[],
    others: readonly DiagramRail[]
  ) =>
    others.some(
      (q) =>
        reservedRuns(r, q, routes[q.id].points).some((s) =>
          segments(points).some((t) => collinear(s, t))
        ) ||
        reservedRuns(q, r, points).some((s) =>
          segments(routes[q.id].points).some((t) => collinear(s, t))
        )
    );
  /* One candidate policy for every return route and bus track, so the checks
     cannot drift apart: no doubling back, no part crossed (except a rail's
     own parts at its first and last segment), no reserved stretch shared,
     and, when strict, no crossing of any other rail. */
  const reverses = (points: readonly Point[]) =>
    points.some(
      (b, i) =>
        i > 0 &&
        i < points.length - 1 &&
        (b[0] - points[i - 1][0]) * (points[i + 1][0] - b[0]) +
          (b[1] - points[i - 1][1]) * (points[i + 1][1] - b[1]) <
          -1
    );
  const nodeIds = [...nodes.keys()];
  const throughPart = (
    r: DiagramRail,
    points: readonly Point[],
    includeGiven: boolean
  ) =>
    segments(points).some((seg, j) =>
      nodeIds.some(
        (id) =>
          (includeGiven || !nodes.get(id)!.given) &&
          !(j === 0 && id === r.from.part) &&
          !(j === points.length - 2 && id === r.to.part) &&
          crosses(segmentBox(seg), extentOf(id))
      )
    );
  const clearOf = (
    r: DiagramRail,
    points: readonly Point[],
    others: readonly DiagramRail[],
    strict: boolean
  ) =>
    !sharesReserved(r, points, others) &&
    !(
      strict &&
      others.some((q) => railCrossings(points, routes[q.id].points).length > 0)
    );
  const validCandidate = (
    r: DiagramRail,
    points: readonly Point[],
    others: readonly DiagramRail[],
    strict: boolean
  ) =>
    !reverses(points) &&
    !throughPart(r, points, false) &&
    clearOf(r, points, others, strict);
  const routeChannel = (
    r: DiagramRail,
    others: readonly DiagramRail[],
    strictOnly = false,
    switchChannel = false,
    forceLane = false
  ): RailRoute | undefined => {
    const fromSide = nodes.get(r.from.part)!.part.ports[r.from.port].side;
    const toSide = nodes.get(r.to.part)!.part.ports[r.to.port].side;
    const bf = borderAt(r.from.part, r.from.port);
    const bt = borderAt(r.to.part, r.to.port);
    const reserved = others.flatMap((q) =>
      reservedRuns(r, q, routes[q.id].points)
    );
    const verticals = reserved.flatMap((s) => verticalRuns(s));
    const horizontals = reserved.filter(
      ([a, b]) => Math.abs(a[1] - b[1]) < SNAP
    );
    const obstacles = [
      ...regionHeaders,
      ...[...nodes].filter(([, n]) => !n.given).map(([id]) => extentOf(id)),
      ...others.flatMap((q) => {
        const text = labelOf(q.id);
        const at = routes[q.id].labelAt;
        return text && at ? [labelBox(at, text)] : [];
      }),
    ];
    const occupied = union([
      ...extents,
      ...Object.values(routes).flatMap((q) =>
        q.points.map(([x, y]) => ({ x0: x, x1: x, y0: y, y1: y }))
      ),
    ]);
    const originalPlan = plans[returns.indexOf(r)] ?? {
      channel: "bottom",
      lane: union([extentOf(r.from.part), extentOf(r.to.part)]).y1 + LANE_GAP,
      fromDrop: 0,
      toDrop: 0,
    };
    const plan = switchChannel
      ? {
          ...originalPlan,
          channel: originalPlan.channel === "top" ? "bottom" : "top",
          lane:
            originalPlan.channel === "top"
              ? union([extentOf(r.from.part), extentOf(r.to.part)]).y1 +
                LANE_GAP
              : union([extentOf(r.from.part), extentOf(r.to.part)]).y0 -
                LANE_GAP,
        }
      : originalPlan;
    const bounds = union([extentOf(r.from.part), extentOf(r.to.part)]);
    const lanes = [
      plan.lane,
      plan.channel === "top" ? bounds.y1 + LANE_GAP : bounds.y0 - LANE_GAP,
      occupied.y1 + LANE_GAP,
      occupied.y0 - LANE_GAP,
    ];
    const finish = (points: readonly Point[]): RailRoute | undefined => {
      if (!validCandidate(r, points, others, true)) return undefined;
      const text = labelOf(r.id);
      const labelAt = text
        ? labelOnRoute(points, text, [
            ...obstacles,
            ...others.flatMap((q) =>
              segments(routes[q.id].points).map(segmentBox)
            ),
          ])
        : undefined;
      return text && !labelAt
        ? undefined
        : { points, ...(labelAt ? { labelAt } : {}) };
    };
    // Opposing horizontal ports have an exact rectangular channel candidate.
    // Ordered stubs and nested lanes handle parallel/self-return graphs without
    // a fresh grid search for every leg (including uncached oracle layouts).
    if (
      OUTWARD[fromSide][0] !== 0 &&
      OUTWARD[toSide][0] === -OUTWARD[fromSide][0]
    ) {
      const rectangleLanes = [
        plan.lane,
        plan.channel === "top"
          ? occupied.y0 - LANE_GAP
          : occupied.y1 + LANE_GAP,
        ...(strictOnly
          ? []
          : [
              plan.channel === "top"
                ? bounds.y1 + LANE_GAP
                : bounds.y0 - LANE_GAP,
            ]),
      ];
      for (const lane of rectangleLanes)
        for (const [fromStub, toStub] of [
          [
            LANE_STUB + plan.fromDrop * RAIL_GAP,
            LANE_STUB + plan.toDrop * RAIL_GAP,
          ],
          [LANE_STUB, LANE_STUB],
        ]) {
          const exitX = bf[0] + OUTWARD[fromSide][0] * fromStub;
          const entryX = bt[0] + OUTWARD[toSide][0] * toStub;
          const candidate = finish(
            dedupe([
              portAt(r.from.part, r.from.port),
              bf,
              [exitX, bf[1]],
              [exitX, lane],
              [entryX, lane],
              [entryX, bt[1]],
              bt,
              portAt(r.to.part, r.to.port),
            ])
          );
          if (candidate) return candidate;
        }
    }
    // A side-to-side hairpin need not visit a horizontal channel. In
    // particular, same-side loops belong beside their ports, not around all
    // the other ports and parts between that row and a top/bottom lane.
    if (!switchChannel && !forceLane)
      for (const stub of [LANE_STUB, 2, RAIL_GAP * 2]) {
        const exit: Point = [
          bf[0] + OUTWARD[fromSide][0] * stub,
          bf[1] + OUTWARD[fromSide][1] * stub,
        ];
        const entry: Point = [
          bt[0] + OUTWARD[toSide][0] * stub,
          bt[1] + OUTWARD[toSide][1] * stub,
        ];
        if (Math.hypot(exit[0] - entry[0], exit[1] - entry[1]) < SNAP) {
          const normal = OUTWARD[fromSide];
          const firstTurn =
            normal[0] === 0 ? 1 : normal[0] * (plan.channel === "top" ? -1 : 1);
          for (const sign of [firstTurn, -firstTurn]) {
            const tangent: Point = [
              -normal[1] * sign * RAIL_GAP,
              normal[0] * sign * RAIL_GAP,
            ];
            const points = dedupe([
              portAt(r.from.part, r.from.port),
              bf,
              exit,
              [exit[0] + tangent[0], exit[1] + tangent[1]],
              [
                exit[0] + tangent[0] + normal[0] * RAIL_GAP,
                exit[1] + tangent[1] + normal[1] * RAIL_GAP,
              ],
              [exit[0] + normal[0] * RAIL_GAP, exit[1] + normal[1] * RAIL_GAP],
              bt,
              portAt(r.to.part, r.to.port),
            ]);
            const candidate = finish(points);
            if (candidate) return candidate;
          }
        } else
          for (const clearance of [RAIL_GAP, 2])
            for (const reverse of [false, true]) {
              const path = leg(
                reverse ? entry : exit,
                reverse ? toSide : fromSide,
                occupied.y1 + LANE_GAP,
                obstacles,
                verticals,
                horizontals,
                {
                  point: reverse ? exit : entry,
                  side: reverse ? fromSide : toSide,
                },
                true,
                clearance
              );
              if (!path) continue;
              const candidate = finish(
                dedupe([
                  portAt(r.from.part, r.from.port),
                  bf,
                  ...(reverse ? [...path].reverse() : path),
                  bt,
                  portAt(r.to.part, r.to.port),
                ])
              );
              if (candidate) return candidate;
            }
      }
    let chosen: RailRoute | undefined;
    for (const [strict, clearance] of [
      [true, RAIL_GAP],
      [true, 2],
      [false, RAIL_GAP],
      [false, 2],
    ] as const) {
      if (strictOnly && !strict) continue;
      for (const candidate of strictOnly
        ? lanes.filter((y) =>
            plan.channel === "top" ? y < bounds.y0 : y > bounds.y1
          )
        : lanes) {
        let lane = candidate;
        for (let attempt = 0; attempt < extents.length; attempt++) {
          const block = extents.find(
            (e) =>
              e.x0 < bounds.x1 + LANE_STUB &&
              bounds.x0 - LANE_STUB < e.x1 &&
              e.y0 - 1 < lane &&
              lane < e.y1 + 1
          );
          if (!block) break;
          lane =
            candidate < bounds.y0 ? block.y0 - LANE_GAP : block.y1 + LANE_GAP;
        }
        for (const [fromStub, toStub] of [
          [
            LANE_STUB + plan.fromDrop * RAIL_GAP,
            LANE_STUB + plan.toDrop * RAIL_GAP,
          ],
          [LANE_STUB, LANE_STUB],
          [2, 2],
          [10, 10],
        ]) {
          const exit: Point = [
            bf[0] + OUTWARD[fromSide][0] * fromStub,
            bf[1] + OUTWARD[fromSide][1] * fromStub,
          ];
          const entry: Point = [
            bt[0] + OUTWARD[toSide][0] * toStub,
            bt[1] + OUTWARD[toSide][1] * toStub,
          ];
          for (const reverse of [false, true]) {
            const first = reverse ? entry : exit;
            const second = reverse ? exit : entry;
            const out = leg(
              first,
              reverse ? toSide : fromSide,
              lane,
              obstacles,
              verticals,
              horizontals,
              undefined,
              strict,
              clearance
            );
            if (!out) continue;
            const own =
              r.from.part === r.to.part && r.from.port === r.to.port
                ? out.slice(Math.max(0, portRunEnd(out) - 1))
                : out;
            const home = leg(
              second,
              reverse ? fromSide : toSide,
              lane,
              obstacles,
              [...verticals, ...verticalRuns(own)],
              [
                ...horizontals,
                ...segments(own).filter(
                  ([a, b]) => Math.abs(a[1] - b[1]) < SNAP
                ),
              ],
              undefined,
              strict,
              clearance
            );
            if (!home) continue;
            const middle = dedupe([...out, ...[...home].reverse()]);
            const points = dedupe([
              portAt(r.from.part, r.from.port),
              bf,
              ...(reverse ? middle.reverse() : middle),
              bt,
              portAt(r.to.part, r.to.port),
            ]);
            if (!validCandidate(r, points, others, strict)) continue;
            const text = labelOf(r.id);
            const labelObstacles = [
              ...obstacles,
              ...others.flatMap((q) =>
                segments(routes[q.id].points).map(segmentBox)
              ),
            ];
            const below: Point = [
              (out.at(-1)![0] + home.at(-1)![0]) / 2,
              lane + RAIL_LABEL_DY,
            ];
            const labelAt = text
              ? !labelObstacles.some((e) => crosses(labelBox(below, text), e))
                ? below
                : labelOnRoute(points, text, labelObstacles)
              : undefined;
            if (text && !labelAt) continue;
            chosen = { points, ...(labelAt ? { labelAt } : {}) };
            break;
          }
          if (chosen) break;
        }
        if (chosen) break;
      }
      if (chosen) break;
    }
    return chosen;
  };
  /* A degraded but deterministic return: legs to a lane below everything that
     avoid parts but not rails. Any crossing it makes is drawn with a jump, so
     one hard rail never discards the placement of the whole level. */
  const degradedReturn = (r: DiagramRail): RailRoute => {
    const fromSide = nodes.get(r.from.part)!.part.ports[r.from.port].side;
    const toSide = nodes.get(r.to.part)!.part.ports[r.to.port].side;
    const bf = borderAt(r.from.part, r.from.port);
    const bt = borderAt(r.to.part, r.to.port);
    const lane = union([...extents, ...regionHeaders]).y1 + LANE_GAP;
    const exit: Point = [
      bf[0] + OUTWARD[fromSide][0] * LANE_STUB,
      bf[1] + OUTWARD[fromSide][1] * LANE_STUB,
    ];
    const entry: Point = [
      bt[0] + OUTWARD[toSide][0] * LANE_STUB,
      bt[1] + OUTWARD[toSide][1] * LANE_STUB,
    ];
    const parts = [...nodes]
      .filter(([, n]) => !n.given)
      .map(([id]) => extentOf(id));
    const out = leg(exit, fromSide, lane, parts, [], []);
    const home = leg(entry, toSide, lane, parts, [], []);
    const middle =
      out && home
        ? [...out, ...[...home].reverse()]
        : [exit, [exit[0], lane] as Point, [entry[0], lane] as Point, entry];
    const points = dedupe([
      portAt(r.from.part, r.from.port),
      bf,
      ...middle,
      bt,
      portAt(r.to.part, r.to.port),
    ]);
    const text = labelOf(r.id);
    const labelAt = text
      ? labelOnRoute(points, text, [...parts, ...regionHeaders])
      : undefined;
    return { points, ...(labelAt ? { labelAt } : {}) };
  };
  for (const r of returns) {
    routes[r.id] =
      routeChannel(r, [...accepted, ...routedReturns]) ?? degradedReturn(r);
    routedReturns.push(r);
  }
  // Rip up a conflicting rail and search with every other rail reserved. Try
  // both ends and short stubs: a previous fork can box in the usual stub.
  const automatic = rails.filter((r) => routes[r.id] && !touchesGiven(r));
  const firstMain = new Map<string, string>();
  for (const r of forward)
    if (!r.conditional && !firstMain.has(r.from.part))
      firstMain.set(r.from.part, r.id);
  const pinned = (r: DiagramRail) =>
    firstMain.get(r.from.part) === r.id &&
    routes[r.id].points.every((p) => p[1] === routes[r.id].points[0][1]);
  const conflicts = (r: DiagramRail, points: readonly Point[]) =>
    automatic
      .filter((q) => q !== r)
      .reduce(
        (n, q) => n + railCrossings(points, routes[q.id].points).length,
        0
      );
  for (let pass = 0; pass < 3; pass++) {
    let improved = false;
    for (const r of [...automatic].reverse()) {
      const old = routes[r.id];
      const count = conflicts(r, old.points);
      if (count === 0 || pinned(r)) continue;
      const reserved = automatic
        .filter((q) => q !== r)
        .flatMap((q) => reservedRuns(r, q, routes[q.id].points));
      const v = reserved.flatMap((s) => verticalRuns(s));
      const h = reserved.filter(([a, b]) => Math.abs(a[1] - b[1]) < SNAP);
      const bf = borderAt(r.from.part, r.from.port);
      const bt = borderAt(r.to.part, r.to.port);
      const fs = nodes.get(r.from.part)!.part.ports[r.from.port].side;
      const ts = nodes.get(r.to.part)!.part.ports[r.to.port].side;
      const labels = [
        ...regionHeaders,
        ...automatic
          .filter((q) => q !== r)
          .flatMap((q) => {
            const text = labelOf(q.id);
            const at = routes[q.id].labelAt;
            return text && at ? [labelBox(at, text)] : [];
          }),
      ];
      for (const stub of [LANE_STUB, 2]) {
        const start: Point = [
          bf[0] + OUTWARD[fs][0] * stub,
          bf[1] + OUTWARD[fs][1] * stub,
        ];
        const end: Point = [
          bt[0] + OUTWARD[ts][0] * stub,
          bt[1] + OUTWARD[ts][1] * stub,
        ];
        if (Math.hypot(start[0] - end[0], start[1] - end[1]) < SNAP) continue;
        for (const reverse of [false, true]) {
          const path = leg(
            reverse ? end : start,
            reverse ? ts : fs,
            union(extents).y1 + LANE_GAP,
            [...extents, ...labels],
            v,
            h,
            { point: reverse ? start : end, side: reverse ? fs : ts },
            true
          );
          if (!path) continue;
          const points = dedupe([
            portAt(r.from.part, r.from.port),
            bf,
            ...(reverse ? path.reverse() : path),
            bt,
            portAt(r.to.part, r.to.port),
          ]);
          if (conflicts(r, points) >= count) continue;
          const shares = automatic.some(
            (q) =>
              q !== r &&
              (reservedRuns(r, q, routes[q.id].points).some((s) =>
                segments(points).some((t) => collinear(s, t))
              ) ||
                reservedRuns(q, r, points).some((s) =>
                  segments(routes[q.id].points).some((t) => collinear(s, t))
                ))
          );
          if (shares) continue;
          const text = labelOf(r.id);
          const labelAt = text
            ? labelOnRoute(points, text, [
                ...extents,
                ...labels,
                ...reserved.map(segmentBox),
              ])
            : undefined;
          if (text && !labelAt) continue;
          routes[r.id] = { points, ...(labelAt ? { labelAt } : {}) };
          improved = true;
          break;
        }
        if (routes[r.id] !== old) break;
      }
    }
    if (!improved) break;
  }
  // Crossings (or stretches shared off a common port's run) left after local
  // repair: if the port order admits a planar embedding, choose one and draw
  // every rail inside its face (faceRouter).
  const end = (e: DiagramRail["from"]) => ({
    part: e.part,
    port: e.port,
    side: nodes.get(e.part)!.part.ports[e.port].side,
    at: portAt(e.part, e.port),
    border: borderAt(e.part, e.port),
  });
  const faceRails = rails.map((r) => ({
    id: r.id,
    from: end(r.from),
    to: end(r.to),
    ...(routes[r.id] ? { route: routes[r.id] } : {}),
    movable: !touchesGiven(r),
    label: labelOf(r.id),
  }));
  const faceRail = new Map(faceRails.map((r) => [r.id, r]));
  if (
    automatic.some((r, i) =>
      automatic
        .slice(i + 1)
        .some(
          (q) =>
            !compatible(
              faceRail.get(r.id)!,
              routes[r.id].points,
              faceRail.get(q.id)!,
              routes[q.id].points
            )
        )
    )
  ) {
    const isMain = (r: DiagramRail) => firstMain.get(r.from.part) === r.id;
    const planar = routeByTopology({
      diagram: first,
      rails: faceRails,
      parts: extents,
      soft: regionHeaders,
      preference: [
        ...forward.filter(isMain),
        ...forward.filter((r) => !isMain(r)),
        ...returns,
      ]
        .filter((r) => automatic.includes(r))
        .map((r) => r.id),
      gap: RAIL_GAP,
      stub: LANE_STUB,
      labelBox,
      placeLabel: labelOnRoute,
    });
    if (planar)
      for (const r of automatic) if (planar[r.id]) routes[r.id] = planar[r.id];
  }
  // Route compatible forward and return corridors once at the width of the
  // whole bus, then fan each offset track back to its own fixed ports.
  const portOrder = (end: DiagramRail["from"], source: boolean) => {
    const part = nodes.get(end.part)!.part;
    const p = part.ports[end.port];
    const n = OUTWARD[p.side];
    const tangent: Point = source ? [-n[1], n[0]] : [n[1], -n[0]];
    const projection = (point: Point) =>
      point[0] * tangent[0] + point[1] * tangent[1];
    return Object.entries(part.ports)
      .filter(([, q]) => q.side === p.side)
      .sort((a, b) => projection(a[1].local) - projection(b[1].local))
      .findIndex(([name]) => name === end.port);
  };
  const bundled = new Set<DiagramRail>();
  for (const axis of [0, 1] as const) {
    const busRails = automatic;
    const candidates: BusCandidate[] = busRails.map((r) => {
      const run = segments(routes[r.id].points)
        .filter(([a, b]) => Math.abs(a[1 - axis] - b[1 - axis]) < SNAP)
        .sort(
          (s, t) =>
            Math.abs(t[1][axis] - t[0][axis]) -
            Math.abs(s[1][axis] - s[0][axis])
        )[0];
      return {
        from: {
          part: r.from.part,
          side: nodes.get(r.from.part)!.part.ports[r.from.port].side,
          order: portOrder(r.from, true),
        },
        to: {
          part: r.to.part,
          side: nodes.get(r.to.part)!.part.ports[r.to.port].side,
          order: portOrder(r.to, false),
        },
        direction: run && run[1][axis] < run[0][axis] ? -1 : 1,
        corridor: run
          ? [
              Math.min(run[0][axis], run[1][axis]),
              Math.max(run[0][axis], run[1][axis]),
            ]
          : [0, 0],
        y: run?.[0][1 - axis] ?? 0,
      };
    });
    for (const indices of groupBundles(candidates)) {
      const members = indices.map((i) => busRails[i]);
      if (members.some((r) => bundled.has(r))) continue;
      const width = (members.length - 1) * RAIL_GAP;
      const anchor = Math.max(
        0,
        members.findIndex((r) => !r.conditional)
      );
      const offset = (anchor - (members.length - 1) / 2) * RAIL_GAP;
      const firstRail = members[anchor];
      const fromSide = nodes.get(firstRail.from.part)!.part.ports[
        firstRail.from.port
      ].side;
      const toSide = nodes.get(firstRail.to.part)!.part.ports[firstRail.to.port]
        .side;
      const fromNormal = OUTWARD[fromSide];
      const toNormal = OUTWARD[toSide];
      const bf = borderAt(firstRail.from.part, firstRail.from.port);
      const bt = borderAt(firstRail.to.part, firstRail.to.port);
      const start: Point = [
        bf[0] + fromNormal[0] * (LANE_STUB + width) + fromNormal[1] * offset,
        bf[1] + fromNormal[1] * (LANE_STUB + width) - fromNormal[0] * offset,
      ];
      const end: Point = [
        bt[0] + toNormal[0] * (LANE_STUB + width) - toNormal[1] * offset,
        bt[1] + toNormal[1] * (LANE_STUB + width) + toNormal[0] * offset,
      ];
      const others = automatic.filter((r) => !members.includes(r));
      const blocked = [
        ...extents,
        ...regionHeaders,
        ...others.flatMap((r) => {
          const text = labelOf(r.id);
          const path = routes[r.id];
          return [
            ...segments(path.points).map(segmentBox),
            ...(text && path.labelAt ? [labelBox(path.labelAt, text)] : []),
          ];
        }),
      ].map((e) => pad(e, width / 2 + RAIL_GAP));
      const spine = leg(
        start,
        fromSide,
        union(extents).y1 + LANE_GAP + width,
        blocked,
        [],
        [],
        { point: end, side: toSide },
        true,
        RAIL_GAP,
        true
      );
      if (!spine) continue;
      const tracks = offsetBusTracks(spine, members.length, RAIL_GAP);
      const proposed = members.map((r, i): RailRoute => {
        const track = tracks[i];
        const first = track.points[0];
        const last = track.points.at(-1)!;
        const from = portAt(r.from.part, r.from.port);
        const to = portAt(r.to.part, r.to.port);
        const leadAt: Point = [
          first[0] - fromNormal[0] * LANE_STUB,
          first[1] - fromNormal[1] * LANE_STUB,
        ];
        const tailAt: Point = [
          last[0] - toNormal[0] * LANE_STUB,
          last[1] - toNormal[1] * LANE_STUB,
        ];
        const lead: Point[] = [
          from,
          fromNormal[0] ? [leadAt[0], from[1]] : [from[0], leadAt[1]],
          leadAt,
        ];
        const tail: Point[] = [
          tailAt,
          toNormal[0] ? [tailAt[0], to[1]] : [to[0], tailAt[1]],
          to,
        ];
        return {
          points: [...lead, ...track.points, ...tail],
          cornerRadii: [
            ...lead.map(() => 2),
            ...track.cornerRadii,
            ...tail.map(() => 2),
          ],
        };
      });
      let valid = proposed.every(
        (p, i) =>
          (!pinned(members[i]) ||
            p.points.every(
              (point) =>
                Math.abs(point[1] - routes[members[i].id].points[0][1]) < SNAP
            )) &&
          clearOf(members[i], p.points, others, true) &&
          !throughPart(members[i], p.points, true) &&
          proposed.every(
            (q, j) =>
              i === j ||
              (railCrossings(p.points, q.points).length === 0 &&
                !reservedRuns(members[i], members[j], q.points).some((s) =>
                  segments(p.points).some((t) => collinear(s, t))
                ))
          )
      );
      if (valid)
        for (const [i, r] of members.entries()) {
          const text = labelOf(r.id);
          if (!text) continue;
          const obstacles = [
            ...extents,
            ...regionHeaders,
            ...others.flatMap((q) => {
              const label = labelOf(q.id);
              const path = routes[q.id];
              return [
                ...segments(path.points).map(segmentBox),
                ...(label && path.labelAt
                  ? [labelBox(path.labelAt, label)]
                  : []),
              ];
            }),
            ...proposed.flatMap((q, j) =>
              j === i
                ? []
                : [
                    ...segments(q.points).map(segmentBox),
                    ...(q.labelAt && labelOf(members[j].id)
                      ? [labelBox(q.labelAt, labelOf(members[j].id)!)]
                      : []),
                  ]
            ),
          ];
          const labelAt = labelOnRoute(proposed[i].points, text, obstacles);
          if (!labelAt) {
            valid = false;
            break;
          }
          proposed[i] = { ...proposed[i], labelAt };
        }
      if (!valid) continue;
      for (const [i, r] of members.entries()) {
        routes[r.id] = proposed[i];
        bundled.add(r);
      }
    }
  }
  // A local lane can sit above a different part. Place its label against all
  // drawn geometry rather than assuming the space under a global lane is empty.
  for (const r of automatic) {
    const text = labelOf(r.id);
    if (!text) continue;
    const q = routes[r.id];
    const obstacles = [
      ...extents,
      ...regionHeaders,
      ...automatic
        .filter((p) => p !== r)
        .flatMap((p) => {
          const path = routes[p.id];
          const label = labelOf(p.id);
          return [
            ...segments(path.points).map(segmentBox),
            ...(path.labelAt && label ? [labelBox(path.labelAt, label)] : []),
          ];
        }),
    ];
    if (
      q.labelAt &&
      !obstacles.some((b) => crosses(labelBox(q.labelAt!, text), b))
    )
      continue;
    const labelAt = labelOnRoute(q.points, text, obstacles);
    if (labelAt) routes[r.id] = { ...q, labelAt };
  }
  /* region names: a rail label ELK (or a lane) put on one moves to a clear
     run of its own rail */
  for (const [id, route] of Object.entries(routes)) {
    const text = labelOf(id);
    if (!text || !route.labelAt) continue;
    const box = labelBox(route.labelAt, text);
    if (!regionHeaders.some((n) => crosses(box, n))) continue;
    const labelAt = labelOnRoute(route.points, text, [
      ...extents,
      ...regionHeaders,
      ...Object.entries(routes)
        .filter(([other]) => other !== id)
        .flatMap(([other, q]) => {
          const label = labelOf(other);
          return [
            ...segments(q.points).map(segmentBox),
            ...(label && q.labelAt ? [labelBox(q.labelAt, label)] : []),
          ];
        }),
    ]);
    if (labelAt) routes[id] = { ...route, labelAt };
  }
  const kept = keptOnCanvas(positions, routes, extents, labelOf);
  const ids = rails.filter((r) => kept.routes?.[r.id]).map((r) => r.id);
  const jumps = crossingJumps(ids.map((id) => kept.routes![id].points));
  return {
    ...kept,
    routes: Object.fromEntries(
      ids.map((id, i) => [
        id,
        {
          ...kept.routes![id],
          ...(jumps[i].length ? { jumps: jumps[i] } : {}),
        },
      ])
    ),
  };
}

/**
 * Loops that step out past the leftmost (or topmost) part can leave the
 * canvas; move the laid-out parts and routes so everything keeps a stub's
 * margin from the edge.
 */
function keptOnCanvas(
  positions: Record<string, Position>,
  routes: Record<string, RailRoute>,
  extents: readonly Box[],
  labelOf: (rail: string) => string | undefined
): LevelLayout {
  const drawn: Box[] = [
    ...extents,
    ...Object.entries(routes).flatMap(([id, r]) => {
      const text = labelOf(id);
      return [
        ...r.points.map(([x, y]) => ({ x0: x, y0: y, x1: x, y1: y })),
        ...(r.labelAt && text ? [labelBox(r.labelAt, text)] : []),
      ];
    }),
  ];
  const all = union(drawn);
  const dx = Math.max(0, LANE_STUB - all.x0);
  const dy = Math.max(0, LANE_STUB - all.y0);
  if (dx === 0 && dy === 0) return { positions, routes };
  const move = ([x, y]: Point): Point => [x + dx, y + dy];
  return {
    positions: Object.fromEntries(
      Object.entries(positions).map(([id, p]) => [
        id,
        { x: p.x + dx, y: p.y + dy },
      ])
    ),
    routes: Object.fromEntries(
      Object.entries(routes).map(([id, r]) => [
        id,
        {
          ...r,
          points: r.points.map(move),
          ...(r.labelAt ? { labelAt: move(r.labelAt) } : {}),
        },
      ])
    ),
  };
}

function elkGraph(
  nodes: ReadonlyMap<string, PartNode>,
  forward: readonly DiagramRail[],
  d: DiagramTimeline,
  labelOf: (rail: string) => string | undefined
): ElkNode {
  const used = new Map<string, Set<string>>();
  for (const r of forward)
    for (const end of [r.from, r.to]) {
      const s = used.get(end.part) ?? new Set();
      s.add(end.port);
      used.set(end.part, s);
    }
  const node = ({ part, extent }: PartNode): ElkNode => {
    const w = extent.x1 - extent.x0;
    const h = extent.y1 - extent.y0;
    return {
      id: part.id,
      width: w,
      height: h,
      layoutOptions: { "elk.portConstraints": "FIXED_POS" },
      ports: [...(used.get(part.id) ?? [])].map((name) => {
        const p = part.ports[name];
        const lx = p.local[0] * part.scale - extent.x0;
        const ly = p.local[1] * part.scale - extent.y0;
        const [x, y] =
          p.side === "W"
            ? [0, ly]
            : p.side === "E"
              ? [w, ly]
              : p.side === "N"
                ? [lx, 0]
                : [lx, h];
        return {
          id: portId(part.id, name),
          x,
          y,
          width: 0,
          height: 0,
          layoutOptions: { "elk.port.side": ELK_SIDE[p.side] },
        };
      }),
    };
  };
  const inRegion = new Map<string, string>();
  for (const g of d.regions) for (const p of g.parts) inRegion.set(p, g.id);
  const children: ElkNode[] = [];
  const placedRegions = new Set<string>();
  for (const n of nodes.values()) {
    const g = inRegion.get(n.part.id);
    if (g === undefined) {
      children.push(node(n));
      continue;
    }
    // A region sits where its first part appears in the spec (model order).
    if (placedRegions.has(g)) continue;
    placedRegions.add(g);
    children.push({
      id: regionNodeId(g),
      layoutOptions: {
        // Hierarchical processors must match the root's.
        "elk.layered.crossingMinimization.strategy": "NONE",
        ...SPACING,
        "elk.padding": `[top=${REGION_HEAD},left=${REGION_PAD},bottom=${REGION_PAD},right=${REGION_PAD}]`,
      },
      children: [...nodes.values()]
        .filter((m) => inRegion.get(m.part.id) === g)
        .map(node),
    });
  }

  const mainRail = new Map<string, string>();
  for (const r of forward)
    if (!r.conditional && !mainRail.has(r.from.part))
      mainRail.set(r.from.part, r.id);
  const edges: ElkExtendedEdge[] = forward.map((r) => {
    const text = labelOf(r.id);
    return {
      id: r.id,
      sources: [portId(r.from.part, r.from.port)],
      targets: [portId(r.to.part, r.to.port)],
      ...(mainRail.get(r.from.part) === r.id
        ? {
            layoutOptions: {
              "elk.layered.priority.straightness": MAIN_RAIL_PRIORITY,
              "elk.layered.priority.direction": MAIN_RAIL_PRIORITY,
            },
          }
        : {}),
      ...(text
        ? {
            labels: [
              {
                text,
                width: textWidth(text, RAIL_LABEL_SIZE) + LABEL_PAD_X,
                height: RAIL_LABEL_SIZE * LINE_EM + LABEL_PAD_Y,
              },
            ],
          }
        : {}),
    };
  });

  return {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.layered.cycleBreaking.strategy": "MODEL_ORDER",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      // Spec order decides top to bottom within a layer, so branches stay
      // below the main rail as written instead of being reordered.
      "elk.layered.crossingMinimization.strategy": "NONE",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      "elk.layered.nodePlacement.bk.fixedAlignment": "LEFTUP",
      ...SPACING,
      "elk.edgeLabels.inline": "false",
      "elk.padding": `[top=${DIAGRAM_PAD},left=${DIAGRAM_PAD},bottom=${DIAGRAM_PAD},right=${DIAGRAM_PAD}]`,
    },
    children,
    edges,
  };
}

/** Every edge in the laid-out graph with the offset of the node its coordinates are relative to. */
function collectEdges(
  root: ElkNode
): Map<string, { edge: ElkExtendedEdge; offset: Point }> {
  const offsets = new Map<string, Point>([["root", [0, 0]]]);
  const walk = (n: ElkNode, ox: number, oy: number) => {
    for (const c of n.children ?? []) {
      const x = ox + (c.x ?? 0);
      const y = oy + (c.y ?? 0);
      offsets.set(c.id, [x, y]);
      walk(c, x, y);
    }
  };
  walk(root, 0, 0);
  const out = new Map<string, { edge: ElkExtendedEdge; offset: Point }>();
  const gather = (n: ElkNode) => {
    for (const e of (n.edges ?? []) as (ElkExtendedEdge & {
      container?: string;
    })[])
      out.set(e.id, {
        edge: e,
        offset: offsets.get(e.container ?? n.id) ?? offsets.get(n.id)!,
      });
    for (const c of n.children ?? []) gather(c);
  };
  gather(root);
  return out;
}

/** Reserve every run except a straight fork/join connected to a common port. */
function reservedRuns(
  r: DiagramRail,
  q: DiagramRail,
  points: readonly Point[]
): Segment[] {
  const same = (a: DiagramRail["from"], b: DiagramRail["from"]) =>
    a.part === b.part && a.port === b.port;
  const shared = [
    ...(same(q.from, r.from) || same(q.from, r.to) ? [points] : []),
    ...(same(q.to, r.from) || same(q.to, r.to) ? [[...points].reverse()] : []),
  ];
  const allowed = shared.flatMap((path) => {
    const end = portRunEnd(path);
    return segments(end < 0 ? path : path.slice(0, end));
  });
  return segments(points).filter((s) => !allowed.some((a) => collinear(s, a)));
}

/** First point beyond the straight run connected to the port, or -1. */
function portRunEnd(points: readonly Point[]): number {
  return points.findIndex(
    (p) =>
      Math.abs(p[0] - points[0][0]) >= SNAP &&
      Math.abs(p[1] - points[0][1]) >= SNAP
  );
}

interface VerticalRun {
  readonly x: number;
  readonly y0: number;
  readonly y1: number;
}

const MOVES = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/** Cost of one bend, in px of rail: a longer straight run beats a staircase. */
const BEND_COST = 120;

/**
 * An orthogonal path from a stub to a return lane (or another port's stub)
 * that crosses no part, keeps a rail gap beside verticals, and shares no reserved
 * horizontal stretch. A* over lines around part edges and reserved
 * runs, with a cost per bend; undefined when the stub is boxed in.
 */
function legToLane(
  stub: Point,
  side: PortSide,
  lane: number,
  extents: readonly Box[],
  verticals: readonly VerticalRun[],
  horizontals: readonly Segment[],
  target?: { point: Point; side: PortSide },
  strict = false,
  clearance = RAIL_GAP,
  aligned = false
): Point[] | undefined {
  // Running along a part's edge counts as touching it.
  const parts = extents.map((e) => pad(e, 1));
  const uniq = (v: number[]) =>
    [...new Map(v.map((n) => [Math.round(n * 100), n] as const)).values()].sort(
      (a, b) => a - b
    );
  const xs = uniq([
    stub[0],
    ...(target ? [target.point[0]] : []),
    ...horizontals.flatMap(([a, b]) => [
      a[0] - RAIL_GAP,
      a[0] + RAIL_GAP,
      b[0] - RAIL_GAP,
      b[0] + RAIL_GAP,
      a[0] - clearance,
      a[0] + clearance,
      b[0] - clearance,
      b[0] + clearance,
    ]),
    ...extents.flatMap((e) => [e.x0 - LANE_STUB, e.x1 + LANE_STUB]),
    ...verticals.flatMap((v) => [
      v.x - RAIL_GAP,
      v.x + RAIL_GAP,
      v.x - clearance,
      v.x + clearance,
    ]),
  ]);
  // A stub can sit between an existing vertical and a part. Let the leg
  // climb around the vertical's end before descending, rather than treating
  // the stub's row as the top of the search and falling back through rails.
  const ys = uniq([
    stub[1],
    ...(target ? [target.point[1]] : []),
    lane,
    ...verticals.flatMap((v) => [
      v.y0 - RAIL_GAP,
      v.y1 + RAIL_GAP,
      v.y0 - clearance,
      v.y1 + clearance,
    ]),
    ...horizontals.flatMap(([a]) => [
      a[1] - RAIL_GAP,
      a[1] + RAIL_GAP,
      a[1] - clearance,
      a[1] + clearance,
    ]),
    ...extents.flatMap((e) => [e.y0 - LANE_STUB, e.y1 + LANE_STUB]),
  ]);
  const sx = xs.findIndex((x) => Math.abs(x - stub[0]) < 0.01);
  const sy = ys.findIndex((y) => Math.abs(y - stub[1]) < 0.01);
  const goal = ys.findIndex((y) => Math.abs(y - lane) < 0.01);
  if (sx < 0 || sy < 0) return undefined;
  // Every check below is answered from obstacles prefiltered to the grid row
  // or column a step runs along, and memoized per cell and per step: the
  // search visits each step up to once per heading, and most obstacles are
  // nowhere near a given line. The answers are exactly those of a full scan.
  const W = xs.length;
  const rowParts: (readonly Box[] | undefined)[] = new Array(ys.length);
  const colParts: (readonly Box[] | undefined)[] = new Array(W);
  const partsOnRow = (iy: number) =>
    (rowParts[iy] ??= parts.filter((e) => e.y0 < ys[iy] && ys[iy] < e.y1));
  const partsOnCol = (ix: number) =>
    (colParts[ix] ??= parts.filter((e) => e.x0 < xs[ix] && xs[ix] < e.x1));
  const rowVerticals: (readonly VerticalRun[] | undefined)[] = new Array(
    ys.length
  );
  const rowHorizontals: (readonly Segment[] | undefined)[] = new Array(
    ys.length
  );
  const colVerticals: (readonly VerticalRun[] | undefined)[] = new Array(W);
  const colHorizontals: (readonly Segment[] | undefined)[] = new Array(W);
  // Strict: verticals whose span covers this row; collinear: horizontals on it.
  const verticalsOnRow = (iy: number) =>
    (rowVerticals[iy] ??= verticals.filter(
      (v) => v.y0 - SNAP < ys[iy] && ys[iy] < v.y1 + SNAP
    ));
  const horizontalsOnRow = (iy: number) =>
    (rowHorizontals[iy] ??= horizontals.filter(
      ([p, q]) => Math.abs(p[1] - q[1]) < SNAP && Math.abs(p[1] - ys[iy]) < SNAP
    ));
  // Strict: horizontals whose span covers this column; clearance: verticals near it.
  const horizontalsOnCol = (ix: number) =>
    (colHorizontals[ix] ??= horizontals.filter(
      ([p, q]) =>
        Math.min(p[0], q[0]) - SNAP < xs[ix] &&
        xs[ix] < Math.max(p[0], q[0]) + SNAP
    ));
  const verticalsOnCol = (ix: number) =>
    (colVerticals[ix] ??= verticals.filter(
      (v) => Math.abs(v.x - xs[ix]) < clearance - SNAP
    ));
  const insideMemo = new Int8Array(W * ys.length);
  const inside = (ix: number, iy: number) => {
    const at = iy * W + ix;
    if (insideMemo[at] === 0) {
      const x = xs[ix];
      insideMemo[at] = partsOnRow(iy).some((e) => e.x0 < x && x < e.x1) ? 1 : 2;
    }
    return insideMemo[at] === 1;
  };
  const freeMemo = new Int8Array(W * ys.length * 4);
  const free = (ix: number, iy: number, m: number, nx: number, ny: number) => {
    const at = (iy * W + ix) * 4 + m;
    if (freeMemo[at] === 0)
      freeMemo[at] = step([xs[ix], ys[iy]], [xs[nx], ys[ny]], ix, iy) ? 1 : 2;
    return freeMemo[at] === 1;
  };
  const step = (a: Point, b: Point, ix: number, iy: number) => {
    const box = segmentBox([a, b]);
    if (a[1] === b[1]) {
      if (partsOnRow(iy).some((e) => crosses(box, e))) return false;
      if (
        strict &&
        verticalsOnRow(iy).some(
          (v) => box.x0 - SNAP < v.x && v.x < box.x1 + SNAP
        )
      )
        return false;
      return !horizontalsOnRow(iy).some((s) => collinear([a, b], s));
    }
    if (partsOnCol(ix).some((e) => crosses(box, e))) return false;
    if (
      strict &&
      horizontalsOnCol(ix).some(
        ([p]) => box.y0 - SNAP < p[1] && p[1] < box.y1 + SNAP
      )
    )
      return false;
    return !verticalsOnCol(ix).some(
      (v) => v.y0 < box.y1 - SNAP && box.y0 + SNAP < v.y1
    );
  };
  // state: (ix, iy, heading), heading 0 at the start, else 1 + index in MOVES
  const key = (ix: number, iy: number, h: number) =>
    (iy * xs.length + ix) * 5 + h;
  const states = W * ys.length * 5;
  const cost = new Float64Array(states).fill(Infinity);
  const from = new Int32Array(states).fill(-1);
  const heap = new MinHeap();
  const start = key(sx, sy, 0);
  // Manhattan distance is an admissible, consistent lower bound: bends add
  // cost, and a lane has no required x coordinate. This keeps boxed-in
  // searches local without weakening any obstacle or crossing constraint.
  const remaining = (ix: number, iy: number) =>
    Math.abs(ys[iy] - (target?.point[1] ?? lane)) +
    (target ? Math.abs(xs[ix] - target.point[0]) : 0);
  cost[start] = 0;
  heap.push(remaining(sx, sy), start);
  while (heap.size > 0) {
    const priority = heap.topPriority();
    const k = heap.pop();
    const c = cost[k];
    const h = k % 5;
    const cell = (k - h) / 5;
    const [ix, iy] = [cell % xs.length, Math.floor(cell / xs.length)];
    if (priority > c + remaining(ix, iy)) continue;
    const arrived = target
      ? Math.abs(xs[ix] - target.point[0]) < 0.01 &&
        Math.abs(ys[iy] - target.point[1]) < 0.01 &&
        h !== 0 &&
        MOVES[h - 1][0] * OUTWARD[target.side][0] +
          MOVES[h - 1][1] * OUTWARD[target.side][1] <
          (aligned ? 0 : 1)
      : iy === goal;
    if (arrived) {
      const path: Point[] = [];
      for (let at = k; at >= 0; at = from[at]) {
        const n = (at - (at % 5)) / 5;
        path.push([xs[n % xs.length], ys[Math.floor(n / xs.length)]]);
      }
      path.reverse();
      path[0] = stub;
      return path.filter((p, i) => {
        // drop points in the middle of a straight run
        if (i === 0 || i === path.length - 1) return true;
        const [a, b] = [path[i - 1], path[i + 1]];
        return !(
          (Math.abs(a[0] - p[0]) < 0.01 && Math.abs(p[0] - b[0]) < 0.01) ||
          (Math.abs(a[1] - p[1]) < 0.01 && Math.abs(p[1] - b[1]) < 0.01)
        );
      });
    }
    for (const [m, [dx, dy]] of MOVES.entries()) {
      // The first move leaves the port, never back toward its part, and no
      // move doubles back on the one before.
      const [bx, by] = h === 0 ? OUTWARD[side] : MOVES[h - 1];
      if (dx === -bx && dy === -by) continue;
      if (aligned && h === 0 && (dx !== bx || dy !== by)) continue;
      const [nx, ny] = [ix + dx, iy + dy];
      if (nx < 0 || ny < 0 || nx >= xs.length || ny >= ys.length) continue;
      if (inside(nx, ny) || !free(ix, iy, m, nx, ny)) continue;
      const a: Point = [xs[ix], ys[iy]];
      const b: Point = [xs[nx], ys[ny]];
      const nh = m + 1;
      const nc =
        c +
        Math.abs(b[0] - a[0]) +
        Math.abs(b[1] - a[1]) +
        (h !== 0 && h !== nh ? BEND_COST : 0);
      const nk = key(nx, ny, nh);
      if (nc < cost[nk]) {
        cost[nk] = nc;
        from[nk] = k;
        heap.push(nc + remaining(nx, ny), nk);
      }
    }
  }
  return undefined;
}

/** A per-layout cache of `legToLane` answers, keyed by every input. */
function memoizedLegs(): typeof legToLane {
  const answers = new Map<string, Point[] | undefined>();
  return (...args) => {
    const key = JSON.stringify(args);
    let path = answers.get(key);
    if (path === undefined && !answers.has(key)) {
      path = legToLane(...args);
      answers.set(key, path);
    }
    // Callers reverse and splice paths; hand out a fresh array every time.
    return path && [...path];
  };
}

/**
 * A binary min-heap of (priority, value) pairs in two parallel arrays, so a
 * push or pop allocates nothing. Same sift order as a tuple heap.
 */
class MinHeap {
  private readonly priorities: number[] = [];
  private readonly values: number[] = [];
  get size() {
    return this.values.length;
  }
  topPriority() {
    return this.priorities[0];
  }
  push(priority: number, value: number) {
    const p = this.priorities;
    const v = this.values;
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
  /** Removes the minimum and returns its value. */
  pop(): number {
    const p = this.priorities;
    const v = this.values;
    const top = v[0];
    const lastP = p.pop()!;
    const lastV = v.pop()!;
    if (v.length > 0) {
      p[0] = lastP;
      v[0] = lastV;
      for (let i = 0; ; ) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < v.length && p[l] < p[m]) m = l;
        if (r < v.length && p[r] < p[m]) m = r;
        if (m === i) break;
        [p[m], p[i]] = [p[i], p[m]];
        [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return top;
  }
}

/** The vertical segments of a route, as x and a y span. */
function verticalRuns(points: readonly Point[]): VerticalRun[] {
  return points.slice(1).flatMap((b, i) => {
    const a = points[i];
    return Math.abs(a[0] - b[0]) < 0.5 && Math.abs(a[1] - b[1]) > 0.5
      ? [{ x: a[0], y0: Math.min(a[1], b[1]), y1: Math.max(a[1], b[1]) }]
      : [];
  });
}

function dedupe(points: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (
      last &&
      Math.abs(last[0] - p[0]) < 0.01 &&
      Math.abs(last[1] - p[1]) < 0.01
    )
      continue;
    out.push(p);
  }
  return out;
}

interface StraightenInput {
  /** Where the rail meets its source's and target's node borders. */
  readonly from: Point;
  readonly to: Point;
  readonly fromSide: PortSide;
  readonly toSide: PortSide;
  readonly label: string | undefined;
  /** Every part's extent in diagram space. */
  readonly extents: readonly Box[];
  readonly others: readonly {
    readonly route: RailRoute;
    readonly label: string | undefined;
    /** Leaves from the same port, so a shared trunk reads as a fork. */
    readonly sharesSource: boolean;
  }[];
}

const LABEL_H = RAIL_LABEL_SIZE * LINE_EM + LABEL_PAD_Y;
/** Gap between a rail and the label ELK sets above it. */
const LABEL_LIFT = LABEL_H / 2 + 5;
const SNAP = 0.5;

type Segment = readonly [Point, Point];

const segments = (points: readonly Point[]): Segment[] =>
  points.slice(1).map((p, i) => [points[i], p] as const);

const segmentBox = ([a, b]: Segment): Box => ({
  x0: Math.min(a[0], b[0]),
  y0: Math.min(a[1], b[1]),
  x1: Math.max(a[0], b[0]),
  y1: Math.max(a[1], b[1]),
});

/** Strict overlap that also works for zero-width segment boxes. */
const crosses = (a: Box, b: Box) =>
  a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/** Two segments on one line sharing a stretch of it. */
function collinear([a, b]: Segment, [c, d]: Segment): boolean {
  const horizontal = (p: Point, q: Point) => Math.abs(p[1] - q[1]) < SNAP;
  const vertical = (p: Point, q: Point) => Math.abs(p[0] - q[0]) < SNAP;
  const overlap = (a0: number, a1: number, b0: number, b1: number) =>
    Math.min(Math.max(a0, a1), Math.max(b0, b1)) -
      Math.max(Math.min(a0, a1), Math.min(b0, b1)) >
    SNAP;
  if (horizontal(a, b) && horizontal(c, d) && Math.abs(a[1] - c[1]) < SNAP)
    return overlap(a[0], b[0], c[0], d[0]);
  if (vertical(a, b) && vertical(c, d) && Math.abs(a[0] - c[0]) < SNAP)
    return overlap(a[1], b[1], c[1], d[1]);
  return false;
}

const labelBox = ([x, y]: Point, text: string): Box => {
  const w = textWidth(text, RAIL_LABEL_SIZE) + LABEL_PAD_X;
  return {
    x0: x - w / 2,
    y0: y - LABEL_H / 2,
    x1: x + w / 2,
    y1: y + LABEL_H / 2,
  };
};

/** Keep a rerouted rail's label beside a clear run, rather than its old ELK run. */
function labelOnRoute(
  points: readonly Point[],
  text: string,
  obstacles: readonly Box[]
): Point | undefined {
  const runs = segments(points);
  const width = textWidth(text, RAIL_LABEL_SIZE) + LABEL_PAD_X;
  for (const [a, b] of [...runs].sort(
    (s, t) => Math.abs(t[1][0] - t[0][0]) - Math.abs(s[1][0] - s[0][0])
  )) {
    const x = (a[0] + b[0]) / 2;
    const y = (a[1] + b[1]) / 2;
    const positions = (lo: number, hi: number, half: number, axis: 0 | 1) => [
      (lo + hi) / 2,
      ...[
        lo + half + 5,
        hi - half - 5,
        ...obstacles.flatMap((e) =>
          axis === 0
            ? [e.x0 - half - 5, e.x1 + half + 5]
            : [e.y0 - half - 5, e.y1 + half + 5]
        ),
      ].filter((n) => n >= lo + half && n <= hi - half),
    ];
    const candidates: Point[] =
      Math.abs(a[1] - b[1]) < SNAP
        ? positions(
            Math.min(a[0], b[0]),
            Math.max(a[0], b[0]),
            width / 2,
            0
          ).flatMap((x): Point[] => [
            [x, y - LABEL_LIFT],
            [x, y + LABEL_LIFT],
          ])
        : positions(
            Math.min(a[1], b[1]),
            Math.max(a[1], b[1]),
            LABEL_H / 2,
            1
          ).flatMap((y): Point[] => [
            [x + width / 2 + 5, y],
            [x - width / 2 - 5, y],
          ]);
    for (const at of candidates) {
      const box = labelBox(at, text);
      if (![...obstacles, ...runs.map(segmentBox)].some((e) => crosses(box, e)))
        return at;
    }
  }
  return undefined;
}

/**
 * ELK hangs a rail's label on a dummy node in the middle layer, and the
 * top-left alignment can lift that dummy above the rails beside it, so the
 * rail climbs over its neighbours and drops back down. When a left-to-right
 * rail leaves the band between its two ports, redraw it as a single step
 * between them: along the source's row, one vertical, along the target's row
 * with the label above that last run. The step may share its first run only
 * with rails leaving the same port (a fork); it must not cross a part, and
 * its label must stay clear of parts, rails and labels. Otherwise ELK's route
 * stands.
 */
function straightened(
  route: RailRoute,
  o: StraightenInput
): RailRoute | undefined {
  const { from, to, label } = o;
  if (o.fromSide !== "E" || o.toSide !== "W" || from[0] >= to[0]) return;
  const [lo, hi] = [Math.min(from[1], to[1]), Math.max(from[1], to[1])];
  if (route.points.every(([, y]) => y >= lo - SNAP && y <= hi + SNAP)) return;
  const [portFrom, portTo] = [
    route.points[0],
    route.points[route.points.length - 1],
  ];
  const labelW = label ? textWidth(label, RAIL_LABEL_SIZE) + LABEL_PAD_X : 0;
  const elkVerticals = segments(route.points)
    .filter(([a, b]) => Math.abs(a[0] - b[0]) < SNAP)
    .map(([a]) => a[0]);
  const candidates = [
    ...elkVerticals.sort((a, b) => b - a),
    to[0] - labelW - 2 * LANE_STUB,
    (from[0] + to[0]) / 2,
    from[0] + LANE_STUB,
  ].filter((x) => x > from[0] + SNAP && x < to[0] - SNAP);
  const theirs = o.others.flatMap((q) =>
    segments(q.route.points).map((s) => ({ s, sharesSource: q.sharesSource }))
  );
  const theirLabels = o.others.flatMap((q) =>
    q.route.labelAt && q.label ? [labelBox(q.route.labelAt, q.label)] : []
  );
  for (const x of candidates) {
    const trunk: Segment = [from, [x, from[1]]];
    const step: Segment = [
      [x, from[1]],
      [x, to[1]],
    ];
    const run: Segment = [[x, to[1]], to];
    const mine = [trunk, step, run];
    if (mine.some((s) => o.extents.some((e) => crosses(segmentBox(s), e))))
      continue;
    const sharedBadly = mine.some((s) =>
      theirs.some((t) => collinear(s, t.s) && !(s === trunk && t.sharesSource))
    );
    if (sharedBadly) continue;
    let labelAt: Point | undefined;
    if (label) {
      if (to[0] - x < labelW + LANE_STUB) continue;
      labelAt = [(x + to[0]) / 2, to[1] - LABEL_LIFT];
      const box = labelBox(labelAt, label);
      const blocked =
        o.extents.some((e) => crosses(box, e)) ||
        theirLabels.some((l) => crosses(box, l)) ||
        [...theirs.map((t) => t.s), trunk, step].some((s) =>
          crosses(box, segmentBox(s))
        );
      if (blocked) continue;
    }
    return {
      points: dedupe([portFrom, from, trunk[1], run[0], to, portTo]),
      ...(labelAt ? { labelAt } : {}),
    };
  }
  return undefined;
}

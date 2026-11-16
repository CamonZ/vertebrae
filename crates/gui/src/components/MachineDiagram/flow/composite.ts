/**
 * Two-level layout for flows made of regions (the Atlas machine graph: one
 * region per workflow, with handoffs between them).
 *
 * Laying out the whole flow at once routes every cross-region rail against
 * every part and rail of the factory, which costs seconds to minutes for a
 * few hundred parts. Here each region is laid out on its own with the full
 * engine (memoized and persisted per region, so editing one workflow
 * recomputes only that workflow), then the regions are placed as boxes, and
 * only the rails between regions are routed: around the other regions'
 * boxes and through the parts and rails of the two regions they connect.
 */
import type { ElkNode } from "elkjs/lib/elk.bundled.js";
import { elk } from "../../../hooks/useElkLayout";
import type { Point, PortSide } from "../route";
import type {
  CompiledFlow,
  DiagramRail,
  DiagramTimeline,
  LevelLayout,
  RailRoute,
} from "./compile";
import { crossingJumps } from "./crossings";
import {
  CROSS_LABEL_SIZE,
  REGION_HEAD,
  canonicalFrameLocal,
  REGION_PAD,
  pad,
  canonicalExtentLocal,
  railLabelText,
  regionLabels,
  union,
  type Box,
} from "./extent";
import {
  DIAGRAM_PAD,
  LANE_GAP,
  LANE_STUB,
  NODE_GAP,
  OUTWARD,
  RAIL_GAP,
  cachedLevel,
  dedupe,
  keptOnCanvas,
  labelBox,
  labelOnRoute,
  layoutFlow,
  layoutLevel,
  legToLane,
  levelKey,
  reservedRuns,
  segments,
  verticalRuns,
  type FlowLayout,
  type FlowLayoutOptions,
} from "./layout";
import type { Position } from "./spec";

/** Bump when the composition below changes its output. */
const COMPOSITE_VERSION = 5;

/**
 * Lay out a flow, composing its top level from per-region layouts when it is
 * made of regions. Drill-downs use the ordinary single-level layout.
 */
export async function layoutFlowComposite(
  flow: CompiledFlow,
  options: FlowLayoutOptions = {}
): Promise<FlowLayout> {
  const arrangements = flow.arrangements;
  // A flat Atlas level (stations, no regions) packs its unconnected pieces.
  if (!composable(arrangements[0]))
    return layoutFlow(flow, { ...options, pack: true });
  const useCache = options.cache !== false;
  const compose = () => layoutComposite(arrangements, useCache);
  const level = useCache
    ? await cachedLevel(
        `composite:${COMPOSITE_VERSION}:${levelKey(arrangements)}`,
        compose
      )
    : await compose();
  const drills: Record<string, FlowLayout> = {};
  for (const p of arrangements[0].parts)
    if (p.drill?.kind === "inline")
      drills[p.id] = await layoutFlow(p.drill.flow, options);
  return Object.keys(drills).length ? { ...level, drills } : level;
}

/** Several disjoint regions covering every part, none placed by hand. */
function composable(d: DiagramTimeline): boolean {
  if (d.regions.length < 2) return false;
  if (d.parts.some((p) => p.positioned === "given")) return false;
  const seen = new Set<string>();
  for (const g of d.regions)
    for (const p of g.parts) {
      if (seen.has(p)) return false;
      seen.add(p);
    }
  return d.parts.every((p) => seen.has(p.id));
}

interface Group {
  readonly id: string;
  readonly parts: ReadonlySet<string>;
  readonly inner: readonly DiagramRail[];
  layout: LevelLayout;
  /** Everything the region draws (frame, header, rails, labels), in its own space. */
  occupied: Box;
  offset: Point;
}

async function layoutComposite(
  arrangements: readonly DiagramTimeline[],
  useCache: boolean
): Promise<LevelLayout> {
  const first = arrangements[0];
  const groupOf = new Map<string, string>();
  for (const g of first.regions) for (const p of g.parts) groupOf.set(p, g.id);
  const sameGroup = (r: DiagramRail) =>
    groupOf.get(r.from.part) === groupOf.get(r.to.part);
  const cross = first.rails.filter((r) => !sameGroup(r));
  const labelOf = (id: string) => longestLabel(arrangements, id);
  const localExtent = new Map(
    first.parts.map((p) => [
      p.id,
      union(
        arrangements.map((d) =>
          canonicalExtentLocal(d.parts.find((q) => q.id === p.id)!)
        )
      ),
    ])
  );
  const partById = new Map(first.parts.map((p) => [p.id, p]));

  /* level 1: each region on its own */
  const groups: Group[] = [];
  for (const region of first.regions) {
    const members = new Set(region.parts);
    const inner = first.rails.filter(
      (r) => members.has(r.from.part) && members.has(r.to.part)
    );
    const innerIds = new Set(inner.map((r) => r.id));
    // Parts with no rail inside their region (the workflow's handoff
    // endpoint) dock on the region's east edge instead of taking a row.
    const linked = new Set(inner.flatMap((r) => [r.from.part, r.to.part]));
    const docked = linked.size
      ? region.parts.filter((id) => !linked.has(id))
      : [];
    const laid = new Set(region.parts.filter((id) => !docked.includes(id)));
    const sub = arrangements.map(
      (d): DiagramTimeline => ({
        ...d,
        parts: d.parts.filter((p) => laid.has(p.id)),
        rails: d.rails.filter((r) => innerIds.has(r.id)),
        regions: d.regions
          .filter((g) => g.id === region.id)
          .map((g) => ({ ...g, parts: g.parts.filter((id) => laid.has(id)) })),
      })
    );
    const laidOut = await layoutLevel(sub, useCache);
    const extentAt = (id: string, at: Position): Box => {
      const e = localExtent.get(id)!;
      return {
        x0: at.x + e.x0,
        y0: at.y + e.y0,
        x1: at.x + e.x1,
        y1: at.y + e.y1,
      };
    };
    const shiftBox = (b: Box, at: Position): Box => ({
      x0: at.x + b.x0,
      y0: at.y + b.y0,
      x1: at.x + b.x1,
      y1: at.y + b.y1,
    });
    const anchor = [...laid][0];
    const layout = dock(
      docked,
      laidOut,
      (id) => localExtent.get(id)!,
      (id) => canonicalFrameLocal(partById.get(id)!),
      union([
        ...[...laid].map((id) => extentAt(id, laidOut.positions[id])),
        ...Object.entries(laidOut.routes ?? {}).flatMap(([id, route]) => {
          const text = labelOf(id);
          return [
            ...segments(route.points).map(boxOf),
            ...(route.labelAt && text ? [labelBox(route.labelAt, text)] : []),
          ];
        }),
      ]),
      anchor === undefined
        ? undefined
        : shiftBox(
            canonicalFrameLocal(partById.get(anchor)!),
            laidOut.positions[anchor]
          )
    );
    const frame = pad(
      union(region.parts.map((id) => extentAt(id, layout.positions[id]))),
      REGION_PAD,
      REGION_HEAD
    );
    const drawn = [
      frame,
      ...Object.entries(layout.routes ?? {}).flatMap(([id, route]) => {
        const text = labelOf(id);
        return [
          ...segments(route.points).map(boxOf),
          ...(route.labelAt && text ? [labelBox(route.labelAt, text)] : []),
        ];
      }),
    ];
    groups.push({
      id: region.id,
      parts: members,
      inner,
      layout,
      occupied: union(drawn),
      offset: [0, 0],
    });
  }

  /* level 2: regions as boxes */
  // Gutters only need room for the handoffs that run through them.
  const gap = NODE_GAP + RAIL_GAP * Math.min(cross.length, 6);
  const links = new Map<string, { from: string; to: string }>();
  for (const r of cross) {
    const from = groupOf.get(r.from.part)!;
    const to = groupOf.get(r.to.part)!;
    links.set(`${from}\u0000${to}`, { from, to });
  }
  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.layered.cycleBreaking.strategy": "MODEL_ORDER",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.spacing.nodeNode": String(NODE_GAP),
      "elk.layered.spacing.nodeNodeBetweenLayers": String(gap),
      "elk.padding": `[top=${DIAGRAM_PAD},left=${DIAGRAM_PAD},bottom=${DIAGRAM_PAD},right=${DIAGRAM_PAD}]`,
    },
    children: groups.map((g) => ({
      id: g.id,
      width: g.occupied.x1 - g.occupied.x0,
      height: g.occupied.y1 - g.occupied.y0,
    })),
    edges: [...links.values()].map((l, i) => ({
      id: `link${i}`,
      sources: [l.from],
      targets: [l.to],
    })),
  };
  const laid = await elk.layout(graph);
  const placed = new Map((laid.children ?? []).map((c) => [c.id, c]));
  for (const g of groups) {
    const c = placed.get(g.id)!;
    g.offset = [(c.x ?? 0) - g.occupied.x0, (c.y ?? 0) - g.occupied.y0];
  }

  /* compose */
  const positions: Record<string, Position> = {};
  const routes: Record<string, RailRoute> = {};
  const move =
    ([dx, dy]: Point) =>
    ([x, y]: Point): Point => [x + dx, y + dy];
  for (const g of groups) {
    const shift = move(g.offset);
    for (const [id, p] of Object.entries(g.layout.positions)) {
      const [x, y] = shift([p.x, p.y]);
      positions[id] = { x, y };
    }
    for (const [id, r] of Object.entries(g.layout.routes ?? {}))
      routes[id] = {
        points: r.points.map(shift),
        ...(r.labelAt ? { labelAt: shift(r.labelAt) } : {}),
        ...(r.cornerRadii ? { cornerRadii: r.cornerRadii } : {}),
      };
  }
  const extentOf = (id: string): Box => {
    const e = localExtent.get(id)!;
    const at = positions[id];
    return {
      x0: at.x + e.x0,
      y0: at.y + e.y0,
      x1: at.x + e.x1,
      y1: at.y + e.y1,
    };
  };
  const boxOfGroup = (g: Group): Box => {
    const [dx, dy] = g.offset;
    const o = g.occupied;
    return { x0: o.x0 + dx, y0: o.y0 + dy, x1: o.x1 + dx, y1: o.y1 + dy };
  };
  const headerOf = (g: Group): Box[] => {
    const region = first.regions.find((r) => r.id === g.id)!;
    const b = pad(union(region.parts.map(extentOf)), REGION_PAD, REGION_HEAD);
    return regionLabels({
      ...region,
      x: b.x0,
      y: b.y0,
      width: b.x1 - b.x0,
      height: b.y1 - b.y0,
    });
  };

  /* level 2 rails: through the two regions they join, around the rest */
  const portAt = (end: DiagramRail["from"]): Point => {
    const part = partById.get(end.part)!;
    const at = positions[end.part];
    const [x, y] = part.ports[end.port].local;
    return [at.x + x * part.scale, at.y + y * part.scale];
  };
  const sideOf = (end: DiagramRail["from"]): PortSide =>
    partById.get(end.part)!.ports[end.port].side;
  const borderAt = (end: DiagramRail["from"]): Point => {
    const [px, py] = portAt(end);
    const e = extentOf(end.part);
    switch (sideOf(end)) {
      case "W":
        return [e.x0, py];
      case "E":
        return [e.x1, py];
      case "N":
        return [px, e.y0];
      case "S":
        return [px, e.y1];
    }
  };
  const stubOf = (end: DiagramRail["from"]): Point => {
    const [x, y] = borderAt(end);
    const [dx, dy] = OUTWARD[sideOf(end)];
    return [x + dx * LANE_STUB, y + dy * LANE_STUB];
  };
  const allExtents = first.parts.map((p) => extentOf(p.id));
  const routedCross: DiagramRail[] = [];
  for (const r of cross) {
    const near = [groupOf.get(r.from.part)!, groupOf.get(r.to.part)!];
    const obstacles: Box[] = [];
    const reservedRails: DiagramRail[] = [...routedCross];
    for (const g of groups) {
      if (!near.includes(g.id)) {
        obstacles.push(boxOfGroup(g));
        continue;
      }
      for (const id of g.parts) obstacles.push(extentOf(id));
      obstacles.push(...headerOf(g));
      for (const q of g.inner) {
        const route = routes[q.id];
        const text = labelOf(q.id);
        if (!route) continue;
        reservedRails.push(q);
        if (route.labelAt && text)
          obstacles.push(labelBox(route.labelAt, text));
      }
    }
    const runs = reservedRails.flatMap((q) =>
      reservedRuns(r, q, routes[q.id].points)
    );
    const verticals = reservedRails.flatMap((q) =>
      verticalRuns(routes[q.id].points)
    );
    const horizontals = runs.filter(([a, b]) => Math.abs(a[1] - b[1]) < 0.5);
    const exit = stubOf(r.from);
    const entry = stubOf(r.to);
    const middle =
      legToLane(
        exit,
        sideOf(r.from),
        entry[1],
        obstacles,
        verticals,
        horizontals,
        {
          point: entry,
          side: sideOf(r.to),
        }
      ) ?? degraded(exit, entry, sideOf(r.from), sideOf(r.to), allExtents);
    if (!middle) continue;
    const points = unspiked(
      dedupe([
        portAt(r.from),
        borderAt(r.from),
        ...middle,
        borderAt(r.to),
        portAt(r.to),
      ])
    );
    const text = labelOf(r.id);
    const labelAt = text
      ? labelOnRoute(
          points,
          text,
          [
            ...obstacles,
            ...reservedRails.flatMap((q) =>
              segments(routes[q.id].points).map(boxOf)
            ),
            // Handoffs already placed: their labels too.
            ...routedCross.flatMap((q) => {
              const at = routes[q.id].labelAt;
              const own = labelOf(q.id);
              return at && own ? [labelBox(at, own, CROSS_LABEL_SIZE)] : [];
            }),
          ],
          CROSS_LABEL_SIZE
        )
      : undefined;
    routes[r.id] = { points, ...(labelAt ? { labelAt } : {}) };
    routedCross.push(r);
  }

  const kept = keptOnCanvas(positions, routes, allExtents, labelOf);
  const ids = first.rails.filter((r) => kept.routes?.[r.id]).map((r) => r.id);
  const jumps = crossingJumps(ids.map((id) => kept.routes![id].points));
  return {
    positions: kept.positions,
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
 * Place docked parts in a column just east of everything the region drew,
 * the first centred on the anchor part's frame (the region's main row).
 */
function dock(
  docked: readonly string[],
  layout: LevelLayout,
  extentOf: (id: string) => Box,
  frameOf: (id: string) => Box,
  drawn: Box,
  anchor: Box | undefined
): LevelLayout {
  if (!docked.length) return layout;
  const centre = anchor
    ? (anchor.y0 + anchor.y1) / 2
    : (drawn.y0 + drawn.y1) / 2;
  const positions = { ...layout.positions };
  let below: number | undefined;
  for (const id of docked) {
    const e = extentOf(id);
    const f = frameOf(id);
    const y = below === undefined ? centre - (f.y0 + f.y1) / 2 : below - e.y0;
    positions[id] = { x: drawn.x1 + NODE_GAP - e.x0, y };
    below = y + e.y1 + NODE_GAP;
  }
  return { ...layout, positions };
}

/** Legs from both stubs to a lane below every part; crossings get jumps. */
function degraded(
  exit: Point,
  entry: Point,
  fromSide: PortSide,
  toSide: PortSide,
  parts: readonly Box[]
): Point[] | undefined {
  const lane = union(parts).y1 + LANE_GAP;
  const out = legToLane(exit, fromSide, lane, parts, [], []);
  const home = legToLane(entry, toSide, lane, parts, [], []);
  return out && home ? [...out, ...[...home].reverse()] : undefined;
}

/**
 * Drop corners where a route runs along a line and comes back on it (the
 * degraded route's legs meet on one line when both ends share it). The
 * shortened path lies within the run it doubled back on, so it stays clear.
 */
export function unspiked(points: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    out.push(p);
    while (out.length >= 3) {
      const [a, b, c] = out.slice(-3);
      const collinear =
        (Math.abs(a[0] - b[0]) < 0.5 && Math.abs(b[0] - c[0]) < 0.5) ||
        (Math.abs(a[1] - b[1]) < 0.5 && Math.abs(b[1] - c[1]) < 0.5);
      const back =
        (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) < 0;
      if (!collinear || !back) break;
      out.splice(out.length - 2, 1);
    }
  }
  return out;
}

function boxOf([a, b]: readonly [Point, Point]): Box {
  return {
    x0: Math.min(a[0], b[0]),
    y0: Math.min(a[1], b[1]),
    x1: Math.max(a[0], b[0]),
    y1: Math.max(a[1], b[1]),
  };
}

function longestLabel(
  arrangements: readonly DiagramTimeline[],
  id: string
): string | undefined {
  let best: string | undefined;
  for (const d of arrangements) {
    const rail = d.rails.find((r) => r.id === id);
    const text =
      rail && rail.presence !== "absent" ? railLabelText(rail) : undefined;
    if (text !== undefined && text.length > (best?.length ?? -1)) best = text;
  }
  return best;
}

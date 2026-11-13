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
 *   rails in lanes along the bottom of the diagram: each leg finds its way
 *   between the parts to its lane and keeps a rail gap from other rails, so
 *   a self-loop draws as a loop beside its part.
 * - A labelled rail that ELK lifts over its neighbours to reach its label
 *   slot is redrawn as one step between its ports (a fork off a shared port).
 * - Regions are compound nodes with the root's spacing; rail labels are ELK
 *   edge labels.
 * - Parts with a hand-given position keep it, and rails touching them keep
 *   the compiler's `railBetween` route. Each drill-down level is laid out
 *   on its own.
 */
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
/** First return lane under everything else, then one lane per return rail. */
export const LANE_GAP = 40;
export const LANE_STEP = 56;
/** How far a return rail leaves its port before turning. */
export const LANE_STUB = 20;
const LABEL_PAD_X = 12;
/** Space between parallel rails (ELK edge-edge spacing). */
const RAIL_GAP = 20;
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

/**
 * Rails that run against the flow: DFS from each part in spec order over
 * rails in spec order; a rail into a part still on the stack closes a loop.
 */
export function returnRails(
  parts: readonly { id: string }[],
  rails: readonly { id: string; from: string; to: string }[]
): Set<string> {
  const out = new Map<string, { id: string; to: string }[]>();
  for (const r of rails) {
    const list = out.get(r.from) ?? [];
    list.push(r);
    out.set(r.from, list);
  }
  const state = new Map<string, "open" | "done">();
  const back = new Set<string>();
  const visit = (id: string) => {
    state.set(id, "open");
    for (const r of out.get(id) ?? []) {
      const s = state.get(r.to);
      if (s === "open") back.add(r.id);
      else if (s === undefined) visit(r.to);
    }
    state.set(id, "done");
  };
  for (const p of parts) if (!state.has(p.id)) visit(p.id);
  return back;
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
export async function layoutFlow(flow: CompiledFlow): Promise<FlowLayout> {
  const level = await layoutLevel(flow.arrangements);
  const drills: Record<string, FlowLayout> = {};
  for (const p of flow.arrangements[0].parts)
    if (p.drill?.kind === "inline")
      drills[p.id] = await layoutFlow(p.drill.flow);
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

async function layoutLevel(
  arrangements: readonly DiagramTimeline[]
): Promise<LevelLayout> {
  const first = arrangements[0];
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
  const labelOf = (id: string) =>
    arrangements
      .map((d) => {
        const r = d.rails.find((q) => q.id === id);
        return r && r.presence !== "absent" ? railLabelText(r) : undefined;
      })
      .reduce<string | undefined>(
        (a, b) => (b !== undefined && b.length > (a?.length ?? -1) ? b : a),
        undefined
      );

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
        legToLane(
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

  /* return rails along the bottom */
  const below: Box[] = [
    ...extents,
    ...[...abs]
      .filter(([id]) => id.startsWith("region:"))
      .map(([id, at]) => {
        const g = laid.children?.find((c) => c.id === id);
        return {
          x0: at.x,
          y0: at.y,
          x1: at.x + (g?.width ?? 0),
          y1: at.y + (g?.height ?? 0),
        };
      }),
    ...Object.values(routes).flatMap((r) => [
      ...r.points.map(([x, y]) => ({ x0: x, y0: y, x1: x, y1: y })),
      ...(r.labelAt
        ? [
            {
              x0: r.labelAt[0],
              y0: r.labelAt[1] - (RAIL_LABEL_SIZE * LINE_EM) / 2,
              x1: r.labelAt[0],
              y1: r.labelAt[1] + (RAIL_LABEL_SIZE * LINE_EM) / 2,
            },
          ]
        : []),
    ]),
  ];
  let lane = union(below).y1 + LANE_GAP;
  const routedReturns: DiagramRail[] = [];
  for (const r of rails) {
    if (!back.has(r.id) || touchesGiven(r)) continue;
    const fromSide = nodes.get(r.from.part)!.part.ports[r.from.port].side;
    const toSide = nodes.get(r.to.part)!.part.ports[r.to.port].side;
    const bf = borderAt(r.from.part, r.from.port);
    const bt = borderAt(r.to.part, r.to.port);
    const exit: Point = [
      bf[0] + OUTWARD[fromSide][0] * LANE_STUB,
      bf[1] + OUTWARD[fromSide][1] * LANE_STUB,
    ];
    const entry: Point = [
      bt[0] + OUTWARD[toSide][0] * LANE_STUB,
      bt[1] + OUTWARD[toSide][1] * LANE_STUB,
    ];
    // Each leg finds its own way between the parts from its stub down to
    // the lane, keeping clear of rails already drawn — including this rail's
    // first leg, so a self-loop comes back up beside itself.
    // A shared port may keep its fork/join stub. Otherwise reserve every
    // horizontal run too: separate bottom lanes alone do not keep the
    // intermediate steps of their legs from merging.
    const reserved = [...accepted, ...routedReturns].flatMap((q) =>
      reservedRuns(r, q, routes[q.id].points)
    );
    const verticals = reserved.flatMap((s) => verticalRuns(s));
    const horizontals = reserved.filter(
      ([a, b]) => Math.abs(a[1] - b[1]) < SNAP
    );
    const out =
      legToLane(exit, fromSide, lane, extents, verticals, horizontals) ??
      fallbackLeg(exit, fromSide, lane, verticals);
    const homeVerticals = [
      ...verticals,
      ...verticalRuns(
        // A same-port loop can share its first straight run, then fork.
        r.from.part === r.to.part && r.from.port === r.to.port
          ? out.slice(Math.max(0, portRunEnd(out) - 1))
          : out
      ),
    ];
    const home =
      legToLane(entry, toSide, lane, extents, homeVerticals, horizontals) ??
      fallbackLeg(entry, toSide, lane, homeVerticals);
    const [downAt, upAt] = [out[out.length - 1][0], home[home.length - 1][0]];
    routes[r.id] = {
      points: dedupe([
        portAt(r.from.part, r.from.port),
        bf,
        ...out,
        ...[...home].reverse(),
        bt,
        portAt(r.to.part, r.to.port),
      ]),
      ...(labelOf(r.id)
        ? {
            labelAt: [(downAt + upAt) / 2, lane + RAIL_LABEL_DY] as Point,
          }
        : {}),
    };
    routedReturns.push(r);
    lane += LANE_STEP;
  }
  return keptOnCanvas(positions, routes, extents, labelOf);
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

/**
 * A return-rail leg for when no way to the lane was found: straight down
 * from its stub. If that drop would run along a reserved vertical (another
 * rail, or this rail's own first leg), leave the stub early instead: drop
 * from its middle for a sideways port, or one rail gap aside for a port on
 * the top or bottom. Crossings stay possible; running along a rail does not.
 */
function fallbackLeg(
  stub: Point,
  side: PortSide,
  lane: number,
  verticals: readonly VerticalRun[]
): Point[] {
  const blocked = verticals.some(
    (v) =>
      Math.abs(v.x - stub[0]) < SNAP &&
      v.y0 < Math.max(stub[1], lane) - SNAP &&
      Math.min(stub[1], lane) + SNAP < v.y1
  );
  if (!blocked) return [stub, [stub[0], lane]];
  const [outward] = OUTWARD[side];
  if (outward !== 0) {
    const x = stub[0] - (outward * LANE_STUB) / 2;
    return [
      [x, stub[1]],
      [x, lane],
    ];
  }
  const x = stub[0] + RAIL_GAP;
  return [stub, [x, stub[1]], [x, lane]];
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
 * horizontal stretch. Dijkstra over lines around part edges and reserved
 * runs, with a cost per bend; undefined when the stub is boxed in.
 */
function legToLane(
  stub: Point,
  side: PortSide,
  lane: number,
  extents: readonly Box[],
  verticals: readonly VerticalRun[],
  horizontals: readonly Segment[],
  target?: { point: Point; side: PortSide }
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
    ...horizontals.flatMap(([a, b]) => [a[0] - RAIL_GAP, b[0] + RAIL_GAP]),
    ...extents.flatMap((e) => [e.x0 - LANE_STUB, e.x1 + LANE_STUB]),
    ...verticals.flatMap((v) => [v.x - RAIL_GAP, v.x + RAIL_GAP]),
  ]);
  // A stub can sit between an existing vertical and a part. Let the leg
  // climb around the vertical's end before descending, rather than treating
  // the stub's row as the top of the search and falling back through rails.
  const ys = uniq([
    stub[1],
    ...(target ? [target.point[1]] : []),
    lane,
    ...verticals.flatMap((v) => [v.y0 - RAIL_GAP, v.y1 + RAIL_GAP]),
    ...horizontals.flatMap(([a]) => [a[1] - RAIL_GAP, a[1] + RAIL_GAP]),
    ...extents.flatMap((e) => [e.y0 - LANE_STUB, e.y1 + LANE_STUB]),
  ]).filter((y) => y <= lane + SNAP);
  const sx = xs.findIndex((x) => Math.abs(x - stub[0]) < 0.01);
  const sy = ys.findIndex((y) => Math.abs(y - stub[1]) < 0.01);
  const goal = ys.length - 1;
  if (sx < 0 || sy < 0) return undefined;
  const inside = (x: number, y: number) =>
    parts.some((e) => e.x0 < x && x < e.x1 && e.y0 < y && y < e.y1);
  const free = (a: Point, b: Point) => {
    const box = segmentBox([a, b]);
    if (parts.some((e) => crosses(box, e))) return false;
    if (a[1] === b[1]) return !horizontals.some((s) => collinear([a, b], s));
    return !verticals.some(
      (v) =>
        Math.abs(v.x - a[0]) < RAIL_GAP - SNAP &&
        v.y0 < box.y1 - SNAP &&
        box.y0 + SNAP < v.y1
    );
  };
  // state: (ix, iy, heading), heading 0 at the start, else 1 + index in MOVES
  const key = (ix: number, iy: number, h: number) =>
    (iy * xs.length + ix) * 5 + h;
  const cost = new Map<number, number>();
  const from = new Map<number, number>();
  const heap = new MinHeap();
  const start = key(sx, sy, 0);
  cost.set(start, 0);
  heap.push(0, start);
  while (heap.size > 0) {
    const [c, k] = heap.pop();
    if (c > (cost.get(k) ?? Infinity)) continue;
    const h = k % 5;
    const cell = (k - h) / 5;
    const [ix, iy] = [cell % xs.length, Math.floor(cell / xs.length)];
    const arrived = target
      ? Math.abs(xs[ix] - target.point[0]) < 0.01 &&
        Math.abs(ys[iy] - target.point[1]) < 0.01 &&
        h !== 0 &&
        MOVES[h - 1][0] * OUTWARD[target.side][0] +
          MOVES[h - 1][1] * OUTWARD[target.side][1] <=
          0
      : iy === goal;
    if (arrived) {
      const path: Point[] = [];
      for (
        let at: number | undefined = k;
        at !== undefined;
        at = from.get(at)
      ) {
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
      const [nx, ny] = [ix + dx, iy + dy];
      if (nx < 0 || ny < 0 || nx >= xs.length || ny >= ys.length) continue;
      const a: Point = [xs[ix], ys[iy]];
      const b: Point = [xs[nx], ys[ny]];
      if (inside(b[0], b[1]) || !free(a, b)) continue;
      const nh = m + 1;
      const nc =
        c +
        Math.abs(b[0] - a[0]) +
        Math.abs(b[1] - a[1]) +
        (h !== 0 && h !== nh ? BEND_COST : 0);
      const nk = key(nx, ny, nh);
      if (nc < (cost.get(nk) ?? Infinity)) {
        cost.set(nk, nc);
        from.set(nk, k);
        heap.push(nc, nk);
      }
    }
  }
  return undefined;
}

/** A binary min-heap of (priority, value) pairs. */
class MinHeap {
  private readonly items: [number, number][] = [];
  get size() {
    return this.items.length;
  }
  push(priority: number, value: number) {
    const a = this.items;
    a.push([priority, value]);
    for (let i = a.length - 1; i > 0; ) {
      const up = (i - 1) >> 1;
      if (a[up][0] <= a[i][0]) break;
      [a[up], a[i]] = [a[i], a[up]];
      i = up;
    }
  }
  pop(): [number, number] {
    const a = this.items;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      for (let i = 0; ; ) {
        const [l, r] = [2 * i + 1, 2 * i + 2];
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
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
    const candidates: Point[] =
      Math.abs(a[1] - b[1]) < SNAP
        ? [
            [x, y - LABEL_LIFT],
            [x, y + LABEL_LIFT],
          ]
        : [
            [x + width / 2 + 5, y],
            [x - width / 2 - 5, y],
          ];
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

/**
 * Turning a laid-out level for a flow direction other than left to right.
 * Layout (by hand or by ELK) happens in the canonical left-to-right frame;
 * the compiler then maps cells and routes through one diagram turn `D` with
 * the same linear part as each part's own turn, so every port lands where
 * its turned part draws it.
 *
 * Two things are not a plain map:
 * - The translation of `D` is chosen so the turned picture keeps the
 *   canonical margins (swapped with the axes) and never reaches negative
 *   coordinates; measuring needs one compile, so the level is arranged
 *   twice.
 * - Down and up turn rails vertical, but rail labels stay horizontal text,
 *   so each label is placed again beside its turned route, clear of parts,
 *   rails and the labels placed before it. Rails between hand-placed parts
 *   get a placed label too (a mirror keeps the canonical label spots).
 */
import type { Point, PortSide } from "../route";
import {
  apply,
  applyBox,
  invert,
  linearTurn,
  transposes,
  turnSide,
  type Affine,
  type FlowDirection,
} from "../orientation";
import { PART_HEIGHT, PART_WIDTH } from "../partGeometry";
import type { DiagramPart, DiagramTimeline, RailRoute } from "./compile";
import {
  REGION_HEAD,
  REGION_PAD,
  pad,
  partExtent,
  partFrame,
  partGates,
  partLabels,
  railLabelText,
  regionLabels,
  union,
  type Box,
  type LabelBox,
} from "./extent";
import {
  crosses,
  labelBox,
  labelOnRoute,
  segmentBox,
  segments,
} from "./labelPlacement";
import type { Position, RegionSpec } from "./spec";

/** Top-left of a turned cell, from its canonical top-left. */
export function turnCell(m: Affine, at: Position, scale: number): Position {
  const b = applyBox(m, {
    x0: at.x,
    y0: at.y,
    x1: at.x + PART_WIDTH * scale,
    y1: at.y + PART_HEIGHT * scale,
  });
  return { x: b.x0, y: b.y0 };
}

export function turnRoute(m: Affine, r: RailRoute): RailRoute {
  return {
    ...r,
    points: r.points.map((p) => apply(m, p)),
    ...(r.labelAt ? { labelAt: apply(m, r.labelAt) } : {}),
    ...(r.jumps
      ? { jumps: r.jumps.map((j) => ({ ...j, at: apply(m, j.at) })) }
      : {}),
  };
}

export interface TurnInput {
  readonly direction: FlowDirection;
  /** Canonical cell top-lefts, by part. */
  readonly cells: ReadonlyMap<string, Position>;
  readonly scales: ReadonlyMap<string, number>;
  /** Canonical routes, by rail. */
  readonly routes: Readonly<Record<string, RailRoute>>;
  readonly regions: readonly RegionSpec[];
  /** Arrange every arrangement with turned cells and routes. */
  readonly arrange: (
    cells: ReadonlyMap<string, Position>,
    routes: Readonly<Record<string, RailRoute>>,
    measuring: boolean
  ) => DiagramTimeline[];
}

/** Arrange a level turned for `direction` (not `right`). */
export function arrangeTurned(o: TurnInput): DiagramTimeline[] {
  const at = (m: Affine) => {
    const cells = new Map<string, Position>();
    for (const [id, c] of o.cells)
      cells.set(id, turnCell(m, c, o.scales.get(id) ?? 1));
    return cells;
  };
  const routesAt = (m: Affine, routes: Readonly<Record<string, RailRoute>>) =>
    Object.fromEntries(
      Object.entries(routes).map(([id, r]) => [id, turnRoute(m, r)])
    );

  const m0 = linearTurn(o.direction);
  let routes = routesAt(m0, o.routes);
  const measured = o.arrange(at(m0), routes, true);
  if (transposes(o.direction)) routes = relabel(measured, routes, o.regions);

  const content = contentBoxes(measured, routes, o.regions);
  const turned = union(content);
  const canonical = union(content.map((b) => applyBox(invert(m0), b)));
  const target: Point = transposes(o.direction)
    ? [canonical.y0, canonical.x0]
    : [canonical.x0, canonical.y0];
  const dx = Math.max(0, target[0]) - turned.x0;
  const dy = Math.max(0, target[1]) - turned.y0;
  const m = linearTurn(o.direction, dx, dy);
  const shift = linearTurn("right", dx, dy);
  return o.arrange(at(m), routesAt(shift, routes), false);
}

/** Everything a turned level draws that must stay on the canvas. */
function contentBoxes(
  arranged: readonly DiagramTimeline[],
  routes: Readonly<Record<string, RailRoute>>,
  regions: readonly RegionSpec[]
): Box[] {
  const out: Box[] = [];
  for (const d of arranged) {
    out.push(...d.parts.map(partExtent));
    for (const r of d.rails) {
      out.push(...r.points.map(([x, y]) => ({ x0: x, y0: y, x1: x, y1: y })));
      const text = railLabelText(r);
      const labelAt = routes[r.id]?.labelAt;
      if (text && labelAt) out.push(labelBox(labelAt, text));
    }
  }
  return [...out, ...regionFrames(arranged, regions)];
}

/** Region frames (over every arrangement, as the compiler draws them) and their names. */
function regionFrames(
  arranged: readonly DiagramTimeline[],
  regions: readonly RegionSpec[]
): (Box | LabelBox)[] {
  return regions.flatMap((g) => {
    const inside = arranged.flatMap((d) =>
      d.parts.filter((p) => g.parts.includes(p.id))
    );
    if (!inside.length) return [];
    const b = pad(union(inside.map(partExtent)), REGION_PAD, REGION_HEAD);
    return [
      b,
      ...regionLabels({
        ...g,
        x: b.x0,
        y: b.y0,
        width: b.x1 - b.x0,
        height: b.y1 - b.y0,
      }),
    ];
  });
}

/**
 * Place every routed label again beside its turned route: clear of every
 * part, every other rail and the labels placed before it. A label with no
 * clear spot keeps its turned position.
 */
function relabel(
  arranged: readonly DiagramTimeline[],
  routes: Readonly<Record<string, RailRoute>>,
  regions: readonly RegionSpec[]
): Record<string, RailRoute> {
  const first = arranged[0];
  // What is drawn: frames, gate pills and part labels in every arrangement.
  const solids: Box[] = arranged.flatMap((d) =>
    d.parts
      .filter((p) => p.presence !== "absent")
      .flatMap((p) => [partFrame(p), ...partGates(p), ...partLabels(p)])
  );
  // Region borders and names (a label may sit inside a region, not on its edge).
  for (const b of regionFrames(arranged, regions)) {
    if ("text" in b) {
      solids.push(b);
      continue;
    }
    const e = 1;
    solids.push(
      { x0: b.x0 - e, y0: b.y0 - e, x1: b.x1 + e, y1: b.y0 + e },
      { x0: b.x0 - e, y0: b.y1 - e, x1: b.x1 + e, y1: b.y1 + e },
      { x0: b.x0 - e, y0: b.y0 - e, x1: b.x0 + e, y1: b.y1 + e },
      { x0: b.x1 - e, y0: b.y0 - e, x1: b.x1 + e, y1: b.y1 + e }
    );
  }
  const text = (id: string) =>
    arranged
      .map((d) => {
        const r = d.rails.find((q) => q.id === id);
        return r && r.presence !== "absent" ? railLabelText(r) : undefined;
      })
      .reduce<string | undefined>(
        (a, b) => (b !== undefined && b.length > (a?.length ?? -1) ? b : a),
        undefined
      );
  const out: Record<string, RailRoute> = { ...routes };
  const placed: Box[] = [];
  for (const r of first.rails) {
    // A rail between hand-placed parts has no route; give it one so its
    // label is placed too.
    const route = routes[r.id] ?? { points: r.points };
    const label = text(r.id);
    if (!label) continue;
    const others = first.rails
      .filter((q) => q.id !== r.id)
      .flatMap((q) => segments(routes[q.id]?.points ?? q.points))
      .map(segmentBox);
    const obstacles = [...solids, ...others, ...placed];
    const spot =
      labelOnRoute(route.points, label, obstacles) ??
      nearestClear(route.points, label, obstacles);
    const labelAt = spot ?? route.labelAt;
    if (!labelAt) continue;
    out[r.id] = { ...route, labelAt };
    placed.push(labelBox(labelAt, label));
  }
  return out;
}

/** The side a part's port faces as drawn (its part-space side, turned). */
export function portFacing(
  part: Pick<DiagramPart, "direction" | "ports">,
  port: string
): PortSide {
  return turnSide(part.direction ?? "right", part.ports[port].side);
}

/** Farthest the fallback looks from a route for a free label spot. */
const FALLBACK_REACH = 320;
const FALLBACK_STEP = 8;

/**
 * The free spot nearest a route's midpoint, on a grid out to
 * FALLBACK_REACH, clear of every obstacle and of the route itself.
 */
function nearestClear(
  points: readonly Point[],
  text: string,
  obstacles: readonly Box[]
): Point | undefined {
  const runs = segments(points).map(segmentBox);
  const all = [...obstacles, ...runs];
  const b = union(runs);
  const [cx, cy] = [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];
  let best: { at: Point; d: number } | undefined;
  for (let dx = -FALLBACK_REACH; dx <= FALLBACK_REACH; dx += FALLBACK_STEP)
    for (let dy = -FALLBACK_REACH; dy <= FALLBACK_REACH; dy += FALLBACK_STEP) {
      const d = Math.hypot(dx, dy);
      if (best && d >= best.d) continue;
      const at: Point = [cx + dx, cy + dy];
      const box = labelBox(at, text);
      if (!all.some((e) => crosses(box, e))) best = { at, d };
    }
  return best?.at;
}

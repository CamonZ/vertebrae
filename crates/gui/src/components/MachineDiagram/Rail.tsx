import type { CSSProperties } from "react";
import { GraphEdge } from "../WorkflowAtlas/GraphEdge";
import type { Role } from "./palette";
import { SvgText, Glyph } from "./SvgText";
import { usePart } from "./partContext";
import { PART_WIDTH } from "./partGeometry";
import { route, routePath, type Point, type RouteStyle } from "./route";

export interface RailProps extends RouteStyle {
  points: readonly Point[];
  /** Conditional lane (deny, undo, escalate, stop, host call). */
  dashed?: boolean;
  /** Custom dash pattern for a dashed lane, e.g. "4 6". */
  dash?: string;
  /**
   * A gallery lead a flow replaces with its own wire, for a lead that does
   * not run to the cell edge (see `mechanismPieces`).
   */
  lead?: boolean;
}

/**
 * A rail inside a part: rounded corners (r 22), solid 2.5 px. Rendered with
 * the shared GraphEdge path so stroke styling stays class-driven. Rails of a
 * removed or absent part turn dashed (VL-05).
 */
export function Rail({
  points,
  dashed,
  dash,
  jumps,
  cornerRadii,
  lead,
}: RailProps) {
  const { removed, inFlow, leadPorts, leadFrame } = usePart();
  // Flows draw their own wires to the ports; a part's own tracks stay.
  const pieces =
    inFlow && lead
      ? []
      : inFlow
        ? mechanismPieces(points, leadPorts, leadFrame)
        : [points];
  if (pieces.length === 0) return null;
  const isDashed = dashed || removed;
  const style =
    dash && dashed ? ({ "--md-dash": dash } as CSSProperties) : undefined;
  // A clipped rail loses its vertex indices; keep jumps and radii only whole.
  const whole = pieces.length === 1 && pieces[0] === points;
  return (
    <g className="md-rail" style={style}>
      {pieces.map((piece, i) => (
        <GraphEdge
          key={i}
          d={routePath(
            route(piece, undefined, whole ? { jumps, cornerRadii } : {})
          )}
          kind={isDashed ? "handoff" : "step"}
          solid={!isDashed}
          markerEnd={null}
        />
      ))}
    </g>
  );
}

/** Within this of a port or frame edge, a rail end is on it. */
const SNAP = 2;
type Frame = readonly [number, number, number, number];

/**
 * Gallery leads run to the cell's west or east edge (x 24 and 600–616),
 * where the gallery's neighbours would be. A rail that stays inside this
 * band links the part to something it draws itself.
 */
const EDGE_BAND = 44;

/**
 * What of a gallery rail a flow draws: the part's own mechanism, without
 * the leads that stand in for connections the flow draws as wires.
 *
 * - A rail that never reaches the cell's west or east edge is mechanism,
 *   or a link to a collaborator the part draws in its cell (an origin, a
 *   service, a reviewer box): it stays whole.
 * - A rail that reaches an edge is cut back to the frame on that side, so
 *   a lead running out of the part goes and a track drawn through it keeps
 *   its inside and any link on the other side; a piece left that runs from
 *   a port without entering the frame (a lead to a north or south port)
 *   goes too.
 *
 * Without ports and frame (a flow that does not say), nothing draws.
 */
export function mechanismPieces(
  points: readonly Point[],
  ports: readonly (readonly [number, number])[] | undefined,
  frame: Frame | undefined
): (readonly Point[])[] {
  if (!ports || !frame) return [];
  const west = points.some(([x]) => x <= EDGE_BAND);
  const east = points.some(([x]) => x >= PART_WIDTH - EDGE_BAND);
  if (!west && !east) return [points];
  return clipToSpan(
    points,
    west ? frame[0] : -Infinity,
    east ? frame[0] + frame[2] : Infinity
  ).filter((piece) => !isLead(piece, ports, frame));
}

/** The parts of an orthogonal polyline inside `x0 ≤ x ≤ x1`. */
function clipToSpan(
  points: readonly Point[],
  x0: number,
  x1: number
): Point[][] {
  const out: Point[][] = [];
  let current: Point[] = [];
  const flush = () => {
    if (current.length >= 2 && length(current) > SNAP) out.push(current);
    current = [];
  };
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]];
    const lo = Math.min(a[0], b[0]);
    const hi = Math.max(a[0], b[0]);
    if (hi < x0 || lo > x1) {
      flush();
      continue;
    }
    const clamp = (p: Point): Point => [Math.min(x1, Math.max(x0, p[0])), p[1]];
    const ca = clamp(a);
    const cb = clamp(b);
    const last = current[current.length - 1];
    if (!last || last[0] !== ca[0] || last[1] !== ca[1]) {
      flush();
      current.push(ca);
    }
    current.push(cb);
    if (cb[0] !== b[0]) flush();
  }
  flush();
  return out;
}

const length = (pts: readonly Point[]) =>
  pts
    .slice(1)
    .reduce((s, p, i) => s + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);

/** A piece from a port that stays outside the frame: a lead, not a track through it. */
export function isLead(
  points: readonly Point[],
  ports: readonly (readonly [number, number])[],
  frame: Frame
): boolean {
  const onPort = (e: Point) =>
    ports.some(
      ([x, y]) => Math.abs(e[0] - x) <= SNAP && Math.abs(e[1] - y) <= SNAP
    );
  const [fx0, fy0] = [frame[0] + SNAP, frame[1] + SNAP];
  const [fx1, fy1] = [frame[0] + frame[2] - SNAP, frame[1] + frame[3] - SNAP];
  const through = points.slice(1).some((b, i) => {
    const a = points[i];
    return (
      Math.min(a[0], b[0]) < fx1 &&
      Math.max(a[0], b[0]) > fx0 &&
      Math.min(a[1], b[1]) < fy1 &&
      Math.max(a[1], b[1]) > fy0
    );
  });
  return (onPort(points[0]) || onPort(points[points.length - 1])) && !through;
}

export type WireChange = "" | "added" | "removed";

export interface WireProps extends RouteStyle {
  id?: string;
  emphasis?: boolean;
  directional?: boolean;
  conditional?: boolean;
  points: readonly Point[];
  change?: WireChange;
  /** Arrowhead from the shared GraphMarkers (`url(#ge-arrow)`); off by default. */
  arrow?: boolean;
  /** Optional in-SVG label near the glyph position. */
  label?: string;
  /**
   * Centre of the label line where a layout reserved room for it; the change
   * glyph then leads the label on that line instead of riding the rail.
   */
  labelAt?: readonly [number, number];
  /** Label font size; a layout must have reserved room at this size. */
  labelSize?: number;
  labelRole?: Role;
}

/**
 * A wire between parts in a composition. Change marks use ink and grey only
 * (VL-08): heavy ink with a + glyph for a new connection, dashed with × for a
 * removed one, plain otherwise.
 */
export function Wire({
  points,
  change = "",
  arrow = false,
  label,
  labelAt,
  jumps,
  cornerRadii,
  id,
  emphasis,
  directional,
  conditional,
  labelSize = 18,
  labelRole = "dim",
}: WireProps) {
  const r = route(points, undefined, { jumps, cornerRadii });
  const mid = r.points[Math.floor(r.points.length / 2)];
  const [mx, my] =
    r.points.length === 2
      ? [
          (r.points[0][0] + r.points[1][0]) / 2,
          (r.points[0][1] + r.points[1][1]) / 2,
        ]
      : mid;
  return (
    <g
      className={`md-wire${change ? " " + change : ""}`}
      data-change={change || "none"}
      data-rail-id={id}
      data-emphasis={emphasis ? "true" : undefined}
    >
      <GraphEdge
        d={routePath(r)}
        kind={conditional ? "handoff" : "step"}
        solid={!conditional}
        markerEnd={arrow || directional ? undefined : null}
      />
      {labelAt ? (
        <PlacedLabel
          at={labelAt}
          change={change}
          label={label}
          size={labelSize}
          role={labelRole}
        />
      ) : (
        <>
          {change === "added" && (
            <Glyph x={mx} y={my - 20} text="+" size={22} role="ink" />
          )}
          {change === "removed" && (
            <Glyph x={mx} y={my - 20} text="×" size={22} role="dim" />
          )}
          {label && (
            <SvgText
              x={mx}
              y={my + 22}
              runs={[[label, 400, labelRole]]}
              size={labelSize}
              align="center"
            />
          )}
        </>
      )}
    </g>
  );
}

/** One centred line: change glyph (+ ink, × dim), then the label. */
function PlacedLabel({
  at: [x, y],
  change,
  label,
  size,
  role,
}: {
  at: readonly [number, number];
  change: WireChange;
  label?: string;
  size: number;
  role: Role;
}) {
  const glyph = change === "added" ? "+" : change === "removed" ? "×" : "";
  if (!glyph && !label) return null;
  return (
    <SvgText
      x={x}
      y={y}
      runs={[
        ...(glyph
          ? [
              [
                label ? `${glyph} ` : glyph,
                600,
                change === "added" ? "ink" : "dim",
              ] as const,
            ]
          : []),
        ...(label ? [[label, 400, role] as const] : []),
      ]}
      size={size}
      align="center"
    />
  );
}

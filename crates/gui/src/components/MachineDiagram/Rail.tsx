import type { CSSProperties } from "react";
import { GraphEdge } from "../WorkflowAtlas/GraphEdge";
import type { Role } from "./palette";
import { SvgText, Glyph } from "./SvgText";
import { usePart } from "./partContext";
import { route, routePath, type Point, type RouteStyle } from "./route";

export interface RailProps extends RouteStyle {
  points: readonly Point[];
  /** Conditional lane (deny, undo, escalate, stop, host call). */
  dashed?: boolean;
  /** Custom dash pattern for a dashed lane, e.g. "4 6". */
  dash?: string;
}

/**
 * A rail inside a part: rounded corners (r 22), solid 2.5 px. Rendered with
 * the shared GraphEdge path so stroke styling stays class-driven. Rails of a
 * removed or absent part turn dashed (VL-05).
 */
export function Rail({ points, dashed, dash, jumps, cornerRadii }: RailProps) {
  const { removed, inFlow } = usePart();
  // All catalogue parts share this boundary; flows draw their own Wire paths.
  if (inFlow) return null;
  const isDashed = dashed || removed;
  const style =
    dash && dashed ? ({ "--md-dash": dash } as CSSProperties) : undefined;
  return (
    <g className="md-rail" style={style}>
      <GraphEdge
        d={routePath(route(points, undefined, { jumps, cornerRadii }))}
        kind={isDashed ? "handoff" : "step"}
        solid={!isDashed}
        markerEnd={null}
      />
    </g>
  );
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

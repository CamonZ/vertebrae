import {
  type EdgeProps,
  BaseEdge,
  EdgeLabelRenderer,
  type Edge,
} from "@xyflow/react";
import type { LayoutPoint } from "../../hooks";
import type { CSSProperties } from "react";
import { transitionDestinationArrowPath } from "./transitionEdge";

/**
 * Data passed to the ElkRoutedEdge component
 */
export interface ElkRoutedEdgeData extends Record<string, unknown> {
  /** Start point of the edge (on source node border) */
  sourcePoint?: LayoutPoint;
  /** End point of the edge (on target node border) */
  targetPoint?: LayoutPoint;
  /** Intermediate bend points for routing around nodes */
  bendPoints?: LayoutPoint[];
  /** Edge label text */
  label?: string;
  /** When true, render the label in the primary accent color */
  highlighted?: boolean;
}

/**
 * Edge type with ELK routing data
 */
export type ElkRoutedEdgeType = Edge<ElkRoutedEdgeData, "elkRouted">;

/**
 * Split a polyline path into a "body" path that stops `tailLength` short of the
 * end and a short solid "tail" path leading into the marker. This lets the
 * dashed body avoid passing through the arrow marker.
 */
function splitPathForMarker(
  sourcePoint: LayoutPoint,
  targetPoint: LayoutPoint,
  bendPoints: LayoutPoint[],
  tailLength: number
): { body: string; tail: string } {
  const points = [sourcePoint, ...bendPoints, targetPoint];
  const last = points[points.length - 1];
  const prev = points[points.length - 2];
  const dx = last.x - prev.x;
  const dy = last.y - prev.y;
  const segLen = Math.sqrt(dx * dx + dy * dy) || 1;
  const t = Math.max(0, segLen - tailLength) / segLen;
  const splitPoint: LayoutPoint = {
    x: prev.x + dx * t,
    y: prev.y + dy * t,
  };

  let body = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    body += ` L ${points[i].x} ${points[i].y}`;
  }
  body += ` L ${splitPoint.x} ${splitPoint.y}`;

  const tail = `M ${splitPoint.x} ${splitPoint.y} L ${last.x} ${last.y}`;

  return { body, tail };
}

/**
 * Calculate the midpoint of the path for label positioning
 */
function getPathMidpoint(
  sourcePoint: LayoutPoint,
  targetPoint: LayoutPoint,
  bendPoints: LayoutPoint[]
): LayoutPoint {
  // Collect all points in order
  const allPoints = [sourcePoint, ...bendPoints, targetPoint];

  if (allPoints.length === 2) {
    // No bend points, midpoint is between source and target
    return {
      x: (sourcePoint.x + targetPoint.x) / 2,
      y: (sourcePoint.y + targetPoint.y) / 2,
    };
  }

  // Calculate total path length
  let totalLength = 0;
  const segments: { start: LayoutPoint; end: LayoutPoint; length: number }[] =
    [];

  for (let i = 0; i < allPoints.length - 1; i++) {
    const start = allPoints[i];
    const end = allPoints[i + 1];
    const length = Math.sqrt(
      Math.pow(end.x - start.x, 2) + Math.pow(end.y - start.y, 2)
    );
    segments.push({ start, end, length });
    totalLength += length;
  }

  // Find midpoint along the path
  const midDistance = totalLength / 2;
  let accumulatedLength = 0;

  for (const segment of segments) {
    if (accumulatedLength + segment.length >= midDistance) {
      // Midpoint is on this segment
      const remainingDistance = midDistance - accumulatedLength;
      const ratio = remainingDistance / segment.length;
      return {
        x: segment.start.x + (segment.end.x - segment.start.x) * ratio,
        y: segment.start.y + (segment.end.y - segment.start.y) * ratio,
      };
    }
    accumulatedLength += segment.length;
  }

  // Fallback to target point
  return targetPoint;
}

/**
 * Custom edge component that uses ELK-calculated bend points for routing.
 * This ensures edges route around nodes instead of going through them.
 */
export function ElkRoutedEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
  style,
  markerEnd,
}: EdgeProps<ElkRoutedEdgeType>) {
  const sourcePoint = data?.sourcePoint;
  const targetPoint = data?.targetPoint;
  const bendPoints = data?.bendPoints ?? [];
  const label = data?.label;
  const highlighted = data?.highlighted ?? false;

  // Use ELK-calculated points if available, otherwise fall back to ReactFlow's positions
  const effectiveSourcePoint = sourcePoint || { x: sourceX, y: sourceY };
  const effectiveTargetPoint = targetPoint || { x: targetX, y: targetY };

  // Split into a dashed body and a short solid tail so the dashed pattern
  // doesn't pass through the arrow marker.
  const { body: dashedPath, tail: tailPath } = splitPathForMarker(
    effectiveSourcePoint,
    effectiveTargetPoint,
    bendPoints,
    10
  );

  // Continuous path used as a wide invisible hit target so clicks register
  // across the dash gaps too.
  const hitPath = (() => {
    const points = [effectiveSourcePoint, ...bendPoints, effectiveTargetPoint];
    let p = `M ${points[0].x} ${points[0].y}`;
    for (let i = 1; i < points.length; i++)
      p += ` L ${points[i].x} ${points[i].y}`;
    return p;
  })();

  // Calculate label position
  const labelPosition = label
    ? getPathMidpoint(effectiveSourcePoint, effectiveTargetPoint, bendPoints)
    : null;

  const baseStyle = style as CSSProperties;
  const arrowFill =
    typeof baseStyle.stroke === "string" ? baseStyle.stroke : "currentColor";
  const allPoints = [effectiveSourcePoint, ...bendPoints, effectiveTargetPoint];
  const previousTargetPoint = allPoints[allPoints.length - 2];

  return (
    <g style={{ cursor: "pointer" }}>
      <path
        d={hitPath}
        className="react-flow__edge-interaction"
        stroke="transparent"
        strokeWidth={20}
        fill="none"
        style={{ pointerEvents: "stroke" }}
      />
      <BaseEdge id={id} path={dashedPath} style={baseStyle} />
      <BaseEdge
        id={`${id}-tail`}
        path={tailPath}
        style={{ ...baseStyle, strokeDasharray: undefined }}
        markerEnd={markerEnd as string}
      />
      <path
        id={`${id}-destination-arrow`}
        data-testid="workflow-transition-destination-arrow"
        d={transitionDestinationArrowPath(
          effectiveTargetPoint.x,
          effectiveTargetPoint.y,
          previousTargetPoint.x,
          previousTargetPoint.y
        )}
        fill={arrowFill}
        stroke="none"
      />
      {label && labelPosition && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelPosition.x}px, ${labelPosition.y}px)`,
              pointerEvents: "all",
            }}
            className={`rounded bg-bg/90 px-1.5 py-0.5 text-eyebrow font-medium ${highlighted ? "text-accent" : "text-fg-mute"}`}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </g>
  );
}

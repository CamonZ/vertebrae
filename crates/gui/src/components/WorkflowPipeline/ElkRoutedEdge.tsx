import { type EdgeProps, BaseEdge, EdgeLabelRenderer, type Edge } from "@xyflow/react";
import type { LayoutPoint } from "../../hooks";
import type { CSSProperties } from "react";

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
}

/**
 * Edge type with ELK routing data
 */
export type ElkRoutedEdgeType = Edge<ElkRoutedEdgeData, "elkRouted">;

/**
 * Build an SVG path string from ELK-calculated points.
 * Creates orthogonal (right-angled) paths through bend points.
 */
function buildElkPath(
  sourcePoint: LayoutPoint,
  targetPoint: LayoutPoint,
  bendPoints: LayoutPoint[]
): string {
  // Start at source point
  let path = `M ${sourcePoint.x} ${sourcePoint.y}`;

  // Add line segments through each bend point
  for (const bp of bendPoints) {
    path += ` L ${bp.x} ${bp.y}`;
  }

  // End at target point
  path += ` L ${targetPoint.x} ${targetPoint.y}`;

  return path;
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
  const segments: { start: LayoutPoint; end: LayoutPoint; length: number }[] = [];

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

  // Use ELK-calculated points if available, otherwise fall back to ReactFlow's positions
  const effectiveSourcePoint = sourcePoint || { x: sourceX, y: sourceY };
  const effectiveTargetPoint = targetPoint || { x: targetX, y: targetY };

  // Build the SVG path
  const path = buildElkPath(effectiveSourcePoint, effectiveTargetPoint, bendPoints);

  // Calculate label position
  const labelPosition = label
    ? getPathMidpoint(effectiveSourcePoint, effectiveTargetPoint, bendPoints)
    : null;

  return (
    <>
      <BaseEdge id={id} path={path} style={style as CSSProperties} markerEnd={markerEnd as string} />
      {label && labelPosition && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelPosition.x}px, ${labelPosition.y}px)`,
              pointerEvents: "all",
            }}
            className="rounded bg-bg-primary/90 px-1.5 py-0.5 text-[11px] font-medium text-text-muted"
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

import { BaseEdge, type Edge, type EdgeProps } from "@xyflow/react";
import type { CSSProperties } from "react";
import { LAYOUT_CONSTANTS } from "./nodeConstants";
import { transitionDestinationArrowPath } from "./transitionEdge";

export const ROUTE_BACK_EDGE_TYPE = "routeBack" as const;
export interface RouteBackEdgeData extends Record<string, unknown> {
  loopLane?: number;
  loopSide?: "top" | "bottom";
}
export type RouteBackEdgeType = Edge<
  RouteBackEdgeData,
  typeof ROUTE_BACK_EDGE_TYPE
>;

const LOOP_OFFSET_Y = 96;
const LOOP_OFFSET_STEP_Y = 28;
const LOOP_CORNER_RADIUS = 16;
const MARKER_TAIL_LENGTH = 10;
const STEP_HANDLE_CENTER_OFFSET = 6;
const ROUTE_STEP_EXIT_INSET_X = 70;
const DESTINATION_STEP_ENTRY_INSET_X = 140;
const STEP_ANCHOR_LANE_OFFSET_X = 24;
const INTERACTION_PATH_STYLE = { pointerEvents: "stroke" } as const;

function stepBoundsFromHandle(
  handleX: number,
  handleY: number,
  side: "source" | "target"
): { left: number; right: number; top: number; bottom: number } {
  const left =
    side === "source"
      ? handleX - STEP_HANDLE_CENTER_OFFSET - LAYOUT_CONSTANTS.STEP_NODE_WIDTH
      : handleX + STEP_HANDLE_CENTER_OFFSET;
  const top = handleY - LAYOUT_CONSTANTS.STEP_NODE_HEIGHT / 2;

  return {
    left,
    right: left + LAYOUT_CONSTANTS.STEP_NODE_WIDTH,
    top,
    bottom: top + LAYOUT_CONSTANTS.STEP_NODE_HEIGHT,
  };
}

function routeBackAttachmentPoints({
  sourceX,
  sourceY,
  targetX,
  targetY,
  loopLane,
  loopSide,
}: {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  loopLane: number;
  loopSide: "top" | "bottom";
}): {
  sourcePoint: { x: number; y: number };
  targetPoint: { x: number; y: number };
} {
  const sourceBounds = stepBoundsFromHandle(sourceX, sourceY, "source");
  const targetBounds = stepBoundsFromHandle(targetX, targetY, "target");
  const laneOffsetX = loopLane * STEP_ANCHOR_LANE_OFFSET_X;
  const sourceAnchorX = Math.max(
    sourceBounds.left + LOOP_CORNER_RADIUS,
    sourceBounds.right - ROUTE_STEP_EXIT_INSET_X - laneOffsetX
  );
  const targetAnchorX = Math.min(
    targetBounds.right - LOOP_CORNER_RADIUS,
    targetBounds.left + DESTINATION_STEP_ENTRY_INSET_X + laneOffsetX
  );
  const yKey = loopSide === "top" ? "top" : "bottom";

  return {
    sourcePoint: { x: sourceAnchorX, y: sourceBounds[yKey] },
    targetPoint: { x: targetAnchorX, y: targetBounds[yKey] },
  };
}

function getRouteBackPoints(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  loopOffsetY: number,
  loopSide: "top" | "bottom"
): { x: number; y: number }[] {
  const isTopLoop = loopSide === "top";
  const loopY = isTopLoop
    ? Math.min(sourceY, targetY) - loopOffsetY
    : Math.max(sourceY, targetY) + loopOffsetY;
  const turnDirection = isTopLoop ? 1 : -1;
  const sourceTurnY = loopY + turnDirection * LOOP_CORNER_RADIUS;
  const targetTurnY = loopY + turnDirection * LOOP_CORNER_RADIUS;
  const targetTurnX = targetX + LOOP_CORNER_RADIUS;

  return [
    { x: sourceX, y: sourceY },
    { x: sourceX, y: sourceTurnY },
    { x: sourceX - LOOP_CORNER_RADIUS, y: loopY },
    { x: targetTurnX, y: loopY },
    { x: targetX, y: targetTurnY },
    { x: targetX, y: targetY },
  ];
}

function routeBackPath(points: { x: number; y: number }[]): string {
  const [start, ...rest] = points;
  let path = `M ${start.x} ${start.y}`;
  for (const point of rest) {
    path += ` L ${point.x} ${point.y}`;
  }
  return path;
}

function splitRouteBackPathForMarker(points: { x: number; y: number }[]): {
  body: string;
  tail: string;
  hitPath: string;
} {
  const splitPoints = points.slice();
  const last = splitPoints[splitPoints.length - 1];
  const prev = splitPoints[splitPoints.length - 2];
  const dy = last.y - prev.y;
  const segLen = Math.abs(dy) || 1;
  const t = Math.max(0, segLen - MARKER_TAIL_LENGTH) / segLen;
  const splitPoint = {
    x: last.x,
    y: prev.y + dy * t,
  };

  splitPoints[splitPoints.length - 1] = splitPoint;

  return {
    body: routeBackPath(splitPoints),
    tail: `M ${splitPoint.x} ${splitPoint.y} L ${last.x} ${last.y}`,
    hitPath: routeBackPath(points),
  };
}

export function RouteBackEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  style,
  markerEnd,
  data,
}: EdgeProps<RouteBackEdgeType>) {
  const loopOffsetY =
    LOOP_OFFSET_Y + (data?.loopLane ?? 0) * LOOP_OFFSET_STEP_Y;
  const loopSide = data?.loopSide ?? "bottom";
  const loopLane = data?.loopLane ?? 0;
  const { sourcePoint, targetPoint } = routeBackAttachmentPoints({
    sourceX,
    sourceY,
    targetX,
    targetY,
    loopLane,
    loopSide,
  });
  const points = getRouteBackPoints(
    sourcePoint.x,
    sourcePoint.y,
    targetPoint.x,
    targetPoint.y,
    loopOffsetY,
    loopSide
  );
  const { body, tail, hitPath } = splitRouteBackPathForMarker(points);
  const baseStyle = style as CSSProperties;
  const arrowFill =
    typeof baseStyle.stroke === "string" ? baseStyle.stroke : "currentColor";
  const previousTargetPoint = points[points.length - 2];

  return (
    <g data-testid="route-back-edge" data-edgeid={id}>
      <path
        d={hitPath}
        className="react-flow__edge-interaction"
        stroke="transparent"
        strokeWidth={20}
        fill="none"
        style={INTERACTION_PATH_STYLE}
      />
      <BaseEdge id={id} path={body} style={baseStyle} />
      <BaseEdge
        id={`${id}-tail`}
        path={tail}
        style={{ ...baseStyle, strokeDasharray: undefined }}
        markerEnd={markerEnd}
      />
      <path
        id={`${id}-destination-arrow`}
        data-testid="route-back-destination-arrow"
        d={transitionDestinationArrowPath(
          targetPoint.x,
          targetPoint.y,
          previousTargetPoint.x,
          previousTargetPoint.y
        )}
        fill={arrowFill}
        stroke="none"
      />
    </g>
  );
}

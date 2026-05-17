import type { ReactElement } from "react";

export const TRANSITION_ARROW_COLOR = "#a1a1a1";
export const TRANSITION_ARROW_COLOR_SELECTED = "#f59e0b";

const MARKER_ID_DEFAULT = "transition-arrow";
const MARKER_ID_SELECTED = "transition-arrow-selected";

export interface TransitionMarkerOptions {
  selected?: boolean;
}

export function transitionArrowMarker({
  selected = false,
}: TransitionMarkerOptions = {}): string {
  return `url(#${selected ? MARKER_ID_SELECTED : MARKER_ID_DEFAULT})`;
}

export interface TransitionStrokeOptions {
  selected?: boolean;
  dashed?: boolean;
}

export function transitionEdgeStyle({
  selected = false,
  dashed = false,
}: TransitionStrokeOptions = {}): React.CSSProperties {
  return {
    stroke: selected ? TRANSITION_ARROW_COLOR_SELECTED : TRANSITION_ARROW_COLOR,
    strokeWidth: selected ? 2.5 : 2,
    ...(dashed ? { strokeDasharray: "5,5" } : null),
  };
}

/**
 * Off-screen SVG that registers the transition arrowhead markers.
 * Render once near the top of any view that uses transition edges so the
 * markers are anchored at the base of the triangle (refX = 0), preventing
 * the path from overlapping the arrow body.
 */
export function TransitionEdgeMarkers(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      style={{
        position: "absolute",
        width: 0,
        height: 0,
        overflow: "hidden",
      }}
    >
      <defs>
        <marker
          id={MARKER_ID_DEFAULT}
          viewBox="0 0 10 10"
          refX="0"
          refY="5"
          markerWidth="9"
          markerHeight="9"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill={TRANSITION_ARROW_COLOR} />
        </marker>
        <marker
          id={MARKER_ID_SELECTED}
          viewBox="0 0 10 10"
          refX="0"
          refY="5"
          markerWidth="9"
          markerHeight="9"
          orient="auto-start-reverse"
        >
          <path
            d="M 0 0 L 10 5 L 0 10 z"
            fill={TRANSITION_ARROW_COLOR_SELECTED}
          />
        </marker>
      </defs>
    </svg>
  );
}

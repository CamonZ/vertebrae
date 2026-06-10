/**
 * One routed SVG <path> for the Workflow Atlas / Graph canvas.
 *
 * Style is entirely class-driven off the `.gedge` + `--edge-*` token vocabulary
 * (see src/index.css) — this component NEVER inlines a stroke color, width,
 * dash, or opacity. That keeps every canvas page in sync and theme-correct.
 *
 *   kind:  'step'    within a workflow          → .k-step  (solid, resting hue)
 *          'handoff' between workflows          → .k-handoff (dashed)
 *          'loop'    back-edge                  → .k-loop   (route hue, dashed)
 *   state: ''        resting
 *          'lit'     on an active trace         → .lit
 *          'dim'     faded back out of a trace  → .dim
 *   solid: opt-in modifier to force a handoff to render without a dash → .solid
 *   live:  legacy animated-accent variant       → .live
 *
 * `markerEnd` defaults by kind+state (loop → #ge-loop; else the resting / lit /
 * dim arrow so the head matches the edge color). Pass a custom url() to
 * override, or null to drop the arrowhead. Pair with <GraphMarkers/> in the
 * same <svg>.
 *
 * Ported from docs/design/lib/lib-graph.jsx (GraphEdge).
 */
export type GraphEdgeKind = "step" | "handoff" | "loop";
export type GraphEdgeState = "" | "lit" | "dim";

export interface GraphEdgeProps {
  /** SVG path `d` attribute (precomputed by the layout/router). */
  d: string;
  kind?: GraphEdgeKind;
  state?: GraphEdgeState;
  /**
   * Back/return edge — when lit it renders in max-contrast white instead of the
   * forward accent, so a hub trace separates forward flow from returning paths.
   */
  back?: boolean;
  /** Force a handoff to render solid (no dash). */
  solid?: boolean;
  /** Legacy animated-accent variant. */
  live?: boolean;
  /** Override the kind-derived arrowhead. Pass null to omit it. */
  markerEnd?: string | null;
}

function defaultMarker(
  kind: GraphEdgeKind,
  state: GraphEdgeState,
  back: boolean,
): string {
  if (state === "lit" && back) return "url(#ge-arrow-back)";
  if (kind === "loop") return "url(#ge-loop)";
  if (state === "lit") return "url(#ge-arrow-lit)";
  if (state === "dim") return "url(#ge-arrow-dim)";
  return "url(#ge-arrow)";
}

export function GraphEdge({
  d,
  kind = "step",
  state = "",
  back = false,
  solid,
  live,
  markerEnd,
}: GraphEdgeProps) {
  // `undefined` → derive from kind+state; `null` → no marker; string → as-is.
  const marker =
    markerEnd !== undefined
      ? (markerEnd ?? undefined)
      : defaultMarker(kind, state, back);

  if (live) {
    return (
      <path className="gedge live" d={d} markerEnd={marker}>
        <animate
          attributeName="stroke-dashoffset"
          from="0"
          to="-16"
          dur="1.4s"
          repeatCount="indefinite"
        />
      </path>
    );
  }

  const cls =
    "gedge k-" +
    kind +
    (solid ? " solid" : "") +
    (state ? " " + state : "") +
    (back ? " back" : "");
  return <path className={cls} d={d} markerEnd={marker} />;
}

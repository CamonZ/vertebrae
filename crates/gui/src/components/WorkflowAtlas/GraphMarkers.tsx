/**
 * Shared SVG arrowhead defs for the Workflow Atlas / Graph canvas.
 *
 * Drop ONE <GraphMarkers/> inside any canvas <svg> that renders <GraphEdge>.
 * The markers are referenced by url(#id) from each edge's `markerEnd`.
 *
 * NOTE: arrowheads are pinned to explicit token colors PER STATE rather than
 * SVG `fill="context-stroke"`. context-stroke has no support in the macOS
 * WebKit WebView (Tauri), where it falls back to black — making the arrowheads
 * nearly invisible. `GraphEdge` selects the marker matching the edge state.
 *   - #ge-arrow       resting handoff/step → a visible neutral (--fg-mute)
 *   - #ge-arrow-lit   forward edge on a trace → accent (--edge-color-lit)
 *   - #ge-arrow-back  back/return edge on a trace → max contrast (--edge-color-back)
 *   - #ge-arrow-dim   faded out of a trace → faint, so it recedes with the edge
 *   - #ge-loop        loop-back            → route hue (--step-route)
 *
 * Ported from docs/design/lib/lib-graph.jsx (GraphMarkers).
 */
const HEAD = "M0,0 L10,5 L0,10 z";

export function GraphMarkers() {
  return (
    <defs>
      <marker
        id="ge-arrow"
        viewBox="0 0 10 10"
        refX="8"
        refY="5"
        markerWidth="7"
        markerHeight="7"
        orient="auto-start-reverse"
      >
        <path d={HEAD} fill="var(--fg-mute)" />
      </marker>
      <marker
        id="ge-arrow-lit"
        viewBox="0 0 10 10"
        refX="8"
        refY="5"
        markerWidth="7"
        markerHeight="7"
        orient="auto-start-reverse"
      >
        <path d={HEAD} fill="var(--edge-color-lit)" />
      </marker>
      <marker
        id="ge-arrow-back"
        viewBox="0 0 10 10"
        refX="8"
        refY="5"
        markerWidth="7"
        markerHeight="7"
        orient="auto-start-reverse"
      >
        <path d={HEAD} fill="var(--edge-color-back)" />
      </marker>
      <marker
        id="ge-arrow-dim"
        viewBox="0 0 10 10"
        refX="8"
        refY="5"
        markerWidth="7"
        markerHeight="7"
        orient="auto-start-reverse"
      >
        <path
          d={HEAD}
          fill="color-mix(in oklch, var(--fg-mute) 30%, transparent)"
        />
      </marker>
      <marker
        id="ge-loop"
        viewBox="0 0 10 10"
        refX="8"
        refY="5"
        markerWidth="6.5"
        markerHeight="6.5"
        orient="auto-start-reverse"
      >
        <path d={HEAD} fill="var(--step-route)" />
      </marker>
    </defs>
  );
}

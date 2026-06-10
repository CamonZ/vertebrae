/**
 * Floating zoom controls for the Workflow Atlas canvas.
 *
 * Carries `data-no-pan` so clicks here never start a canvas pan-drag (see
 * usePanZoom). Wired to the pan/zoom API's `zoomIn` / `zoomOut` / `fit`.
 *
 * Ported from docs/design/workflow-views.jsx (`.uv-zoom`).
 */
export interface ZoomWidgetProps {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
}

export function ZoomWidget({ onZoomIn, onZoomOut, onFit }: ZoomWidgetProps) {
  return (
    <div className="uv-zoom" data-no-pan>
      <button type="button" onClick={onZoomIn} title="Zoom in" aria-label="Zoom in">
        ＋
      </button>
      <button type="button" onClick={onZoomOut} title="Zoom out" aria-label="Zoom out">
        −
      </button>
      <button type="button" onClick={onFit} title="Fit" aria-label="Fit to view">
        ⊡
      </button>
    </div>
  );
}

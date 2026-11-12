import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useStatechartViewport } from "../Artifacts/useStatechartViewport";
import { useStatechartZoom } from "../Artifacts/useStatechartZoom";
import { EdgeLabel } from "../WorkflowAtlas/EdgeLabel";
import { ZoomWidget } from "../WorkflowAtlas/ZoomWidget";
import "../WorkflowAtlas/WorkflowAtlas.css";
import "./MachineDiagram.css";

export interface DiagramLabel {
  readonly id: string;
  /** Distinct labels on the wire; the first shows, the rest become `+N`. */
  readonly labels: string[];
  /** Position in the diagram's logical coordinates. */
  readonly x: number;
  readonly y: number;
}

export interface MachineDiagramViewportProps {
  /** Logical size of the diagram inside (matches MachineDiagram width/height). */
  width: number;
  height: number;
  /** Wire labels drawn with the shared EdgeLabel chip over the SVG. */
  labels?: readonly DiagramLabel[];
  /**
   * On mount, shrink the diagram to the frame's width (never past 1) and
   * size the frame to the fitted diagram's height.
   */
  fitOnMount?: boolean;
  children: ReactNode;
}

const MIN_ZOOM = 0.1;
const ZOOM_STEP = 1.25;
/** Leaves room for the zoom control under a very flat fitted diagram. */
const MIN_FITTED_HEIGHT = 120;
/**
 * Screen-space column kept clear for the zoom control (16 px inset, 30 px
 * buttons, 16 px gap), so it never sits over the diagram's left edge — where
 * a flow band's heading and row names start — at any zoom.
 */
export const ZOOM_GUTTER = 62;

/**
 * Pan/zoom frame for a machine diagram, reusing the statechart viewport's
 * pointer-drag pan, its Ctrl/⌘-wheel and trackpad-pinch zoom (anchored at the
 * pointer), and the Workflow Atlas zoom control. Plain wheel scrolling is left
 * to the page. Wire labels ride in an HTML layer that shares the SVG's
 * transform, so they stay real DOM text.
 */
export function MachineDiagramViewport({
  width,
  height,
  labels = [],
  fitOnMount = false,
  children,
}: MachineDiagramViewportProps) {
  const viewport = useStatechartViewport();
  const zoomState = useStatechartZoom<HTMLSpanElement>(
    viewport.canvasRef,
    true
  );
  const { zoom, setZoom } = zoomState;
  const initialFit = useRef(fitOnMount);
  const [fittedHeight, setFittedHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (!initialFit.current) return;
    initialFit.current = false;
    const canvas = viewport.canvasRef.current;
    if (!canvas || !canvas.clientWidth) return;
    const room = Math.max(1, canvas.clientWidth - ZOOM_GUTTER);
    const fitted = Math.max(MIN_ZOOM, Math.min(1, room / width));
    setZoom(fitted, true);
    setFittedHeight(Math.max(MIN_FITTED_HEIGHT, Math.ceil(height * fitted)));
    // Mount-only: later zoom changes come from the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function fit() {
    const canvas = viewport.canvasRef.current;
    if (!canvas || !canvas.clientWidth || !canvas.clientHeight) return;
    const fitted = Math.min(
      Math.max(1, canvas.clientWidth - ZOOM_GUTTER) / width,
      canvas.clientHeight / height
    );
    setZoom(fitted, true);
    viewport.resetPan();
  }

  return (
    <span
      className="md-viewport"
      ref={viewport.containerRef}
      style={{ display: "block", height: fittedHeight ?? viewport.height }}
      data-dragging={viewport.dragging ? "true" : "false"}
      data-testid="machine-diagram-viewport"
    >
      <span
        ref={viewport.canvasRef}
        style={{ display: "block", position: "absolute", inset: 0 }}
        {...viewport.panHandlers}
      >
        <span
          className="md-stage"
          ref={zoomState.diagramRef}
          data-zoom={zoom}
          style={{
            display: "block",
            left: ZOOM_GUTTER,
            width,
            height,
            transform: `translate(${viewport.pan.x + zoomState.x}px, ${viewport.pan.y + zoomState.y}px) scale(${zoom})`,
          }}
        >
          {children}
          <span className="md-labels" style={{ display: "block" }}>
            {labels.map((l) => (
              <EdgeLabel key={l.id} labels={l.labels} left={l.x} top={l.y} />
            ))}
          </span>
        </span>
      </span>
      <ZoomWidget
        onZoomIn={() => setZoom((z) => z * ZOOM_STEP)}
        onZoomOut={() => setZoom((z) => z / ZOOM_STEP)}
        onFit={fit}
      />
    </span>
  );
}

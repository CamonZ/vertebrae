import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useStatechartViewport } from "../Artifacts/useStatechartViewport";
import { useStatechartZoom } from "../Artifacts/useStatechartZoom";
import { InlineResizeHandle } from "../shared/InlineResizeHandle";
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
  /**
   * Accessible name of a bottom grip that resizes the frame vertically (the
   * shared inline grip: drag, or Up/Down while focused). The frame keeps its
   * fitted height until the grip is first used. No grip when absent.
   */
  resizeLabel?: string;
  /**
   * Smallest frame height, for the fit and the grip (default 120, room for
   * the zoom control under a very flat diagram).
   */
  minHeight?: number;
  /**
   * Receives a layer over the diagram, inside the frame, for floating panels
   * (portal into it). It takes no pointer input itself, so the diagram still
   * pans and zooms around the panels.
   */
  overlayRef?: (layer: HTMLElement | null) => void;
  /**
   * Room kept clear of floating panels when fitting, for a frame `width`
   * wide: the fitted diagram ends left of `right` and above `bottom`.
   */
  fitInsets?: (width: number) => FitInsets;
  children: ReactNode;
}

export interface FitInsets {
  readonly right: number;
  readonly bottom: number;
}

const NO_INSETS = (): FitInsets => ({ right: 0, bottom: 0 });

const MIN_ZOOM = 0.1;
const ZOOM_STEP = 1.25;
/** Leaves room for the zoom control under a very flat fitted diagram. */
const MIN_FITTED_HEIGHT = 120;
const MAX_HEIGHT = 1600;
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
  resizeLabel,
  minHeight = MIN_FITTED_HEIGHT,
  overlayRef,
  fitInsets = NO_INSETS,
  children,
}: MachineDiagramViewportProps) {
  const viewport = useStatechartViewport({
    minHeight,
    maxHeight: MAX_HEIGHT,
  });
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
    const inset = fitInsets(canvas.clientWidth);
    const room = Math.max(1, canvas.clientWidth - ZOOM_GUTTER - inset.right);
    const fitted = Math.max(MIN_ZOOM, Math.min(1, room / width));
    setZoom(fitted, true);
    setFittedHeight(
      Math.max(minHeight, Math.ceil(height * fitted) + inset.bottom)
    );
    // Mount-only: later zoom changes come from the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function fit() {
    const canvas = viewport.canvasRef.current;
    if (!canvas || !canvas.clientWidth || !canvas.clientHeight) return;
    const inset = fitInsets(canvas.clientWidth);
    const fitted = Math.min(
      Math.max(1, canvas.clientWidth - ZOOM_GUTTER - inset.right) / width,
      Math.max(1, canvas.clientHeight - inset.bottom) / height
    );
    setZoom(fitted, true);
    viewport.resetPan();
  }

  // The stage is anchored at its top-left, so a resize keeps zoom and pan.
  const frameHeight =
    viewport.resized || fittedHeight === null ? viewport.height : fittedHeight;

  const frame = (
    <span
      className="md-viewport"
      ref={viewport.containerRef}
      style={{ display: "block", height: frameHeight }}
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
      {overlayRef && <span className="md-overlay" ref={overlayRef} />}
      <ZoomWidget
        onZoomIn={() => setZoom((z) => z * ZOOM_STEP)}
        onZoomOut={() => setZoom((z) => z / ZOOM_STEP)}
        onFit={fit}
      />
    </span>
  );

  if (!resizeLabel) return frame;
  return (
    <span className="md-resizable" data-testid="machine-diagram-resizable">
      {frame}
      <InlineResizeHandle
        label={resizeLabel}
        value={Math.round(frameHeight)}
        minimum={minHeight}
        maximum={MAX_HEIGHT}
        resizing={viewport.dragging}
        {...viewport.resizeHandlers}
      />
    </span>
  );
}

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useStatechartViewport } from "../Artifacts/useStatechartViewport";
import { useStatechartZoom } from "../Artifacts/useStatechartZoom";
import { InlineResizeHandle } from "../shared/InlineResizeHandle";
import { useDiagramBox } from "../shared/diagramBox";
import { EdgeLabel } from "../WorkflowAtlas/EdgeLabel";
import { ZoomWidget } from "../WorkflowAtlas/ZoomWidget";
import "../WorkflowAtlas/WorkflowAtlas.css";
import "./MachineDiagram.css";
import { weightBand } from "./weightBand";

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
  /** Full-page fills a sized parent; embedded keeps its fitted/resizable height. */
  mode?: "embedded" | "full-page";
  /** Wait for asynchronous geometry before consuming the initial fit. */
  ready?: boolean;
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
   * wide: the stage starts after `left` beside the zoom gutter, and the
   * fitted diagram ends left of `right` and above `bottom`.
   */
  fitInsets?: (width: number) => FitInsets;
  children: ReactNode;
}

export interface FitInsets {
  readonly left?: number;
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
  mode: requestedMode = "embedded",
  ready = true,
  labels = [],
  fitOnMount = false,
  resizeLabel,
  minHeight = MIN_FITTED_HEIGHT,
  overlayRef,
  fitInsets = NO_INSETS,
  children,
}: MachineDiagramViewportProps) {
  // In a chat diagram block the block owns sizing: fill its box when it has
  // a height, drop the own grip, and refit whenever the box changes size.
  const box = useDiagramBox();
  const mode = box?.fill ? "full-page" : requestedMode;
  const maxFitZoom = box?.maxFitZoom ?? 1;
  const followBox = box !== null;
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

  // The observer reads current geometry without reinstalling on playback or
  // count updates. After fitting, the user owns the camera, even on resize.
  const fitInitial = useRef<() => void>(() => {});
  fitInitial.current = () => {
    if (!initialFit.current || !ready || width <= 0 || height <= 0) return;
    const canvas = viewport.canvasRef.current;
    if (!canvas?.clientWidth || (mode === "full-page" && !canvas.clientHeight))
      return;
    const inset = fitInsets(canvas.clientWidth);
    const room = Math.max(
      1,
      canvas.clientWidth - ZOOM_GUTTER - (inset.left ?? 0) - inset.right
    );
    const fitted = Math.max(
      MIN_ZOOM,
      Math.min(
        maxFitZoom,
        room / width,
        mode === "full-page"
          ? Math.max(1, canvas.clientHeight - inset.bottom) / height
          : Infinity
      )
    );
    initialFit.current = false;
    setZoom(fitted, true);
    if (followBox) viewport.resetPan();
    if (mode === "embedded")
      setFittedHeight(
        Math.max(minHeight, Math.ceil(height * fitted) + inset.bottom)
      );
  };

  useLayoutEffect(() => {
    fitInitial.current();
    const canvas = viewport.canvasRef.current;
    if (!canvas || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (followBox) initialFit.current = true;
      fitInitial.current();
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [viewport.canvasRef, followBox]);

  useLayoutEffect(() => {
    if (followBox) initialFit.current = true;
    fitInitial.current();
  }, [ready, width, height, mode, followBox, maxFitZoom]);

  function fit() {
    const canvas = viewport.canvasRef.current;
    if (!ready || width <= 0 || height <= 0) return;
    if (!canvas || !canvas.clientWidth || !canvas.clientHeight) return;
    const inset = fitInsets(canvas.clientWidth);
    const fitted = Math.min(
      Math.max(
        1,
        canvas.clientWidth - ZOOM_GUTTER - (inset.left ?? 0) - inset.right
      ) / width,
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
      style={
        box?.fill
          ? { display: "block", flex: "1 1 0", minHeight: 0, width: "100%" }
          : {
              display: "block",
              height: mode === "full-page" ? "100%" : frameHeight,
              width: mode === "full-page" ? "100%" : undefined,
            }
      }
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
          data-weight={weightBand(zoom)}
          style={{
            display: "block",
            left:
              ZOOM_GUTTER +
              (fitInsets(viewport.canvasRef.current?.clientWidth ?? 0).left ??
                0),
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

  if (!resizeLabel || mode === "full-page" || box) return frame;
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

import { useState, type ReactNode } from "react";
import { useStatechartViewport } from "../Artifacts/useStatechartViewport";
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
  children: ReactNode;
}

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 1.25;

/**
 * Pan/zoom frame for a machine diagram, reusing the statechart viewport's
 * pointer-drag pan and the Workflow Atlas zoom control. Wire labels ride in
 * an HTML layer that shares the SVG's transform, so they stay real DOM text.
 */
export function MachineDiagramViewport({
  width,
  height,
  labels = [],
  children,
}: MachineDiagramViewportProps) {
  const viewport = useStatechartViewport();
  const [zoom, setZoom] = useState(1);

  function fit() {
    const canvas = viewport.canvasRef.current;
    if (!canvas || !canvas.clientWidth || !canvas.clientHeight) return;
    const fitted = Math.min(
      canvas.clientWidth / width,
      canvas.clientHeight / height
    );
    setZoom(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, fitted)));
    viewport.resetPan();
  }

  return (
    <span
      className="md-viewport"
      ref={viewport.containerRef}
      style={{ display: "block", height: viewport.height }}
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
          style={{
            display: "block",
            width,
            height,
            transform: `translate(${viewport.pan.x}px, ${viewport.pan.y}px) scale(${zoom})`,
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
        onZoomIn={() => setZoom((z) => Math.min(MAX_ZOOM, z * ZOOM_STEP))}
        onZoomOut={() => setZoom((z) => Math.max(MIN_ZOOM, z / ZOOM_STEP))}
        onFit={fit}
      />
    </span>
  );
}

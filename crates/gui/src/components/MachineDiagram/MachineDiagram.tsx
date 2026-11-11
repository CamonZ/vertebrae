import { useId, useMemo, type ReactNode } from "react";
import { GraphMarkers } from "../WorkflowAtlas/GraphMarkers";
import { HatchPattern } from "./ChangeMark";
import { PartContext } from "./partContext";
import { PART_HEIGHT, PART_WIDTH } from "./MachinePart";
import "./MachineDiagram.css";

export interface MachineDiagramProps {
  /** Logical width and height of the diagram (one part: 640×400). */
  width?: number;
  height?: number;
  /** Accessible name of the whole picture. */
  label: string;
  /** Hide all labels (silhouette view). */
  labels?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * SVG root for machine diagrams: theme-mapped colour roles (MachineDiagram.css),
 * shared arrow markers, and the hatch pattern for removed/absent parts.
 * Parts and wires share one logical coordinate space, the same one elkjs
 * layouts and WorkflowAtlas edges use.
 */
export function MachineDiagram({
  width = PART_WIDTH,
  height = PART_HEIGHT,
  label,
  labels = true,
  className,
  children,
}: MachineDiagramProps) {
  const hatchId = `md-hatch-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const ctx = useMemo(
    () => ({ fade: 1, removed: false, labels, hatchId }),
    [labels, hatchId]
  );
  return (
    <svg
      className={className ? `md-root ${className}` : "md-root"}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="group"
      aria-label={label}
    >
      <GraphMarkers />
      <defs>
        <HatchPattern id={hatchId} />
      </defs>
      <PartContext.Provider value={ctx}>{children}</PartContext.Provider>
    </svg>
  );
}

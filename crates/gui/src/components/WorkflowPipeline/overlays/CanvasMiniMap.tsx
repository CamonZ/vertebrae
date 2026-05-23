import { MiniMap, type ReactFlowState } from "@xyflow/react";
import { useStore } from "@xyflow/react";
import { stepTypeStyle } from "../stepTypeStyling";
import type { StepNodeData } from "../StepNode";

interface CanvasMiniMapProps {
  /** Hide the minimap below this node count (defaults to 8 per the spec). */
  threshold?: number;
  className?: string;
}

const selectNodeCount = (s: ReactFlowState) => s.nodes.length;

/**
 * React Flow minimap themed to the Hearth tokens. Nodes are coloured by
 * step type so the bird's-eye view reflects the same vocabulary as the
 * full canvas. Hidden unless the diagram exceeds the visibility threshold.
 */
export function CanvasMiniMap({
  threshold = 8,
  className,
}: CanvasMiniMapProps) {
  const nodeCount = useStore(selectNodeCount);
  if (nodeCount <= threshold) return null;

  return (
    <MiniMap
      className={className}
      style={{
        backgroundColor: "var(--color-bg-3)",
        border: "1px solid var(--color-line-strong)",
        borderRadius: "var(--radius-md)",
      }}
      maskColor="rgba(0, 0, 0, 0.5)"
      nodeColor={(node) => {
        const data = node.data as Partial<StepNodeData> | undefined;
        if (data?.step) {
          return `var(${stepTypeStyle(data.step.step_type).barVar})`;
        }
        return "var(--color-line-strong)";
      }}
      nodeBorderRadius={3}
      pannable
      zoomable
    />
  );
}

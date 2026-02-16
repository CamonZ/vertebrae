import { memo } from "react";
import { type NodeProps, type Node, Handle, Position } from "@xyflow/react";
import type { Workflow } from "../../bindings";

/**
 * Collapsed dimensions for workflow cards when zoomed out
 */
export const COLLAPSED_WORKFLOW_WIDTH = 280;
export const COLLAPSED_WORKFLOW_HEIGHT = 100;

/**
 * Data passed to WorkflowZoneNode
 */
export type WorkflowZoneNodeData = {
  workflow: Workflow;
  taskCount: number;
  stepCount: number;
  width: number;
  height: number;
  onWorkflowClick?: (workflow: Workflow) => void;
  isWorkflowSelected?: boolean;
  /** When true, renders as a compact card without internal details */
  isCollapsed?: boolean;
  isFlashing?: boolean;
};

export type WorkflowZoneNodeType = Node<WorkflowZoneNodeData, "workflowZoneNode">;

/**
 * Custom node component for displaying a workflow zone.
 * When zoomed out (isCollapsed=true), renders as a compact card.
 * When zoomed in, renders as a container for step nodes and task zones.
 */
function WorkflowZoneNodeComponent({
  data,
}: NodeProps<WorkflowZoneNodeType>) {
  const {
    workflow,
    taskCount,
    stepCount,
    width,
    height,
    onWorkflowClick,
    isWorkflowSelected,
    isCollapsed = false,
    isFlashing = false,
  } = data;

  const handleWorkflowClick = () => {
    if (onWorkflowClick) {
      onWorkflowClick(workflow);
    }
  };

  // Collapsed view - compact card
  if (isCollapsed) {
    return (
      <div
        className={`relative rounded-xl bg-bg-secondary/80 backdrop-blur-sm transition-all cursor-pointer hover:bg-bg-secondary ${
          isWorkflowSelected ? "ring-2 ring-primary" : ""
        }`}
        style={{
          width: `${COLLAPSED_WORKFLOW_WIDTH}px`,
          height: `${COLLAPSED_WORKFLOW_HEIGHT}px`,
          border: "1px solid rgba(100, 116, 139, 0.5)",
        }}
        onClick={handleWorkflowClick}
      >
        {/* Handles for workflow-to-workflow transition edges */}
        <Handle
          type="target"
          position={Position.Top}
          className="!bg-accent !border-bg-primary !w-3 !h-3"
        />
        <Handle
          type="source"
          position={Position.Bottom}
          className="!bg-accent !border-bg-primary !w-3 !h-3"
        />

        {/* Compact content */}
        <div className="p-4 h-full flex flex-col justify-center">
          <h3 className="text-base font-semibold text-text-primary truncate">
            {workflow.name}
          </h3>
          <div className="mt-2 flex items-center gap-4 text-xs text-text-muted">
            <span>{stepCount} steps</span>
            <span>{taskCount} tasks</span>
          </div>
        </div>
      </div>
    );
  }

  // Expanded view - full zone with dashed border
  return (
    <div
      className={`relative rounded-xl bg-bg-secondary/30 transition-all ${isFlashing ? 'animate-flash-border' : ''}`}
      style={{
        width: `${width}px`,
        height: `${height}px`,
        border: "2px dashed rgba(100, 116, 139, 0.4)",
      }}
    >
      {/* Handles for workflow-to-workflow transition edges */}
      <Handle
        type="target"
        position={Position.Left}
        className="!bg-accent !border-bg-primary !w-3 !h-3"
        style={{ top: "50%" }}
      />
      <Handle
        type="source"
        position={Position.Right}
        className="!bg-accent !border-bg-primary !w-3 !h-3"
        style={{ top: "50%" }}
      />

      {/* Workflow header */}
      <div
        className="absolute left-4 top-4 right-4 z-10"
      >
        <button
          type="button"
          onClick={handleWorkflowClick}
          className={`text-lg font-semibold transition-colors text-left cursor-pointer pointer-events-auto ${
            isWorkflowSelected
              ? "text-primary"
              : "text-text-primary hover:text-primary"
          }`}
        >
          {workflow.name}
        </button>
        <div className="mt-1 flex items-center gap-3 text-xs text-text-muted">
          <code className="font-mono">{workflow.id?.slice(0, 8)}</code>
          <span className="flex items-center gap-1">
            <svg
              className="h-3 w-3"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 6h16M4 12h16M4 18h7"
              />
            </svg>
            {stepCount} step{stepCount !== 1 ? "s" : ""}
          </span>
          <span className="flex items-center gap-1">
            <svg
              className="h-3 w-3"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
              />
            </svg>
            {taskCount} task{taskCount !== 1 ? "s" : ""}
          </span>
        </div>
        {workflow.description && (
          <p className="mt-2 text-sm text-text-secondary line-clamp-2">
            {workflow.description}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Memoized WorkflowZoneNode to prevent unnecessary re-renders
 */
export const WorkflowZoneNode = memo(WorkflowZoneNodeComponent);

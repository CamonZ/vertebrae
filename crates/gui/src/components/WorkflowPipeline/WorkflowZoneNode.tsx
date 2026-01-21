import { memo } from "react";
import { type NodeProps, type Node } from "@xyflow/react";
import type { Workflow } from "../../bindings";

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
};

export type WorkflowZoneNodeType = Node<WorkflowZoneNodeData, "workflowZoneNode">;

/**
 * Custom node component for displaying a workflow zone with dashed borders.
 * Acts as a visual container for the workflow's step nodes and task zones.
 * Click on step zone headers (e.g., "backlog", "todo") to view filtered tasks.
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
  } = data;

  const handleWorkflowClick = () => {
    if (onWorkflowClick) {
      onWorkflowClick(workflow);
    }
  };

  return (
    <div
      className="relative rounded-xl bg-bg-secondary/30 transition-all"
      style={{
        width: `${width}px`,
        height: `${height}px`,
        border: "2px dashed rgba(100, 116, 139, 0.4)",
      }}
    >
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

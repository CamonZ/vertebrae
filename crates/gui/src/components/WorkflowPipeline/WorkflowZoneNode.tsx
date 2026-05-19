import { memo } from "react";
import { type NodeProps, type Node, Handle, Position } from "@xyflow/react";
import type { Workflow } from "../../bindings";
import { ScanIdentifier } from "../shared/EntityId";

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
  isFlashing?: boolean;
  isWorkflowHighlighted?: boolean;
};

export type WorkflowZoneNodeType = Node<WorkflowZoneNodeData, "workflowZoneNode">;

/**
 * Custom node component for displaying a workflow zone.
 * Renders a container for step nodes and task zones.
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
    isFlashing = false,
    isWorkflowHighlighted = false,
  } = data;

  const handleWorkflowClick = () => {
    if (onWorkflowClick) {
      onWorkflowClick(workflow);
    }
  };

  return (
    <div
      className={`relative rounded-xl bg-bg-secondary/30 transition-all ${isFlashing ? 'animate-flash-border' : ''}`}
      style={{
        width: `${width}px`,
        height: `${height}px`,
        border: isWorkflowHighlighted
          ? "2px dashed #ff5c2e"
          : "2px dashed rgba(100, 116, 139, 0.4)",
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
        <div className="flex items-center gap-2">
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
          {workflow.is_default && (
            <span className="inline-flex flex-shrink-0 items-center rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium uppercase tracking-wider text-primary pointer-events-none">
              Default
            </span>
          )}
          {workflow.is_final && (
            <span className="inline-flex flex-shrink-0 items-center rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium uppercase tracking-wider text-warning pointer-events-none">
              Final
            </span>
          )}
        </div>
        <div className="mt-1 flex items-center gap-3 text-xs text-text-muted">
          <ScanIdentifier
            id={workflow.id}
            kind="workflow"
            copyable={false}
            className="text-xs"
            testId="workflow-zone-id"
          />
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
          {workflow.kanban_column && (
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
                  d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7"
                />
              </svg>
              {workflow.kanban_column}
            </span>
          )}
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

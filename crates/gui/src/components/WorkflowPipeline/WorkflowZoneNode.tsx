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
  activeCount?: number;
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
    activeCount = 0,
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
      className={`relative rounded-xl bg-bg-1/40 transition-all ${isFlashing ? "animate-flash-border" : ""}`}
      style={{
        width: `${width}px`,
        height: `${height}px`,
        border: isWorkflowHighlighted
          ? "2px dashed #ff5c2e"
          : isWorkflowSelected
            ? "2px solid var(--color-accent)"
            : "1px solid var(--color-line-strong)",
        boxShadow: isWorkflowSelected
          ? "0 0 0 1px color-mix(in oklch, var(--color-accent) 35%, transparent), 0 24px 60px rgba(0,0,0,0.28)"
          : "0 18px 44px rgba(0,0,0,0.2)",
      }}
    >
      {/* Handles for workflow-to-workflow transition edges */}
      <Handle
        type="target"
        position={Position.Left}
        className="!bg-accent !border-bg !w-3 !h-3"
        style={{ top: "50%" }}
      />
      <Handle
        type="source"
        position={Position.Right}
        className="!bg-accent !border-bg !w-3 !h-3"
        style={{ top: "50%" }}
      />

      {/* Workflow header */}
      <div className="absolute left-4 right-4 top-4 z-10">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleWorkflowClick}
            className={`nodrag nopan cursor-pointer pointer-events-auto text-left text-base font-semibold transition-colors ${
              isWorkflowSelected
                ? "text-accent"
                : "text-fg hover:text-accent"
            }`}
          >
            {workflow.name}
          </button>
          {workflow.is_default && (
            <span className="inline-flex flex-shrink-0 items-center rounded-full bg-accent/15 px-2 py-0.5 text-2xs font-medium uppercase tracking-wider text-accent pointer-events-none">
              Default
            </span>
          )}
          {workflow.is_final && (
            <span className="inline-flex flex-shrink-0 items-center rounded-full bg-warn/15 px-2 py-0.5 text-2xs font-medium uppercase tracking-wider text-warn pointer-events-none">
              Final
            </span>
          )}
          {activeCount > 0 && (
            <span className="inline-flex flex-shrink-0 items-center gap-1 rounded-full border border-ok/30 bg-ok/10 px-2 py-0.5 font-mono text-2xs text-ok pointer-events-none">
              <span className="h-1.5 w-1.5 rounded-full bg-ok" />
              {activeCount} active
            </span>
          )}
        </div>
        <div className="mt-1 flex items-center gap-3 text-xs text-fg-mute">
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
          <p className="mt-2 text-sm text-fg-soft line-clamp-2">
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

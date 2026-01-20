import { memo } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import type { TaskLevel, TaskWithRelations, Step } from "../../bindings";
import { getStatusColor, getStatusIcon, getLevelDotColor } from "./taskUtils";

/**
 * Zone node data type for task containers within workflow zones
 */
export type TaskZoneNodeData = {
  label: string;
  tasks: TaskWithRelations[];
  executionState?: Map<
    string,
    { currentStep: string | number; status: string; error?: string }
  >;
  onTaskClick?: (taskId: string) => void;
  selectedTaskId?: string | null;
  onZoneClick?: (step: Step) => void;
  step?: Step;
  isZoneActive?: boolean;
  [key: string]: unknown;
};

export type TaskZoneNodeType = Node<TaskZoneNodeData, "taskZoneNode">;

/**
 * Custom zone node component - scrollable container for tasks
 */
export const TaskZoneNode = memo(function TaskZoneNode({
  data,
}: NodeProps<Node<TaskZoneNodeData>>) {
  const {
    label,
    tasks = [],
    executionState,
    onTaskClick,
    selectedTaskId,
    onZoneClick,
    step,
  } = data;

  // Determine if this zone is active (currently showing filtered tasks panel)
  const isZoneActive = data.isZoneActive ?? false;

  const handleZoneClick = () => {
    if (step && onZoneClick) {
      onZoneClick(step);
    }
  };

  // Determine title styles based on active state (hover via CSS)
  const getTitleClassName = () => {
    const base =
      "text-xs font-semibold uppercase tracking-wider mb-2 px-1 transition-colors cursor-pointer rounded text-left";
    if (isZoneActive) {
      return `${base} text-primary font-bold`;
    }
    return `${base} text-text-muted hover:text-warning`;
  };

  return (
    <div className="flex flex-col w-[280px] h-[280px] text-left">
      <button
        type="button"
        onClick={handleZoneClick}
        className={getTitleClassName()}
      >
        {label}
      </button>
      <div className="flex-1 overflow-y-auto overflow-x-hidden space-y-1.5 pr-1 scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent">
        {tasks.map((tr) => {
          const execState = executionState?.get(tr.task.id!);
          const status =
            tr.task.status === "done" || tr.task.status === "rejected"
              ? "done"
              : execState?.status || "waiting";
          const isSelected = selectedTaskId === tr.task.id;

          return (
            <button
              key={tr.task.id}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onTaskClick?.(tr.task.id!);
              }}
              className={`w-full text-left rounded-lg border p-2 transition-all duration-200 ${getStatusColor(status, isSelected)} hover:border-primary/50 cursor-pointer`}
            >
              <div className="flex items-start gap-2">
                <span
                  className={`flex-shrink-0 text-xs font-bold ${
                    status === "in_progress"
                      ? "animate-spin text-accent"
                      : status === "done"
                        ? "text-success"
                        : status === "failed"
                          ? "text-error"
                          : "text-text-muted"
                  }`}
                >
                  {getStatusIcon(status)}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`flex-shrink-0 w-2 h-2 rounded-full ${getLevelDotColor(tr.task.level as TaskLevel)}`}
                      title={tr.task.level}
                    />
                    <p
                      className="truncate text-xs font-medium text-text-primary"
                      title={tr.task.title}
                    >
                      {tr.task.title}
                    </p>
                  </div>
                  <code className="block truncate font-mono text-[10px] text-text-muted">
                    {(tr.task.id ?? "").slice(0, 8)}
                  </code>
                </div>
              </div>
            </button>
          );
        })}
        {tasks.length === 0 && (
          <div className="text-xs text-text-muted italic px-1">No tasks</div>
        )}
      </div>
    </div>
  );
});

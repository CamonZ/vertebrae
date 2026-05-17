import { useCallback } from "react";
import type { Task, TaskPriority } from "../../bindings";
import type { TaskTreeNode as TaskTreeNodeType } from "../../types/ui";
import type { useExpandedNodes } from "../../hooks/useExpandedNodes";
import { RelativeTime } from "../RelativeTime";
import { deriveRunStateChip, getRunChipStyles } from "../../utils/runState";
import { ScanIdentifier } from "../shared/EntityId";
import { TaskLevelLabel } from "../shared/TaskLevelLabel";

const ROW_BASE_PADDING_PX = 6;
const ROW_DEPTH_INDENT_PX = 10;

interface TaskTreeNodeProps {
  node: TaskTreeNodeType;
  depth: number;
  isSelected?: boolean;
  selectedTaskId?: string | null;
  onTaskSelect?: (task: Task) => void;
  expandedNodes?: ReturnType<typeof useExpandedNodes>;
  hideStatus?: boolean;
}

function getStepStyles(stepName: string | null): { bg: string; text: string } {
  if (!stepName) return { bg: "bg-bg-tertiary", text: "text-text-muted" };
  switch (stepName.toLowerCase()) {
    case "todo":
      return { bg: "bg-primary/10", text: "text-primary" };
    case "in_progress":
    case "in progress":
      return { bg: "bg-warning/10", text: "text-warning" };
    case "pending_review":
    case "review":
      return { bg: "bg-info/10", text: "text-info" };
    case "done":
      return { bg: "bg-success/10", text: "text-success" };
    case "rejected":
      return { bg: "bg-error/10", text: "text-error" };
    default:
      return { bg: "bg-bg-tertiary", text: "text-text-muted" };
  }
}

function formatStepName(stepName: string | null): string {
  if (!stepName) return "—";
  return (
    stepName.charAt(0).toUpperCase() + stepName.slice(1).replace(/_/g, " ")
  );
}

function getPriorityIndicator(
  priority: TaskPriority | null
): { icon: string; color: string } | null {
  if (!priority) return null;
  switch (priority) {
    case "critical":
      return { icon: "!!!", color: "text-error" };
    case "high":
      return { icon: "!!", color: "text-warning" };
    case "medium":
      return { icon: "!", color: "text-text-secondary" };
    case "low":
      return { icon: "·", color: "text-text-muted" };
    default:
      return null;
  }
}

export function TaskTreeNode({
  node,
  depth,
  selectedTaskId,
  onTaskSelect,
  expandedNodes,
  hideStatus,
}: TaskTreeNodeProps) {
  const task = node.task;
  const hasChildren = node.children.length > 0;
  const isSelected = selectedTaskId === task.id;
  const isExpanded = expandedNodes
    ? expandedNodes.isNodeExpanded(task.id)
    : true;

  const handleClick = useCallback(() => {
    onTaskSelect?.(task);
  }, [onTaskSelect, task]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onTaskSelect?.(task);
      }
    },
    [onTaskSelect, task]
  );

  const handleToggleExpand = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      expandedNodes?.toggleNode(task.id);
    },
    [expandedNodes, task.id]
  );

  const handleToggleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.stopPropagation();
        expandedNodes?.toggleNode(task.id);
      }
    },
    [expandedNodes, task.id]
  );

  const stepStyles = getStepStyles(task.step_name);
  const priorityIndicator = getPriorityIndicator(task.priority);
  const runChip = deriveRunStateChip(task);
  const runChipStyles = runChip ? getRunChipStyles(runChip) : null;

  const indentPx = depth * ROW_DEPTH_INDENT_PX;

  return (
    <div>
      <div
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        tabIndex={0}
        role="treeitem"
        aria-expanded={hasChildren ? isExpanded : undefined}
        aria-selected={isSelected}
        className={`group relative flex h-9 cursor-pointer items-center gap-2 border-b border-border/40 pr-4 text-sm transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary ${isSelected ? "bg-primary/5" : "hover:bg-bg-hover/60"
          }`}
        style={{ paddingLeft: `${ROW_BASE_PADDING_PX}px` }}
      >
        {isSelected && (
          <div className="absolute left-0 top-0 h-full w-0.5 bg-primary" />
        )}

        {/* Child count + chevron share one aligned gutter across depths. */}
        <div className="flex w-8 shrink-0 items-center justify-end gap-0.5">
          {hasChildren ? (
            <>
              <span className="w-4 text-right font-mono text-[10px] tabular-nums text-text-muted">
                {node.children.length}
              </span>
              <button
                type="button"
                onClick={handleToggleExpand}
                onKeyDown={handleToggleKeyDown}
                className="flex h-4 w-4 items-center justify-center rounded text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                aria-label={isExpanded ? "Collapse" : "Expand"}
              >
                <svg
                  className={`h-3 w-3 transition-transform duration-150 ${isExpanded ? "rotate-90" : ""}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 5l7 7-7 7"
                  />
                </svg>
              </button>
            </>
          ) : (
            <>
              <span className="w-4" />
              <span className="h-4 w-4" />
            </>
          )}
        </div>

        {depth > 0 && (
          <span
            aria-hidden="true"
            className="shrink-0"
            style={{ width: `${indentPx}px` }}
          />
        )}

        {/* Priority */}
        <span
          className={`w-4 shrink-0 text-center font-mono text-xs font-bold ${priorityIndicator?.color ?? "text-text-muted/40"
            }`}
        >
          {priorityIndicator?.icon ?? "·"}
        </span>

        {/* Level */}
        <TaskLevelLabel level={task.level} className="w-12 shrink-0" />

        {/* ID + copy */}
        <ScanIdentifier
          id={task.id}
          kind="task"
          className="shrink-0"
          testId="task-tree-node-id"
        />

        {/* Title */}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {runChip && runChipStyles && (
            <span
              data-testid="task-tree-node-run-chip"
              data-run-status={runChip.status}
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${runChipStyles.dot} ${runChipStyles.pulse ? "animate-pulse" : ""
                }`}
              title={`Run: ${runChip.label}`}
              aria-label={`Run state: ${runChip.label}`}
            />
          )}
          <span className="truncate font-medium text-text-primary">
            {task.title}
          </span>
          {task.needs_human_review && (
            <span className="inline-flex shrink-0 items-center rounded-full bg-warning/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-warning">
              Review
            </span>
          )}
          {runChip && runChipStyles && (
            <span
              data-testid="task-tree-node-run-chip-label"
              className={`inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider ${runChipStyles.bg} ${runChipStyles.text}`}
            >
              {runChip.label}
            </span>
          )}
        </div>

        {/* Workflow · Step */}
        {!hideStatus && (
          <div className="flex shrink-0 items-center gap-2 text-xs">
            {task.workflow_name && (
              <span className="text-text-muted">{task.workflow_name}</span>
            )}
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${stepStyles.bg} ${stepStyles.text}`}
            >
              {formatStepName(task.step_name)}
            </span>
          </div>
        )}

        {/* Timestamp */}
        <div className="w-16 shrink-0 text-right">
          {task.created_at ? (
            <RelativeTime
              date={task.created_at}
              className="font-mono text-[11px] tabular-nums text-text-muted"
            />
          ) : (
            <span className="font-mono text-[11px] text-text-muted">—</span>
          )}
        </div>
      </div>

      {/* Children */}
      {hasChildren && isExpanded && (
        <div role="group" aria-label={`Children of ${task.title}`}>
          {node.children.map((childNode: TaskTreeNodeType) => (
            <TaskTreeNode
              key={childNode.task.id}
              node={childNode}
              depth={depth + 1}
              selectedTaskId={selectedTaskId}
              onTaskSelect={onTaskSelect}
              expandedNodes={expandedNodes}
              hideStatus={hideStatus}
            />
          ))}
        </div>
      )}
    </div>
  );
}

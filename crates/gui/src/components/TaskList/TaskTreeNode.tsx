import { useCallback } from "react";
import type { Task, TaskPriority } from "../../bindings";
import type { TaskTreeNode as TaskTreeNodeType } from "../../types/ui";
import type { useExpandedNodes } from "../../hooks/useExpandedNodes";
import { RelativeTime } from "../RelativeTime";
import { deriveRunStateChip, getRunChipStyles } from "../../utils/runState";
import { IdentityBadge } from "../shared/EntityId";
import { Count } from "../atoms";

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
  if (!stepName)
    return {
      bg: "bg-[var(--color-bg-2)]",
      text: "text-[var(--color-fg-mute)]",
    };
  switch (stepName.toLowerCase()) {
    case "todo":
      return {
        bg: "bg-[var(--color-accent-wash)]",
        text: "text-[var(--color-accent)]",
      };
    case "in_progress":
    case "in progress":
      return {
        bg: "bg-[var(--color-warn-wash)]",
        text: "text-[var(--color-warn)]",
      };
    case "pending_review":
    case "review":
      return {
        bg: "bg-[var(--color-info-wash)]",
        text: "text-[var(--color-info)]",
      };
    case "done":
      return {
        bg: "bg-[var(--color-ok-wash)]",
        text: "text-[var(--color-ok)]",
      };
    case "rejected":
      return {
        bg: "bg-[var(--color-err-wash)]",
        text: "text-[var(--color-err)]",
      };
    default:
      return {
        bg: "bg-[var(--color-bg-2)]",
        text: "text-[var(--color-fg-mute)]",
      };
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
      return { icon: "!!!", color: "text-[var(--color-err)]" };
    case "high":
      return { icon: "!!", color: "text-[var(--color-warn)]" };
    case "medium":
      return { icon: "!", color: "text-[var(--color-fg-soft)]" };
    case "low":
      return { icon: "·", color: "text-[var(--color-fg-mute)]" };
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
        className={`group relative flex h-9 cursor-pointer items-center gap-2 border-b border-[var(--color-line)]/60 pr-4 text-sm transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)] ${
          isSelected
            ? "bg-[var(--color-accent-wash)]/40"
            : "hover:bg-[var(--color-bg-2)]"
        }`}
        style={{ paddingLeft: `${ROW_BASE_PADDING_PX}px` }}
      >
        {isSelected && (
          <div className="absolute left-0 top-0 h-full w-0.5 bg-[var(--color-accent)]" />
        )}

        {/* Child count + chevron share one aligned gutter across depths. */}
        <div className="flex w-8 shrink-0 items-center justify-end gap-0.5">
          {hasChildren ? (
            <>
              <Count
                value={node.children.length}
                className="w-4 text-right text-2xs"
              />
              <button
                type="button"
                onClick={handleToggleExpand}
                onKeyDown={handleToggleKeyDown}
                className="flex h-4 w-4 items-center justify-center rounded text-[var(--color-fg-mute)] transition-colors hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)]"
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
          className={`w-4 shrink-0 text-center font-mono text-xs font-bold ${
            priorityIndicator?.color ?? "text-[var(--color-fg-faint)]"
          }`}
        >
          {priorityIndicator?.icon ?? "·"}
        </span>

        {/* ID + copy */}
        <IdentityBadge
          id={task.id}
          kind="task"
          level={task.level}
          className="shrink-0"
          testId="task-tree-node-id"
        />

        {/* Title */}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {runChip && runChipStyles && (
            <span
              data-testid="task-tree-node-run-chip"
              data-run-status={runChip.status}
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${runChipStyles.dot} ${
                runChipStyles.pulse
                  ? "animate-pulse [animation-duration:3s]"
                  : ""
              }`}
              title={`Run: ${runChip.label}`}
              aria-label={`Run state: ${runChip.label}`}
            />
          )}
          <span className="truncate font-medium text-[var(--color-fg)]">
            {task.title}
          </span>
          {task.needs_human_review && (
            <span className="inline-flex shrink-0 items-center rounded-[var(--radius-sm)] bg-[var(--color-warn-wash)] px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-[0.12em] text-[var(--color-warn)]">
              Review
            </span>
          )}
          {runChip && runChipStyles && (
            <span
              data-testid="task-tree-node-run-chip-label"
              className={`inline-flex shrink-0 items-center rounded-[var(--radius-sm)] px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-[0.12em] ${runChipStyles.bg} ${runChipStyles.text}`}
            >
              {runChip.label}
            </span>
          )}
        </div>

        {/* Workflow · Step */}
        {!hideStatus && (
          <div className="flex shrink-0 items-center gap-2 text-xs">
            {task.workflow_name && (
              <span className="text-[var(--color-fg-mute)]">
                {task.workflow_name}
              </span>
            )}
            <span
              className={`inline-flex items-center rounded-[var(--radius-sm)] border border-current/30 px-2 py-0.5 text-2xs font-medium ${stepStyles.bg} ${stepStyles.text}`}
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
              className="font-mono text-eyebrow tabular-nums text-[var(--color-fg-mute)]"
            />
          ) : (
            <span className="font-mono text-eyebrow text-[var(--color-fg-faint)]">
              —
            </span>
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

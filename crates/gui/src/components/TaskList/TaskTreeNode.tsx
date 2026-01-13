import { useCallback } from "react";
import type {
  TaskHierarchyNode,
  TaskSummary,
  TaskStatus,
  TaskLevel,
  TaskPriority,
} from "../../bindings";
import type { useExpandedNodes } from "../../hooks/useExpandedNodes";
import { RelativeTime } from "../RelativeTime";

interface TaskTreeNodeProps {
  node: TaskHierarchyNode;
  depth: number;
  isSelected?: boolean;
  selectedTaskId?: string | null;
  onTaskSelect?: (task: TaskSummary) => void;
  expandedNodes?: ReturnType<typeof useExpandedNodes>;
}

/**
 * Get status badge styling based on task status
 */
function getStatusStyles(
  status: TaskStatus
): { bg: string; text: string; glow?: string } {
  switch (status) {
    case "backlog":
      return { bg: "bg-bg-tertiary", text: "text-text-muted" };
    case "todo":
      return { bg: "bg-primary/10", text: "text-primary" };
    case "in_progress":
      return {
        bg: "bg-warning/10",
        text: "text-warning",
        glow: "shadow-[0_0_8px_rgba(245,158,11,0.3)]",
      };
    case "pending_review":
      return { bg: "bg-info/10", text: "text-info" };
    case "done":
      return { bg: "bg-success/10", text: "text-success" };
    case "rejected":
      return { bg: "bg-error/10", text: "text-error" };
    default:
      return { bg: "bg-bg-tertiary", text: "text-text-muted" };
  }
}

/**
 * Format status for display
 */
function formatStatus(status: TaskStatus): string {
  switch (status) {
    case "backlog":
      return "Backlog";
    case "todo":
      return "Todo";
    case "in_progress":
      return "Active";
    case "pending_review":
      return "Review";
    case "done":
      return "Done";
    case "rejected":
      return "Rejected";
    default:
      return status;
  }
}

/**
 * Get level indicator styling
 */
function getLevelStyles(
  level: TaskLevel
): { bg: string; text: string; border: string } {
  switch (level) {
    case "epic":
      return { bg: "bg-info/10", text: "text-info", border: "border-info/30" };
    case "ticket":
      return {
        bg: "bg-primary/10",
        text: "text-primary",
        border: "border-primary/30",
      };
    case "task":
      return {
        bg: "bg-bg-tertiary",
        text: "text-text-secondary",
        border: "border-border",
      };
    default:
      return {
        bg: "bg-bg-tertiary",
        text: "text-text-muted",
        border: "border-border",
      };
  }
}

/**
 * Format level for display
 */
function formatLevel(level: TaskLevel): string {
  switch (level) {
    case "epic":
      return "Epic";
    case "ticket":
      return "Ticket";
    case "task":
      return "Task";
    default:
      return level;
  }
}

/**
 * Get priority indicator
 */
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
      return { icon: "-", color: "text-text-muted" };
    default:
      return null;
  }
}

/**
 * Truncate task ID for display (show first 6 characters)
 */
function truncateId(id: string): string {
  return id.slice(0, 6);
}

/**
 * TaskTreeNode component renders a single node in the task hierarchy tree.
 * Features expand/collapse functionality and visual indentation for hierarchy.
 */
export function TaskTreeNode({
  node,
  depth,
  selectedTaskId,
  onTaskSelect,
  expandedNodes,
}: TaskTreeNodeProps) {
  const task = node.task;
  const hasChildren = node.children.length > 0;
  const isSelected = selectedTaskId === task.id;
  const isActive = task.status === "in_progress";

  // Determine if this node is expanded - default to true if no expandedNodes provided
  const isExpanded = expandedNodes ? expandedNodes.isNodeExpanded(task.id) : true;

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

  const statusStyles = getStatusStyles(task.status);
  const levelStyles = getLevelStyles(task.level);
  const priorityIndicator = getPriorityIndicator(task.priority);

  // Calculate indentation based on depth
  const indentPx = depth * 24;

  return (
    <div className="relative">
      {/* Tree lines for hierarchy visualization */}
      {depth > 0 && (
        <div
          className="absolute top-0 h-full border-l border-border/50"
          style={{ left: `${(depth - 1) * 24 + 12}px` }}
        />
      )}

      {/* Node row */}
      <div
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        tabIndex={0}
        role="treeitem"
        aria-expanded={hasChildren ? isExpanded : undefined}
        aria-selected={isSelected}
        className={`group relative flex cursor-pointer items-center gap-2 border-b border-border py-2.5 pr-4 transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary ${
          isSelected ? "bg-primary/5" : "hover:bg-bg-hover"
        }`}
        style={{ paddingLeft: `${indentPx + 16}px` }}
      >
        {/* Horizontal tree line connector */}
        {depth > 0 && (
          <div
            className="absolute top-1/2 h-px w-3 bg-border/50"
            style={{ left: `${(depth - 1) * 24 + 12}px` }}
          />
        )}

        {/* Selection indicator */}
        {isSelected && (
          <div className="absolute left-0 top-0 h-full w-0.5 bg-primary" />
        )}

        {/* Expand/collapse button for parent nodes */}
        <button
          type="button"
          onClick={handleToggleExpand}
          onKeyDown={handleToggleKeyDown}
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors ${
            hasChildren
              ? "text-text-muted hover:bg-bg-tertiary hover:text-text-primary"
              : "invisible"
          }`}
          aria-label={isExpanded ? "Collapse" : "Expand"}
          tabIndex={hasChildren ? 0 : -1}
        >
          <svg
            className={`h-3.5 w-3.5 transition-transform duration-150 ${
              isExpanded ? "rotate-90" : ""
            }`}
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

        {/* Created timestamp */}
        <RelativeTime date={task.created_at} className="shrink-0 w-16" />

        {/* Task ID */}
        <code className="shrink-0 font-mono text-xs text-text-muted">
          {truncateId(task.id)}
        </code>

        {/* Title with active indicator */}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {isActive && (
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-warning opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-warning" />
            </span>
          )}
          <span
            className={`truncate text-sm font-medium ${
              isSelected
                ? "text-text-primary"
                : "text-text-primary group-hover:text-text-primary"
            }`}
          >
            {task.title}
          </span>
          {task.needs_human_review && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-warning">
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
                  d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                />
              </svg>
              Review
            </span>
          )}
        </div>

        {/* Level badge */}
        <span
          className={`inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${levelStyles.bg} ${levelStyles.text} ${levelStyles.border}`}
        >
          {formatLevel(task.level)}
        </span>

        {/* Status badge */}
        <span
          className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${statusStyles.bg} ${statusStyles.text} ${statusStyles.glow ?? ""}`}
        >
          {formatStatus(task.status)}
        </span>

        {/* Priority indicator */}
        {priorityIndicator ? (
          <span
            className={`shrink-0 font-mono text-sm font-bold ${priorityIndicator.color}`}
          >
            {priorityIndicator.icon}
          </span>
        ) : (
          <span className="w-6 shrink-0" />
        )}

        {/* Child count indicator */}
        {hasChildren && (
          <span className="shrink-0 rounded-full bg-bg-tertiary px-1.5 py-0.5 font-mono text-[10px] text-text-muted">
            {node.children.length}
          </span>
        )}
      </div>

      {/* Children (when expanded) */}
      {hasChildren && isExpanded && (
        <div role="group" aria-label={`Children of ${task.title}`}>
          {node.children.map((childNode) => (
            <TaskTreeNode
              key={childNode.task.id}
              node={childNode}
              depth={depth + 1}
              selectedTaskId={selectedTaskId}
              onTaskSelect={onTaskSelect}
              expandedNodes={expandedNodes}
            />
          ))}
        </div>
      )}
    </div>
  );
}

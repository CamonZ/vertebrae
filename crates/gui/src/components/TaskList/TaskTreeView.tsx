import type { TaskHierarchyNode, TaskSummary } from "../../bindings";
import { TaskTreeNode } from "./TaskTreeNode";
import type { useExpandedNodes } from "../../hooks/useExpandedNodes";

interface TaskTreeViewProps {
  hierarchy: TaskHierarchyNode[];
  isLoading: boolean;
  error: string | null;
  selectedTaskId?: string | null;
  onTaskSelect?: (task: TaskSummary) => void;
  expandedNodes?: ReturnType<typeof useExpandedNodes>;
}

/**
 * Loading skeleton with neural pulse effect for tree view
 */
function LoadingSkeleton() {
  return (
    <div className="relative" role="status" aria-label="Loading tasks">
      {/* Signal flow animation overlay */}
      <div className="animate-signal-flow pointer-events-none absolute inset-0" />

      {Array.from({ length: 6 }).map((_, index) => (
        <div
          key={index}
          className="flex items-center gap-3 border-b border-border px-4 py-2.5"
          style={{
            animationDelay: `${index * 50}ms`,
            paddingLeft: `${(index % 3) * 24 + 16}px`,
          }}
        >
          <div className="h-5 w-5 animate-pulse rounded bg-bg-tertiary" />
          <div className="h-4 w-12 animate-pulse rounded bg-bg-tertiary" />
          <div className="h-4 flex-1 animate-pulse rounded bg-bg-tertiary" />
          <div className="h-5 w-12 animate-pulse rounded bg-bg-tertiary" />
          <div className="h-5 w-16 animate-pulse rounded-full bg-bg-tertiary" />
        </div>
      ))}
      <span className="sr-only">Loading tasks...</span>
    </div>
  );
}

/**
 * Empty state with neural aesthetic
 */
function EmptyState() {
  return (
    <div
      className="relative flex flex-col items-center justify-center py-16 text-center"
      role="status"
    >
      {/* Neural grid background */}
      <div className="neural-grid pointer-events-none absolute inset-0 opacity-20" />

      <div className="relative">
        <svg
          className="mx-auto mb-4 h-16 w-16 text-text-muted"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1}
            d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z"
          />
        </svg>
        <p className="text-sm font-medium text-text-primary">No tasks found</p>
        <p className="mt-1 text-xs text-text-muted">
          Adjust filters or create a new task
        </p>
      </div>
    </div>
  );
}

/**
 * Error state with error glow effect
 */
function ErrorState({ error }: { error: string }) {
  return (
    <div
      className="flex flex-col items-center justify-center py-16 text-center"
      role="alert"
    >
      <div className="relative">
        {/* Error glow */}
        <div className="absolute inset-0 rounded-full bg-error/20 blur-xl" />

        <svg
          className="relative mx-auto mb-4 h-12 w-12 text-error"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
          />
        </svg>
      </div>
      <p className="text-sm font-medium text-text-primary">
        Failed to load tasks
      </p>
      <p className="mt-2 max-w-sm rounded-lg border border-error/20 bg-error/5 px-4 py-2 font-mono text-xs text-error">
        {error}
      </p>
    </div>
  );
}

/**
 * Count total tasks in hierarchy (recursive)
 */
function countTasks(nodes: TaskHierarchyNode[]): number {
  return nodes.reduce((count, node) => {
    return count + 1 + countTasks(node.children);
  }, 0);
}

/**
 * TaskTreeView component displays tasks in a hierarchical tree structure.
 * Shows parent-child relationships with expandable/collapsible nodes.
 * Uses the Neural Pathways design system.
 */
export function TaskTreeView({
  hierarchy,
  isLoading,
  error,
  selectedTaskId,
  onTaskSelect,
  expandedNodes,
}: TaskTreeViewProps) {
  if (error) {
    return <ErrorState error={error} />;
  }

  if (isLoading) {
    return <LoadingSkeleton />;
  }

  if (hierarchy.length === 0) {
    return <EmptyState />;
  }

  const totalTasks = countTasks(hierarchy);

  return (
    <div className="overflow-x-auto">
      {/* Tree header with task count */}
      <div className="sticky top-0 z-10 flex items-center justify-end border-b border-border bg-bg-secondary/50 px-4 py-2 backdrop-blur-sm">
        <span className="font-mono text-[10px] text-text-muted">
          {hierarchy.length} root{hierarchy.length !== 1 ? "s" : ""} / {totalTasks} total
        </span>
      </div>

      {/* Tree content */}
      <div role="tree" aria-label="Task hierarchy">
        {hierarchy.map((node) => (
          <TaskTreeNode
            key={node.task.id}
            node={node}
            depth={0}
            selectedTaskId={selectedTaskId}
            onTaskSelect={onTaskSelect}
            expandedNodes={expandedNodes}
          />
        ))}
      </div>
    </div>
  );
}

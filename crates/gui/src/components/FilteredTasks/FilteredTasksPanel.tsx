import { useState, useCallback, useMemo } from "react";
import type { TaskFilterOptions, TaskSummary, TaskHierarchyNode, Step } from "../../bindings";
import type { ViewMode } from "../TaskList";
import { TaskList, TaskTreeView } from "../TaskList";
import { useTaskHierarchy } from "../../hooks/useTaskHierarchy";
import { useExpandedNodes } from "../../hooks/useExpandedNodes";
import { ResizablePanel } from "../ResizablePanel";

interface FilteredTasksPanelProps {
  step: Step | null;
  tasks: TaskSummary[];
  workflowId: string;
  onClose?: () => void;
  onTaskSelect?: (taskId: string) => void;
  selectedTaskId?: string | null;
}

/**
 * FilteredTasksPanel displays tasks filtered by a specific workflow step/zone.
 * Reuses TasksPage components (search, view toggle, TaskList/TaskTreeView) for consistency.
 * Excludes status filter and done toggle since filtering is by step.
 */
export function FilteredTasksPanel({
  step,
  tasks,
  workflowId,
  onClose,
  onTaskSelect,
  selectedTaskId,
}: FilteredTasksPanelProps) {
  const [search, setSearch] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("tree");

  // Use expanded nodes hook to preserve tree collapse state
  const expandedNodes = useExpandedNodes();

  // Create filter for workflow and step status (plus search)
  const memoizedFilters = useMemo(
    () => ({
      statuses: step ? [step.name] : null,
      levels: null,
      tags: null,
      root_only: null,
      children_of: null,
      include_done: step?.name.toLowerCase() === "done",
      search,
      workflow_id: workflowId,
    } as TaskFilterOptions),
    [search, step, workflowId]
  );

  // Fetch hierarchy with current filters
  const {
    hierarchy = [],
    isLoading: isHierarchyLoading,
    error: hierarchyError,
  } = useTaskHierarchy(null, memoizedFilters) || {};

  const handleViewModeChange = useCallback((mode: ViewMode) => {
    setViewMode(mode);
  }, []);

  if (!step) {
    return null;
  }

  // Count active tasks
  const activeCount = tasks.filter((t) => t.status === "in_progress").length;

  // Count total tasks based on view mode
  const totalTasks =
    viewMode === "tree" && hierarchy && Array.isArray(hierarchy)
      ? hierarchy.reduce((count, node) => count + countHierarchyTasks(node), 0)
      : tasks.length;

  return (
    <ResizablePanel
      storageKey="filtered-tasks-panel-width"
      glowColor="from-primary/0 via-primary/30 to-primary/0"
    >
      {/* Header with step info */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-lg border border-primary/30 bg-primary/10 font-mono text-xs font-bold text-primary">
              {step.order + 1}
            </span>
            <h2 className="truncate font-mono text-xs font-medium uppercase tracking-wider text-text-muted">
              {step.name}
            </h2>
          </div>
          <p className="ml-8 text-xs text-text-muted">
            {tasks.length} task{tasks.length !== 1 ? "s" : ""}
            {activeCount > 0 && (
              <span className="ml-2 text-warning">({activeCount} active)</span>
            )}
          </p>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="ml-2 rounded-lg p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary flex-shrink-0"
            aria-label="Close panel"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        )}
      </div>

      {/* Search and view toggle */}
      <div className="border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          {/* Search input */}
          <div className="relative flex-1 min-w-0">
            <input
              type="text"
              placeholder="Search..."
              value={search ?? ""}
              onChange={(e) =>
                setSearch(e.target.value || null)
              }
              className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 pl-7 text-xs text-text-primary placeholder:text-text-muted transition-all focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
              aria-label="Search tasks"
            />
            <svg
              className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
          </div>

          {/* View mode toggle */}
          <div className="flex items-center gap-1 rounded-lg border border-border bg-bg-tertiary/50 p-0.5 flex-shrink-0">
            <button
              type="button"
              onClick={() => handleViewModeChange("tree")}
              className={`flex items-center rounded-md px-2 py-1 text-xs font-medium transition-all ${
                viewMode === "tree"
                  ? "bg-primary/10 text-primary"
                  : "text-text-muted hover:text-text-primary"
              }`}
              aria-label="Tree view"
              aria-pressed={viewMode === "tree"}
            >
              <svg
                className="h-3 w-3"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z"
                />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => handleViewModeChange("list")}
              className={`flex items-center rounded-md px-2 py-1 text-xs font-medium transition-all ${
                viewMode === "list"
                  ? "bg-primary/10 text-primary"
                  : "text-text-muted hover:text-text-primary"
              }`}
              aria-label="List view"
              aria-pressed={viewMode === "list"}
            >
              <svg
                className="h-3 w-3"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M4 6h16M4 10h16M4 14h16M4 18h16"
                />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Task list/tree section */}
      <div className="flex-1 overflow-auto">
        {viewMode === "tree" ? (
          <TaskTreeView
            hierarchy={hierarchy}
            isLoading={isHierarchyLoading}
            error={hierarchyError}
            selectedTaskId={selectedTaskId}
            onTaskSelect={(task) => onTaskSelect?.(task.id)}
            expandedNodes={expandedNodes}
            hideStatus
          />
        ) : (
          <TaskList
            tasks={tasks}
            isLoading={false}
            error={null}
            selectedTaskId={selectedTaskId}
            onTaskSelect={(task) => onTaskSelect?.(task.id)}
            hideStatus
          />
        )}
      </div>

      {/* Footer with task count */}
      {totalTasks > 0 && (
        <div className="flex items-center justify-between border-t border-border bg-bg-secondary/50 px-3 py-2">
          <p className="font-mono text-xs text-text-muted">
            {totalTasks} task{totalTasks !== 1 ? "s" : ""}
          </p>
          {selectedTaskId && (
            <p className="font-mono text-xs text-text-muted">
              Selected:{" "}
              <span className="text-primary">
                {selectedTaskId.slice(0, 6)}
              </span>
            </p>
          )}
        </div>
      )}
    </ResizablePanel>
  );
}

/**
 * Count total tasks in hierarchy recursively
 */
function countHierarchyTasks(node: TaskHierarchyNode): number {
  return 1 + node.children.reduce((count, child) => count + countHierarchyTasks(child), 0);
}

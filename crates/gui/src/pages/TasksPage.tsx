import { useState, useCallback, useMemo, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import type { TaskFilterOptions, Task } from "../bindings";
import type { TaskTreeNode } from "../types/ui";
import { useTasks } from "../hooks/useTasks";
import { buildTreeFromTasks, collectExpandableIds } from "../utils/buildTreeFromTasks";
import { useExpandedNodes } from "../hooks/useExpandedNodes";
import { useShellHeader } from "../hooks/useShellHeader";
import { TaskFilters, TaskTreeView } from "../components/TaskList";
import { TaskDetailPanel } from "../components/TaskDetail";
import { IdentityBadge } from "../components/shared/EntityId";
import { isActiveRunStatus } from "../utils/runState";
import { popOut, stashTask } from "../utils";

/** Initial filter state for the Tasks page. */
const INITIAL_FILTERS: TaskFilterOptions = {
  step_names: null,
  levels: null,
  tags: null,
  root_only: null,
  children_of: null,
  search: null,
  workflow_id: null,
  step_id: null,
};

/**
 * Count total tasks in hierarchy recursively
 */
function countHierarchyTasks(nodes: TaskTreeNode[]): number {
  return nodes.reduce((count, node) => {
    return count + 1 + countHierarchyTasks(node.children);
  }, 0);
}

/**
 * TasksPage displays a filterable, searchable list of all tasks.
 * Features neural-pathway-inspired design with animated elements.
 * Supports both flat list and hierarchical tree views.
 */
export function TasksPage() {
  const [searchParams] = useSearchParams();
  const [filters, setFilters] = useState<TaskFilterOptions>(INITIAL_FILTERS);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  useShellHeader("Tasks");

  // Use expanded nodes hook to preserve tree collapse state across updates
  const expandedNodes = useExpandedNodes();

  // Initialize filters from URL parameters on mount and when URL changes
  useEffect(() => {
    const workflowId = searchParams.get("workflowId");
    if (workflowId) {
      setFilters((prev) => ({
        ...prev,
        workflow_id: workflowId,
      }));
    }
  }, [searchParams]);

  const { tasks, isLoading, error } = useTasks(filters);

  // Build tree locally from flat task list (no separate API call needed)
  const hierarchy = useMemo(() => buildTreeFromTasks(tasks), [tasks]);

  const handleFiltersChange = useCallback((newFilters: TaskFilterOptions) => {
    setFilters(newFilters);
  }, []);

  const handleTaskSelect = useCallback((task: Task) => {
    setSelectedTaskId(task.id);
  }, []);

  const handleClosePanel = useCallback(() => {
    setSelectedTaskId(null);
  }, []);

  const handleRelatedTaskSelect = useCallback((taskId: string) => {
    setSelectedTaskId(taskId);
  }, []);

  const handleDetachPanel = useCallback(async () => {
    if (!selectedTaskId) return;
    const focal = tasks.find((t) => t.id === selectedTaskId);
    if (focal) {
      const related = tasks.filter(
        (t) =>
          t.id !== selectedTaskId &&
          (t.parent_id === selectedTaskId ||
            t.dependency_ids?.includes(selectedTaskId)),
      );
      stashTask(focal, related);
    }
    await popOut(`/task/${selectedTaskId}`, `task-${selectedTaskId}`, {
      title: "Task Details",
      width: 720,
      height: 800,
    });
    setSelectedTaskId(null);
  }, [selectedTaskId, tasks]);

  const expandableIds = useMemo(
    () => collectExpandableIds(hierarchy),
    [hierarchy]
  );
  const allExpanded =
    expandableIds.length > 0 &&
    expandableIds.every((id) => expandedNodes.isNodeExpanded(id));
  const handleToggleExpandAll = useCallback(() => {
    if (allExpanded) {
      expandedNodes.resetExpandedNodes();
    } else {
      expandedNodes.expandAll(expandableIds);
    }
  }, [allExpanded, expandableIds, expandedNodes]);

  const activeCount = tasks.filter((t) =>
    isActiveRunStatus(t.run_controls?.active_run?.status ?? null)
  ).length;

  const currentIsLoading = isLoading;
  const currentError = error;

  const taskCount = countHierarchyTasks(hierarchy);

  return (
    <div className="flex min-h-0 flex-1">
      {/* Main content area */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Title + filters bar */}
        <div className="relative flex h-12 items-center gap-4 border-b border-border bg-bg-primary px-6">
          <div className="neural-grid pointer-events-none absolute inset-0 opacity-20" />
          <div className="relative flex shrink-0 items-center gap-3">
            <h1 className="text-sm font-semibold text-text-primary">Tasks</h1>
            {activeCount > 0 && (
              <div className="flex items-center gap-1.5 rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-warning opacity-75" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-warning" />
                </span>
                <span className="text-xs font-medium text-warning">
                  {activeCount} active
                </span>
              </div>
            )}
          </div>
          <div className="relative flex flex-1 items-center">
            <TaskFilters
              filters={filters}
              onFiltersChange={handleFiltersChange}
              allExpanded={allExpanded}
              onToggleExpandAll={handleToggleExpandAll}
              expandAllDisabled={expandableIds.length === 0}
            />
          </div>
        </div>

        {/* Task tree section */}
        <div className="flex-1 overflow-auto bg-bg-secondary">
          <TaskTreeView
            hierarchy={hierarchy}
            isLoading={isLoading && tasks.length === 0}
            error={error}
            selectedTaskId={selectedTaskId}
            onTaskSelect={handleTaskSelect}
            expandedNodes={expandedNodes}
          />
        </div>

        {/* Footer with task count */}
        {!currentIsLoading && !currentError && taskCount > 0 && (
          <div className="flex items-center justify-between border-t border-border bg-bg-primary px-6 py-2">
            <p className="font-mono text-xs text-text-muted">
              {taskCount} task{taskCount !== 1 ? "s" : ""}
              {hierarchy.length > 0 && (
                <span className="ml-2 text-text-muted/70">
                  ({hierarchy.length} root{hierarchy.length !== 1 ? "s" : ""})
                </span>
              )}
            </p>
            {selectedTaskId && (
              <p className="flex items-center gap-1 font-mono text-xs text-text-muted">
                Selected:{" "}
                <IdentityBadge
                  id={selectedTaskId}
                  kind="task"
                  className="text-primary"
                  testId="tasks-page-selected-task-id"
                />
              </p>
            )}
          </div>
        )}
      </div>

      {/* Task detail side panel */}
      <TaskDetailPanel
        taskId={selectedTaskId}
        onClose={handleClosePanel}
        onTaskSelect={handleRelatedTaskSelect}
        onDetach={handleDetachPanel}
      />
    </div>
  );
}

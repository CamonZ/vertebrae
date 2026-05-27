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

  // Surface live/count/selection state in the shell header actions slot,
  // mirroring how OperationsPage passes pill badges as the 2nd useShellHeader
  // arg. This removes the redundant in-page title bar + footer.
  const headerActions = useMemo(
    () => (
      <div className="flex items-center gap-2 text-xs">
        {activeCount > 0 && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-ok-wash)] px-2.5 py-0.5 font-medium text-[var(--color-ok)]">
            <span className="relative inline-flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--color-ok)] opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--color-ok)]" />
            </span>
            {activeCount} active
          </span>
        )}
        {!currentIsLoading && !currentError && taskCount > 0 && (
          <span className="rounded-full bg-[var(--color-bg-2)] px-2.5 py-0.5 font-mono font-medium text-[var(--color-fg-mute)]">
            {taskCount} task{taskCount !== 1 ? "s" : ""}
            {hierarchy.length > 0 && (
              <span className="ml-1.5 text-[var(--color-fg-faint)]">
                ({hierarchy.length} root{hierarchy.length !== 1 ? "s" : ""})
              </span>
            )}
          </span>
        )}
        {selectedTaskId && (
          <span className="inline-flex items-center gap-1 font-mono text-[var(--color-fg-mute)]">
            Selected{" "}
            <IdentityBadge
              id={selectedTaskId}
              kind="task"
              className="text-[var(--color-accent)]"
              testId="tasks-page-selected-task-id"
            />
          </span>
        )}
      </div>
    ),
    [
      activeCount,
      currentIsLoading,
      currentError,
      taskCount,
      hierarchy.length,
      selectedTaskId,
    ],
  );

  useShellHeader("Tasks", headerActions);

  return (
    <div className="flex min-h-0 flex-1">
      {/* Main content area */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Visually-hidden heading: the visible page title lives in the shell
            header via useShellHeader above. We keep an in-page <h1> so screen
            readers and route/page-isolation tests see a stable heading even
            when the AppShell wrapper isn't mounted in a test environment. */}
        <h1 className="sr-only">Tasks</h1>
        <div className="flex flex-1 flex-col overflow-hidden bg-[var(--color-bg)]">
          {/* Filters live at the top of the content area, on the Hearth
              FilterBar molecule. */}
          <div className="border-b border-[var(--color-line)] px-6 py-3">
            <TaskFilters
              filters={filters}
              onFiltersChange={handleFiltersChange}
              allExpanded={allExpanded}
              onToggleExpandAll={handleToggleExpandAll}
              expandAllDisabled={expandableIds.length === 0}
            />
          </div>

          {/* Task tree section */}
          <div className="flex-1 overflow-auto">
            <TaskTreeView
              hierarchy={hierarchy}
              isLoading={isLoading && tasks.length === 0}
              error={error}
              selectedTaskId={selectedTaskId}
              onTaskSelect={handleTaskSelect}
              expandedNodes={expandedNodes}
            />
          </div>
        </div>
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

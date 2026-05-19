import { useState, useCallback, useMemo } from "react";
import type { Task, Step, TaskLevel } from "../../bindings";
import { commands } from "../../bindings";
import { TaskTreeView, ExpandCollapseAllButton } from "../TaskList";
import { buildTreeFromTasks, collectExpandableIds } from "../../utils/buildTreeFromTasks";
import { useExpandedNodes } from "../../hooks/useExpandedNodes";
import { ResizablePanel } from "../ResizablePanel";
import type { TaskTreeNode } from "../../types/ui";
import { isActiveRunStatus } from "../../utils/runState";
import { IdentityBadge } from "../shared/EntityId";

interface FilteredTasksPanelProps {
  step: Step | null;
  tasks: Task[];
  workflowId: string;
  onClose?: () => void;
  onTaskSelect?: (taskId: string) => void;
  selectedTaskId?: string | null;
}

/**
 * Inline form for creating a new task
 */
function CreateTaskForm({
  workflowId,
  onCancel,
  onCreated,
}: {
  workflowId: string;
  onCancel: () => void;
  onCreated: (taskId: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [level, setLevel] = useState<TaskLevel>("task");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    setIsSubmitting(true);
    setError(null);

    try {
      // Create the task
      const createResult = await commands.createTask(
        title.trim(),
        description.trim() || null,
        level,
        null // no parent
      );

      if (createResult.status === "error") {
        setError(createResult.error.message);
        setIsSubmitting(false);
        return;
      }

      const taskId = createResult.data;

      // Assign workflow to the task
      const assignResult = await commands.assignWorkflow(taskId, workflowId);
      if (assignResult.status === "error") {
        setError(`Task created but workflow assignment failed: ${assignResult.error.message}`);
        setIsSubmitting(false);
        return;
      }

      onCreated(taskId);
    } catch (err) {
      setError(String(err));
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="border-b border-border px-3 py-3 bg-bg-secondary/50">
      <div className="space-y-2">
        {/* Title input */}
        <input
          type="text"
          placeholder="Task title..."
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-xs text-text-primary placeholder:text-text-muted transition-all focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          autoFocus
          disabled={isSubmitting}
        />

        {/* Description input */}
        <textarea
          placeholder="Description (optional)..."
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-xs text-text-primary placeholder:text-text-muted transition-all focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 resize-none"
          disabled={isSubmitting}
        />

        {/* Level select */}
        <div className="flex items-center gap-2">
          <label className="text-xs text-text-muted">Level:</label>
          <select
            value={level}
            onChange={(e) => setLevel(e.target.value as TaskLevel)}
            className="rounded-lg border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary transition-all focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            disabled={isSubmitting}
          >
            <option value="task">Task</option>
            <option value="ticket">Ticket</option>
            <option value="epic">Epic</option>
          </select>
        </div>

        {/* Error message */}
        {error && (
          <p className="text-xs text-error">{error}</p>
        )}

        {/* Action buttons */}
        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-3 py-1 text-xs font-medium text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
            disabled={isSubmitting}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="rounded-lg bg-primary px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-primary/90 disabled:opacity-50"
            disabled={isSubmitting || !title.trim()}
          >
            {isSubmitting ? "Creating..." : "Create"}
          </button>
        </div>
      </div>
    </form>
  );
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
  const [showCreateForm, setShowCreateForm] = useState(false);

  // Use expanded nodes hook to preserve tree collapse state
  const expandedNodes = useExpandedNodes();

  // Build tree locally from tasks prop (no API call needed)
  const hierarchy = useMemo(() => {
    const filtered = search
      ? tasks.filter(
          (t) =>
            t.title.toLowerCase().includes(search.toLowerCase()) ||
            t.id.toLowerCase().includes(search.toLowerCase())
        )
      : tasks;
    return buildTreeFromTasks(filtered);
  }, [tasks, search]);

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

  const handleTaskCreated = useCallback(
    (taskId: string) => {
      setShowCreateForm(false);
      // Select the newly created task
      onTaskSelect?.(taskId);
    },
    [onTaskSelect]
  );

  if (!step) {
    return null;
  }

  const activeCount = tasks.filter((t) =>
    isActiveRunStatus(t.run_controls?.active_run?.status ?? null)
  ).length;

  const totalTasks = hierarchy.reduce(
    (count, node) => count + countHierarchyTasks(node),
    0
  );

  return (
    <ResizablePanel
      storageKey="filtered-tasks-panel-width"
      glowColor="from-primary/0 via-primary/30 to-primary/0"
    >
      {/* Header with step info */}
      <div className="flex h-12 items-center justify-between border-b border-border px-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-lg border border-primary/30 bg-primary/10 font-mono text-xs font-bold text-primary">
              {(step.order ?? 0) + 1}
            </span>
            <h2 className="truncate font-mono text-[10px] font-medium uppercase tracking-wider text-text-muted">
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
        <div className="flex items-center gap-1 flex-shrink-0">
          {/* Add task button */}
          <button
            type="button"
            onClick={() => setShowCreateForm(true)}
            className="cursor-pointer rounded-lg p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-success focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label="Create task"
            title="Create new task"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M12 4v16m8-8H4"
              />
            </svg>
          </button>
          {/* Close button */}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="cursor-pointer rounded-lg p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
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
      </div>

      {/* Create task form */}
      {showCreateForm && (
        <CreateTaskForm
          workflowId={workflowId}
          onCancel={() => setShowCreateForm(false)}
          onCreated={handleTaskCreated}
        />
      )}

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

          <ExpandCollapseAllButton
            allExpanded={allExpanded}
            onToggle={handleToggleExpandAll}
            disabled={expandableIds.length === 0}
          />
        </div>
      </div>

      {/* Task tree section */}
      <div className="flex-1 overflow-auto">
        <TaskTreeView
          hierarchy={hierarchy}
          isLoading={false}
          error={null}
          selectedTaskId={selectedTaskId}
          onTaskSelect={(task) => onTaskSelect?.(task.id)}
          expandedNodes={expandedNodes}
          hideStatus
        />
      </div>

      {/* Footer with task count */}
      {totalTasks > 0 && (
        <div className="flex items-center justify-between border-t border-border bg-bg-secondary/50 px-3 py-2">
          <p className="font-mono text-xs text-text-muted">
            {totalTasks} task{totalTasks !== 1 ? "s" : ""}
          </p>
          {selectedTaskId && (
            <p className="flex items-center gap-1 font-mono text-xs text-text-muted">
              Selected:{" "}
              <IdentityBadge
                id={selectedTaskId}
                kind="task"
                className="text-primary"
                testId="filtered-tasks-selected-task-id"
              />
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
function countHierarchyTasks(node: TaskTreeNode): number {
  return 1 + node.children.reduce((count: number, child: TaskTreeNode) => count + countHierarchyTasks(child), 0);
}

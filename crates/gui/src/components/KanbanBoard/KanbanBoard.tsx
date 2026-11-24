import { useState, useCallback, useMemo } from "react";
import type {
  Task,
  TaskLevel,
  TaskFilterOptions,
} from "../../bindings";
import { useTasks } from "../../hooks/useTasks";
import { useWorkflows } from "../../hooks/useWorkflows";
import { useWorkflowTransitions } from "../../hooks/useWorkflowTransitions";
import { KanbanColumn } from "./KanbanColumn";
import { topologicalColumnSort } from "./columnOrder";

export { topologicalColumnSort };
import {
  filterByFactory,
  type FactoryFilterValue,
} from "../../utils/workflowFactory";
import { PaletteSearchButton } from "../molecules/PaletteSearchButton";
import { Dropdown } from "../molecules/Dropdown";
import { useEntityPanelStore } from "../../stores/entityPanelStore";

const UNASSIGNED_COLUMN = "Unassigned";

const LEVEL_SELECT_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "All levels" },
  { value: "epic", label: "Epics only" },
  { value: "ticket", label: "Tickets" },
  { value: "task", label: "Tasks" },
];

const TASK_FILTER: TaskFilterOptions = {
  step_names: null,
  levels: null,
  tags: null,
  root_only: null,
  children_of: null,
  search: null,
  workflow_id: null,
  step_id: null,
};

/** A concrete factory scope: a factory name or the synthetic No Factory scope. */
export type KanbanFactoryScope = Exclude<FactoryFilterValue, null>;

interface KanbanBoardProps {
  /** The factory whose workflows define the board's columns and tasks. */
  factoryName: KanbanFactoryScope;
}

/**
 * Kanban board for one factory. Columns come from the factory's workflow
 * `kanban_column` values, ordered by the transitions between them; a board only
 * reads coherently within one factory, so the Workflow Atlas renders it as a
 * factory-scoped view and owns the factory selection.
 */
export function KanbanBoard({ factoryName }: KanbanBoardProps) {
  const openTask = useEntityPanelStore((state) => state.openTask);
  const selectedTaskId = useEntityPanelStore((state) =>
    state.selection?.type === "task" ? state.selection.taskId : null
  );
  const [levelFilter, setLevelFilter] = useState<TaskLevel | "">("");

  const {
    tasks,
    isLoading: tasksLoading,
    error: tasksError,
  } = useTasks(TASK_FILTER);
  const {
    workflows,
    isLoading: workflowsLoading,
    error: workflowsError,
  } = useWorkflows();
  const { transitions } = useWorkflowTransitions();

  // A factory is a literal workflow field, so the selected workflow set is
  // the source of truth for both board columns and task membership.
  const scopedWorkflows = useMemo(
    () => filterByFactory(workflows, factoryName),
    [workflows, factoryName]
  );
  const scopedWorkflowIds = useMemo(
    () =>
      new Set(scopedWorkflows.map((workflow) => workflow.id).filter(Boolean)),
    [scopedWorkflows]
  );
  const scopedTransitions = useMemo(
    () =>
      transitions.filter(
        (transition) =>
          scopedWorkflowIds.has(transition.from_workflow_id) &&
          scopedWorkflowIds.has(transition.to_workflow_id)
      ),
    [transitions, scopedWorkflowIds]
  );

  const handleTaskSelect = useCallback(
    (task: Task) => {
      openTask(task.id);
    },
    [openTask]
  );

  const handleLevelChange = (value: string) => {
    setLevelFilter(value as TaskLevel | "");
  };

  const handleClearFilters = () => {
    setLevelFilter("");
  };

  // Build a map from workflow_id to kanban_column, and collect all known columns
  const { workflowColumnMap, allKanbanColumns } = useMemo(() => {
    const map = new Map<string, string>();
    const columnSet = new Set<string>();
    for (const wf of scopedWorkflows) {
      if (wf.id && wf.kanban_column) {
        map.set(wf.id, wf.kanban_column);
        columnSet.add(wf.kanban_column);
      }
    }
    return { workflowColumnMap: map, allKanbanColumns: columnSet };
  }, [scopedWorkflows]);

  // Topologically sort columns using workflow transitions
  const sortedColumns = useMemo(
    () =>
      topologicalColumnSort(
        allKanbanColumns,
        scopedTransitions,
        workflowColumnMap
      ),
    [allKanbanColumns, scopedTransitions, workflowColumnMap]
  );

  // Keep the factory's tasks, filter by level, then group by
  // kanban_column
  const { columns, columnOrder, totalFiltered } = useMemo(() => {
    let filtered = tasks.filter(
      (task) =>
        task.workflow_id !== null && scopedWorkflowIds.has(task.workflow_id)
    );

    if (levelFilter) {
      filtered = filtered.filter((t) => t.level === levelFilter);
    }

    // Seed with all known columns so empty ones still appear
    const grouped = new Map<string, Task[]>();
    for (const col of allKanbanColumns) {
      grouped.set(col, []);
    }

    let hasUnassigned = false;
    for (const task of filtered) {
      const column =
        (task.workflow_id && workflowColumnMap.get(task.workflow_id)) ??
        UNASSIGNED_COLUMN;

      if (column === UNASSIGNED_COLUMN) hasUnassigned = true;

      const existing = grouped.get(column);
      if (existing) {
        existing.push(task);
      } else {
        grouped.set(column, [task]);
      }
    }

    // Only show Unassigned column if there are tasks in it
    if (!hasUnassigned) {
      grouped.delete(UNASSIGNED_COLUMN);
    }

    // Use transition-based order, then append Unassigned at the end
    const order = sortedColumns.filter((col) => grouped.has(col));
    if (hasUnassigned) {
      order.push(UNASSIGNED_COLUMN);
    }

    return {
      columns: grouped,
      columnOrder: order,
      totalFiltered: filtered.length,
    };
  }, [
    tasks,
    scopedWorkflowIds,
    levelFilter,
    workflowColumnMap,
    allKanbanColumns,
    sortedColumns,
  ]);

  const isLoading = tasksLoading || workflowsLoading;
  const error = tasksError || workflowsError;
  const hasActiveFilters = levelFilter !== "";

  return (
    <div className="flex min-h-0 flex-1" data-testid="kanban-board">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Filters bar. The factory scope comes from the Atlas header. */}
        <div className="relative flex h-12 items-center gap-4 border-b border-border bg-bg px-6">
          <div className="relative flex flex-1 items-center gap-3">
            {/* Finding a task goes through the ⌘K palette. */}
            <PaletteSearchButton
              label="Search tasks"
              className="min-w-48 flex-1"
              data-testid="board-task-search-button"
            />

            {/* Level filter — same Select atom + scope-level chip styling as
                the Tasks page. */}
            <div className="scope-level">
              <Dropdown
                id="board-level-filter"
                options={LEVEL_SELECT_OPTIONS}
                value={levelFilter}
                onChange={handleLevelChange}
                aria-label="Filter by level"
              />
            </div>

            {/* Clear filters */}
            {hasActiveFilters && (
              <button
                type="button"
                onClick={handleClearFilters}
                className="flex items-center gap-1.5 rounded-lg border border-border bg-bg-2/50 px-3 py-1.5 text-secondary text-fg-mute transition-all hover:border-err/30 hover:bg-err/10 hover:text-err"
              >
                <svg
                  className="h-3.5 w-3.5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
                Clear
              </button>
            )}

            {totalFiltered > 0 && (
              <span
                className="text-meta text-[var(--color-fg-mute)]"
                data-testid="board-task-count"
              >
                <b className="font-semibold text-[var(--color-fg)]">
                  {totalFiltered}
                </b>{" "}
                task{totalFiltered !== 1 ? "s" : ""}
              </span>
            )}
          </div>
        </div>

        {/* Board content */}
        <div className="flex-1 overflow-x-auto overflow-y-hidden bg-bg p-4">
          {isLoading ? (
            <div className="flex h-full items-center justify-center">
              <div className="text-center">
                <div className="mx-auto mb-3 h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                <p className="text-content text-fg-mute">Loading board...</p>
              </div>
            </div>
          ) : error ? (
            <div className="flex h-full items-center justify-center">
              <div className="text-center">
                <p className="text-content text-err">{error}</p>
              </div>
            </div>
          ) : columnOrder.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <div className="text-center">
                <svg
                  className="mx-auto mb-4 h-12 w-12 text-fg-mute"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2"
                  />
                </svg>
                <p className="text-content text-fg-mute">
                  No tasks with kanban columns assigned
                </p>
                <p className="mt-1 text-secondary text-fg-mute">
                  Assign workflows with kanban columns to see tasks on the board
                </p>
              </div>
            </div>
          ) : (
            <div className="flex h-full gap-4">
              {columnOrder.map((columnName) => (
                <KanbanColumn
                  key={columnName}
                  columnName={columnName}
                  tasks={columns.get(columnName) ?? []}
                  selectedTaskId={selectedTaskId}
                  onTaskSelect={handleTaskSelect}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

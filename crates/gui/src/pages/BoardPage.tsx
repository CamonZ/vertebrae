import type { ChangeEvent } from "react";
import { useState, useCallback, useMemo } from "react";
import type { Task, TaskLevel, TaskFilterOptions, WorkflowTransition } from "../bindings";
import { useTasks } from "../hooks/useTasks";
import { useWorkflows } from "../hooks/useWorkflows";
import { useWorkflowTransitions } from "../hooks/useWorkflowTransitions";
import { TaskDetailPanel } from "../components/TaskDetail";
import { KanbanColumn } from "../components/KanbanBoard/KanbanColumn";
import { popOut, stashTask } from "../utils";

const UNASSIGNED_COLUMN = "Unassigned";

/**
 * Topologically sort kanban columns based on workflow transitions.
 *
 * Builds a DAG of column-level edges from workflow transitions,
 * dropping edges that would create cycles (e.g. rework transitions).
 * Terminal columns (no outgoing edges) are placed last.
 * Kahn's algorithm produces left-to-right order.
 */
export function topologicalColumnSort(
  allColumns: Set<string>,
  transitions: WorkflowTransition[],
  workflowColumnMap: Map<string, string>,
): string[] {
  if (allColumns.size === 0) return [];

  // Collect all candidate column-level edges
  const candidateEdges: [string, string][] = [];
  for (const t of transitions) {
    const fromCol = workflowColumnMap.get(t.from_workflow_id);
    const toCol = workflowColumnMap.get(t.to_workflow_id);
    if (!fromCol || !toCol || fromCol === toCol) continue;
    if (!allColumns.has(fromCol) || !allColumns.has(toCol)) continue;
    candidateEdges.push([fromCol, toCol]);
  }

  // Build adjacency, skipping edges that would create a cycle
  const edges = new Map<string, Set<string>>();
  for (const col of allColumns) {
    edges.set(col, new Set());
  }

  for (const [from, to] of candidateEdges) {
    if (edges.get(from)!.has(to)) continue; // already added
    edges.get(from)!.add(to);
    if (hasCycle(allColumns, edges)) {
      edges.get(from)!.delete(to); // revert — this edge creates a cycle
    }
  }

  // Compute in-degree from the acyclic graph
  const inDegree = new Map<string, number>();
  for (const col of allColumns) {
    inDegree.set(col, 0);
  }
  for (const [, neighbors] of edges) {
    for (const neighbor of neighbors) {
      inDegree.set(neighbor, (inDegree.get(neighbor) ?? 0) + 1);
    }
  }

  // Identify terminal columns (no outgoing edges in the DAG)
  const terminal = new Set<string>();
  for (const col of allColumns) {
    if (edges.get(col)!.size === 0) {
      terminal.add(col);
    }
  }

  // Kahn's algorithm — break ties alphabetically, but defer terminal columns
  const queue: string[] = [];
  for (const [col, deg] of inDegree) {
    if (deg === 0) queue.push(col);
  }
  queue.sort(compareWithTerminalLast(terminal));

  const sorted: string[] = [];
  while (queue.length > 0) {
    const col = queue.shift()!;
    sorted.push(col);
    for (const neighbor of edges.get(col) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) {
        const cmp = compareWithTerminalLast(terminal);
        const idx = queue.findIndex((q) => cmp(q, neighbor) > 0);
        if (idx === -1) queue.push(neighbor);
        else queue.splice(idx, 0, neighbor);
      }
    }
  }

  return sorted;
}

/** Returns a comparator that sorts terminal columns after non-terminal, with alphabetical tiebreaking. */
function compareWithTerminalLast(terminal: Set<string>) {
  return (a: string, b: string) => {
    const aTerminal = terminal.has(a);
    const bTerminal = terminal.has(b);
    if (aTerminal !== bTerminal) return aTerminal ? 1 : -1;
    return a.localeCompare(b);
  };
}

/** DFS cycle detection on column-level adjacency. */
function hasCycle(nodes: Set<string>, edges: Map<string, Set<string>>): boolean {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const n of nodes) color.set(n, WHITE);

  for (const n of nodes) {
    if (color.get(n) === WHITE && dfs(n)) return true;
  }
  return false;

  function dfs(node: string): boolean {
    color.set(node, GRAY);
    for (const neighbor of edges.get(node) ?? []) {
      const c = color.get(neighbor);
      if (c === GRAY) return true;
      if (c === WHITE && dfs(neighbor)) return true;
    }
    color.set(node, BLACK);
    return false;
  }
}

const LEVEL_OPTIONS: { value: TaskLevel; label: string }[] = [
  { value: "epic", label: "Epic" },
  { value: "ticket", label: "Ticket" },
  { value: "task", label: "Task" },
];

const TASK_FILTER: TaskFilterOptions = {
  step_names: null,
  levels: null,
  tags: null,
  root_only: null,
  children_of: null,
  include_done: true,
  search: null,
  workflow_id: null,
  step_id: null,
};

export function BoardPage() {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [levelFilter, setLevelFilter] = useState<TaskLevel | "">("");
  const [search, setSearch] = useState("");

  const { tasks, isLoading: tasksLoading, error: tasksError } = useTasks(TASK_FILTER);
  const { workflows, isLoading: workflowsLoading, error: workflowsError } = useWorkflows();
  const { transitions } = useWorkflowTransitions();

  const handleTaskSelect = useCallback((task: Task) => {
    setSelectedTaskId(task.id);
  }, []);

  const handleClosePanel = useCallback(() => {
    setSelectedTaskId(null);
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

  const handleLevelChange = (event: ChangeEvent<HTMLSelectElement>) => {
    setLevelFilter(event.target.value as TaskLevel | "");
  };

  const handleSearchChange = (event: ChangeEvent<HTMLInputElement>) => {
    setSearch(event.target.value);
  };

  const handleClearFilters = () => {
    setLevelFilter("");
    setSearch("");
  };

  // Build a map from workflow_id to kanban_column, and collect all known columns
  const { workflowColumnMap, allKanbanColumns } = useMemo(() => {
    const map = new Map<string, string>();
    const columnSet = new Set<string>();
    for (const wf of workflows) {
      if (wf.id && wf.kanban_column) {
        map.set(wf.id, wf.kanban_column);
        columnSet.add(wf.kanban_column);
      }
    }
    return { workflowColumnMap: map, allKanbanColumns: columnSet };
  }, [workflows]);

  // Topologically sort columns using workflow transitions
  const sortedColumns = useMemo(
    () => topologicalColumnSort(allKanbanColumns, transitions, workflowColumnMap),
    [allKanbanColumns, transitions, workflowColumnMap],
  );

  // Filter tasks by level and search, then group by kanban_column
  const { columns, columnOrder, totalFiltered } = useMemo(() => {
    let filtered = tasks;

    if (levelFilter) {
      filtered = filtered.filter((t) => t.level === levelFilter);
    }

    if (search) {
      const lowerSearch = search.toLowerCase();
      filtered = filtered.filter((t) =>
        t.title.toLowerCase().includes(lowerSearch)
      );
    }

    // Seed with all known columns so empty ones still appear
    const grouped = new Map<string, Task[]>();
    for (const col of allKanbanColumns) {
      grouped.set(col, []);
    }

    let hasUnassigned = false;
    for (const task of filtered) {
      const column = (task.workflow_id && workflowColumnMap.get(task.workflow_id)) ?? UNASSIGNED_COLUMN;

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

    return { columns: grouped, columnOrder: order, totalFiltered: filtered.length };
  }, [tasks, levelFilter, search, workflowColumnMap, allKanbanColumns, sortedColumns]);

  const isLoading = tasksLoading || workflowsLoading;
  const error = tasksError || workflowsError;
  const hasActiveFilters = levelFilter !== "" || search !== "";

  return (
    <div className="flex min-h-0 flex-1">
      {/* Main board area */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header section */}
        <div className="relative border-b border-border bg-bg-primary px-6 py-4">
          <div className="neural-grid pointer-events-none absolute inset-0 opacity-20" />

          <div className="relative mb-4 flex items-center gap-4">
            <h1 className="text-lg font-semibold text-text-primary">Board</h1>
            {totalFiltered > 0 && (
              <span className="font-mono text-xs text-text-muted">
                {totalFiltered} task{totalFiltered !== 1 ? "s" : ""}
              </span>
            )}
          </div>

          {/* Filter bar */}
          <div className="relative flex flex-wrap items-center gap-3">
            {/* Search input */}
            <div className="relative min-w-48 flex-1">
              <input
                type="text"
                placeholder="Search tasks..."
                value={search}
                onChange={handleSearchChange}
                className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 pl-9 text-sm text-text-primary placeholder:text-text-muted transition-all focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                aria-label="Search tasks by title"
              />
              <svg
                className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted"
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

            {/* Level filter */}
            <div className="flex items-center gap-2 rounded-lg border border-border bg-bg-tertiary/50 p-1">
              <div className="flex items-center">
                <label
                  htmlFor="board-level-filter"
                  className="px-2 font-mono text-[10px] uppercase tracking-wider text-text-muted"
                >
                  Level
                </label>
                <select
                  id="board-level-filter"
                  value={levelFilter}
                  onChange={handleLevelChange}
                  className="rounded-md border-0 bg-transparent px-2 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                >
                  <option value="">All</option>
                  {LEVEL_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Clear filters */}
            {hasActiveFilters && (
              <button
                type="button"
                onClick={handleClearFilters}
                className="flex items-center gap-1.5 rounded-lg border border-border bg-bg-tertiary/50 px-3 py-1.5 text-xs text-text-muted transition-all hover:border-error/30 hover:bg-error/10 hover:text-error focus:outline-none focus:ring-2 focus:ring-error/20"
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
          </div>
        </div>

        {/* Board content */}
        <div className="flex-1 overflow-auto bg-bg-primary p-4">
          {isLoading ? (
            <div className="flex h-full items-center justify-center">
              <div className="text-center">
                <div className="mx-auto mb-3 h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                <p className="text-sm text-text-muted">Loading board...</p>
              </div>
            </div>
          ) : error ? (
            <div className="flex h-full items-center justify-center">
              <div className="text-center">
                <p className="text-sm text-error">{error}</p>
              </div>
            </div>
          ) : columnOrder.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <div className="text-center">
                <svg
                  className="mx-auto mb-4 h-12 w-12 text-text-muted"
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
                <p className="text-sm text-text-muted">
                  No tasks with kanban columns assigned
                </p>
                <p className="mt-1 text-xs text-text-muted">
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

      {/* Task detail side panel */}
      <TaskDetailPanel
        taskId={selectedTaskId}
        onClose={handleClosePanel}
        onTaskSelect={setSelectedTaskId}
        onDetach={handleDetachPanel}
      />
    </div>
  );
}

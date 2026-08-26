import type { ChangeEvent } from "react";
import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import type {
  Task,
  TaskLevel,
  TaskFilterOptions,
  WorkflowTransition,
} from "../bindings";
import { useTasks } from "../hooks/useTasks";
import { useWorkflows } from "../hooks/useWorkflows";
import { useWorkflowTransitions } from "../hooks/useWorkflowTransitions";
import { useShellHeader } from "../hooks/useShellHeader";
import { KanbanColumn } from "../components/KanbanBoard/KanbanColumn";
import { FactoryFilter } from "../components/FactoryFilter";
import {
  factoryNames,
  filterByFactory,
  type FactoryFilterValue,
} from "../utils/workflowFactory";
import { SearchInput } from "../components/molecules/SearchInput";
import { Select } from "../components/atoms/Select";
import { useEntityPanelStore } from "../stores/entityPanelStore";

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
  workflowColumnMap: Map<string, string>
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
function hasCycle(
  nodes: Set<string>,
  edges: Map<string, Set<string>>
): boolean {
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
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

function matchesTaskSearch(task: Task, normalizedSearch: string): boolean {
  if (!normalizedSearch) return true;

  const taskId = task.id.toLowerCase();
  return (
    task.title.toLowerCase().includes(normalizedSearch) ||
    task.description?.toLowerCase().includes(normalizedSearch) ||
    taskId === normalizedSearch ||
    taskId.slice(0, 8) === normalizedSearch
  );
}

export function BoardPage() {
  const openTask = useEntityPanelStore((state) => state.openTask);
  const selectedTaskId = useEntityPanelStore((state) =>
    state.selection?.type === "task" ? state.selection.taskId : null
  );
  const [levelFilter, setLevelFilter] = useState<TaskLevel | "">("");
  const [factoryFilter, setFactoryFilter] = useState<FactoryFilterValue>(null);
  const [search, setSearch] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Focus the search box on "/" (unless already typing in a field), and clear
  // it on Escape — mirrors the canonical board keyboard affordances.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if (event.key === "/" && !typing) {
        event.preventDefault();
        searchInputRef.current?.focus();
      } else if (event.key === "Escape" && target === searchInputRef.current) {
        searchInputRef.current?.blur();
        setSearch("");
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

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
    () =>
      factoryFilter === null
        ? workflows
        : filterByFactory(workflows, factoryFilter),
    [workflows, factoryFilter]
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

  // If a realtime update removes the selected factory from the project, return
  // to the unscoped board instead of leaving a value with no option.
  useEffect(() => {
    if (
      factoryFilter !== null &&
      !factoryNames(workflows).includes(factoryFilter)
    ) {
      setFactoryFilter(null);
    }
  }, [factoryFilter, workflows]);

  const handleTaskSelect = useCallback(
    (task: Task) => {
      openTask(task.id);
    },
    [openTask]
  );

  const handleLevelChange = (event: ChangeEvent<HTMLSelectElement>) => {
    setLevelFilter(event.target.value as TaskLevel | "");
  };

  const handleSearchChange = (value: string) => {
    setSearch(value);
  };

  const handleClearFilters = () => {
    setLevelFilter("");
    setFactoryFilter(null);
    setSearch("");
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

  // Filter tasks by level and search, then group by kanban_column
  const { columns, columnOrder, totalFiltered } = useMemo(() => {
    let filtered = tasks;

    if (factoryFilter !== null) {
      filtered = filtered.filter(
        (task) =>
          task.workflow_id !== null && scopedWorkflowIds.has(task.workflow_id)
      );
    }

    if (levelFilter) {
      filtered = filtered.filter((t) => t.level === levelFilter);
    }

    const normalizedSearch = search.trim().toLowerCase();
    if (normalizedSearch) {
      filtered = filtered.filter((t) => matchesTaskSearch(t, normalizedSearch));
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
    factoryFilter,
    scopedWorkflowIds,
    levelFilter,
    search,
    workflowColumnMap,
    allKanbanColumns,
    sortedColumns,
  ]);

  const isLoading = tasksLoading || workflowsLoading;
  const error = tasksError || workflowsError;
  const hasActiveFilters =
    levelFilter !== "" || factoryFilter !== null || search !== "";

  const headerActions = useMemo(
    () =>
      totalFiltered > 0 ? (
        <div className="flex items-center gap-3 text-eyebrow">
          <span className="text-[var(--color-fg-mute)]">
            <b className="font-semibold text-[var(--color-fg)]">
              {totalFiltered}
            </b>{" "}
            task{totalFiltered !== 1 ? "s" : ""}
          </span>
        </div>
      ) : null,
    [totalFiltered]
  );

  useShellHeader("Board", headerActions);

  return (
    <div className="flex min-h-0 flex-1">
      {/* Main board area */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Visually-hidden heading: the visible page title lives in the shell
            header via useShellHeader above. We keep an in-page <h1> so screen
            readers and route/page-isolation tests see a stable heading even
            when the AppShell wrapper isn't mounted in a test environment. */}
        <h1 className="sr-only">Board</h1>
        {/* Title + filters bar */}
        <div className="relative flex h-12 items-center gap-4 border-b border-border bg-bg px-6">
          <div className="neural-grid pointer-events-none absolute inset-0 opacity-20" />

          <div className="relative flex flex-1 items-center gap-3">
            {/* Search input */}
            <div className="min-w-48 flex-1">
              <SearchInput
                ref={searchInputRef}
                value={search}
                onChange={handleSearchChange}
                debounceMs={0}
                hint="/"
                placeholder="Search tasks by title, id, or tag…"
                aria-label="Search tasks by title or ID"
                data-testid="board-task-search-input"
              />
            </div>

            {/* Level filter — same Select atom + scope-level chip styling as
                the Tasks page. */}
            <div className="scope-level">
              <Select
                id="board-level-filter"
                options={LEVEL_SELECT_OPTIONS}
                value={levelFilter}
                onChange={handleLevelChange}
                aria-label="Filter by level"
              />
            </div>

            <div className="scope-factory">
              <FactoryFilter
                id="board-factory-filter"
                workflows={workflows}
                value={factoryFilter}
                onChange={setFactoryFilter}
              />
            </div>

            {/* Clear filters */}
            {hasActiveFilters && (
              <button
                type="button"
                onClick={handleClearFilters}
                className="flex items-center gap-1.5 rounded-lg border border-border bg-bg-2/50 px-3 py-1.5 text-xs text-fg-mute transition-all hover:border-err/30 hover:bg-err/10 hover:text-err focus:outline-none focus:ring-2 focus:ring-err/20"
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
        <div className="flex-1 overflow-x-auto overflow-y-hidden bg-bg p-4">
          {isLoading ? (
            <div className="flex h-full items-center justify-center">
              <div className="text-center">
                <div className="mx-auto mb-3 h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                <p className="text-sm text-fg-mute">Loading board...</p>
              </div>
            </div>
          ) : error ? (
            <div className="flex h-full items-center justify-center">
              <div className="text-center">
                <p className="text-sm text-err">{error}</p>
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
                <p className="text-sm text-fg-mute">
                  No tasks with kanban columns assigned
                </p>
                <p className="mt-1 text-xs text-fg-mute">
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

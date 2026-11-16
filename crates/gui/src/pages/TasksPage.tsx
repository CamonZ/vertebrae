import {
  useState,
  useCallback,
  useMemo,
  useEffect,
} from "react";
import { useSearchParams } from "react-router-dom";
import type { TaskFilterOptions, Task, TaskLevel } from "../bindings";
import { useTasks } from "../hooks/useTasks";
import { activeRunsFromTasks } from "../hooks/useTaskRuns";
import {
  buildTreeFromTasks,
  collectExpandableIds,
} from "../utils/buildTreeFromTasks";
import { useExpandedNodes } from "../hooks/useExpandedNodes";
import { useShellHeader } from "../hooks/useShellHeader";
import { TaskTreeView } from "../components/TaskList";
import { PaletteSearchButton } from "../components/molecules/PaletteSearchButton";
import { Dropdown } from "../components/molecules/Dropdown";
import { ScopeChip } from "../components/molecules/ScopeChip";
import { LiveCount } from "../components/shared/LiveCount";
import { isActiveRunStatus, isTaskDone } from "../utils/runState";
import { useSummaryExpanded } from "../hooks/useSummaryExpanded";
import { useEntityPanelStore } from "../stores/entityPanelStore";
import { OverflowMenu } from "../components/molecules/OverflowMenu";

type TaskScope =
  | "all"
  | "active"
  | "waiting"
  | "blocked"
  | "recent"
  | "queued"
  | "done";

type TaskScopeCounts = Record<
  "active" | "waiting" | "blocked" | "recent" | "queued" | "done",
  number
>;

interface TaskScopeChipDefinition {
  key: Exclude<TaskScope, "all">;
  label: string;
  countKey?: keyof TaskScopeCounts;
}

/** Status filter: one choice, "All" by default. "Recent" is not a status;
 * it is the "Updated in last 24h" toggle in the View menu and combines with
 * any status. */
const TASK_SCOPE_CHIPS: TaskScopeChipDefinition[] = [
  { key: "active", label: "Active", countKey: "active" },
  { key: "waiting", label: "Waiting", countKey: "waiting" },
  { key: "blocked", label: "Blocked", countKey: "blocked" },
  { key: "queued", label: "Queued", countKey: "queued" },
  { key: "done", label: "Done", countKey: "done" },
];

const COUNTED_TASK_SCOPE_CHIPS = TASK_SCOPE_CHIPS.filter(
  (
    chip
  ): chip is TaskScopeChipDefinition & { countKey: keyof TaskScopeCounts } =>
    Boolean(chip.countKey)
);

const LEVEL_SELECT_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "All levels" },
  { value: "epic", label: "Epics only" },
  { value: "ticket", label: "Tickets" },
  { value: "task", label: "Tasks" },
];

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

function matchesScope(
  task: Task,
  scope: TaskScope,
  activeRuns: ReadonlyMap<string, import("../bindings").TaskRun>
): boolean {
  const status = activeRuns.get(task.id)?.status ?? null;

  switch (scope) {
    case "active":
      return isActiveRunStatus(status);
    case "waiting":
      return status === "waiting";
    case "blocked":
      return task.run_controls?.disabled_reason_code === "blocked";
    case "recent": {
      const updated = task.updated_at
        ? new Date(task.updated_at).getTime()
        : NaN;
      if (!Number.isFinite(updated)) return false;
      return Date.now() - updated <= 24 * 60 * 60 * 1000;
    }
    case "queued":
      return status === "queued";
    case "done":
      return isTaskDone(task, activeRuns.get(task.id));
    default:
      return true;
  }
}

function deriveScopedTasks(
  tasks: Task[],
  scope: TaskScope,
  activeRuns: ReadonlyMap<string, import("../bindings").TaskRun>,
  recentOnly = false
): Task[] {
  if (scope === "all" && !recentOnly) return tasks;

  const byId = new Map(tasks.map((task) => [task.id, task]));
  const include = new Set<string>();

  for (const task of tasks) {
    if (scope !== "all" && !matchesScope(task, scope, activeRuns)) continue;
    if (recentOnly && !matchesScope(task, "recent", activeRuns)) continue;
    include.add(task.id);

    let parentId = task.parent_id;
    while (parentId) {
      const parent = byId.get(parentId);
      if (!parent) break;
      include.add(parent.id);
      parentId = parent.parent_id;
    }
  }

  return tasks.filter((task) => include.has(task.id));
}

function scopeCounts(
  tasks: Task[],
  activeRuns: ReadonlyMap<string, import("../bindings").TaskRun>
) {
  return tasks.reduce(
    (counts, task) => {
      COUNTED_TASK_SCOPE_CHIPS.forEach(({ key, countKey }) => {
        if (matchesScope(task, key, activeRuns)) counts[countKey] += 1;
      });
      return counts;
    },
    { active: 0, waiting: 0, blocked: 0, recent: 0, queued: 0, done: 0 }
  );
}

function containsAllExpandedIds(
  expandedIds: ReadonlySet<string>,
  candidateIds: string[]
): boolean {
  return candidateIds.every((id) => expandedIds.has(id));
}

export function TasksPage() {
  const [searchParams] = useSearchParams();
  const openTask = useEntityPanelStore((state) => state.openTask);
  const selectedTaskId = useEntityPanelStore((state) =>
    state.selection?.type === "task" ? state.selection.taskId : null
  );
  const [filters, setFilters] = useState<TaskFilterOptions>(INITIAL_FILTERS);
  const [scope, setScope] = useState<TaskScope>("all");
  const [hideCompleted, setHideCompleted] = useState(false);
  const [recentOnly, setRecentOnly] = useState(false);

  const expandedNodes = useExpandedNodes();
  const summaryExpanded = useSummaryExpanded();

  useEffect(() => {
    const workflowId = searchParams.get("workflowId");
    if (workflowId) {
      setFilters((prev) =>
        prev.workflow_id === workflowId
          ? prev
          : { ...prev, workflow_id: workflowId }
      );
    }
  }, [searchParams]);

  useEffect(() => {
    const taskId = searchParams.get("taskId")?.trim();
    if (taskId) openTask(taskId);
  }, [openTask, searchParams]);

  const { tasks, isLoading, error } = useTasks(filters);
  const activeRunsByTaskId = useMemo(() => activeRunsFromTasks(tasks), [tasks]);
  const scopedTasks = useMemo(
    () => deriveScopedTasks(tasks, scope, activeRunsByTaskId, recentOnly),
    [activeRunsByTaskId, tasks, scope, recentOnly]
  );
  const counts = useMemo(
    () => scopeCounts(tasks, activeRunsByTaskId),
    [activeRunsByTaskId, tasks]
  );

  // Weak keys retain reusable nodes only while their task snapshots are live.
  const treeCache = useMemo(
    () => new WeakMap<Task, import("../types/ui").TaskTreeNode>(),
    []
  );
  const hierarchy = useMemo(
    () => buildTreeFromTasks(scopedTasks, treeCache),
    [scopedTasks, treeCache]
  );

  // A scope chip (other than "all") narrows the list, in which case hide-done
  // and the done-summary collapse are bypassed so every match stays visible.
  // Finding a specific task goes through the ⌘K palette.
  const filtering = scope !== "all" || recentOnly;

  const handleLevelChange = useCallback(
    (value: string) => {
      const levels = value ? [value as TaskLevel] : null;
      setFilters((prev) => ({ ...prev, levels }));
    },
    []
  );

  const selectedLevel = filters.levels?.[0] ?? "";

  const handleTaskSelect = useCallback(
    (task: Task) => {
      openTask(task.id);
    },
    [openTask]
  );

  const expandableIds = useMemo(
    () => collectExpandableIds(hierarchy),
    [hierarchy]
  );
  const { expandedNodeIds, expandAll } = expandedNodes;
  useEffect(() => {
    if (
      filtering &&
      expandableIds.length > 0 &&
      !containsAllExpandedIds(expandedNodeIds, expandableIds)
    ) {
      expandAll(expandableIds);
    }
  }, [filtering, expandableIds, expandedNodeIds, expandAll]);

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

  const runningCount = counts.active;

  const headerActions = useMemo(
    () => (
      <div className="flex items-center gap-3 text-eyebrow">
        <LiveCount running={runningCount} />
      </div>
    ),
    [runningCount]
  );

  useShellHeader("Tasks", headerActions);

  return (
    <div className="tasks-v2 flex min-h-0 flex-1">
      <div className="list-col">
        {/* Visually-hidden heading: the visible page title lives in the shell
            header via useShellHeader above. We keep an in-page <h1> so screen
            readers and route/page-isolation tests see a stable heading even
            when the AppShell wrapper isn't mounted in a test environment. */}
        <h1 className="sr-only">Tasks</h1>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="list-head">
            <div className="scope-row" data-testid="tasks-scope-bar">
              <div
                className="scope-primary"
                role="group"
                aria-label="Filter tasks by status"
              >
                <ScopeChip
                  active={scope === "all"}
                  count={isLoading || error ? undefined : tasks.length}
                  label="All"
                  onClick={() => setScope("all")}
                />
                {TASK_SCOPE_CHIPS.map((item) => (
                  <ScopeChip
                    key={item.key}
                    active={scope === item.key}
                    count={item.countKey ? counts[item.countKey] : undefined}
                    label={item.label}
                    onClick={() =>
                      setScope(scope === item.key ? "all" : item.key)
                    }
                  />
                ))}
              </div>
              <div className="scope-secondary">
                <div className="scope-level">
                  <Dropdown
                    options={LEVEL_SELECT_OPTIONS}
                    value={selectedLevel}
                    onChange={handleLevelChange}
                    aria-label="Filter by level"
                    id="level-filter"
                    align="end"
                  />
                </div>
                <OverflowMenu
                  label="View options"
                  triggerClassName={[
                    "ctl ctl-outline tasks-view-trigger",
                    recentOnly || hideCompleted ? "on" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  testId="tasks-view-menu"
                  items={[
                    {
                      key: "recent",
                      label: "Updated in last 24h",
                      checked: recentOnly,
                      badge: counts.recent || undefined,
                      testId: "tasks-recent-only",
                      onSelect: () => setRecentOnly((value) => !value),
                    },
                    {
                      key: "hide-done",
                      label: "Hide done",
                      title: hideCompleted
                        ? "Show completed tasks"
                        : "Hide completed tasks",
                      checked: hideCompleted,
                      testId: "tasks-hide-done",
                      onSelect: () => setHideCompleted((value) => !value),
                    },
                    {
                      key: "expand",
                      label: allExpanded ? "Collapse all" : "Expand all",
                      disabled: expandableIds.length === 0,
                      separatorBefore: true,
                      testId: "tasks-expand-all",
                      onSelect: handleToggleExpandAll,
                    },
                  ]}
                />
              </div>
            </div>
            <PaletteSearchButton
              label="Search tasks"
              data-testid="task-search-button"
            />
          </div>

          <div className="list">
            <TaskTreeView
              hierarchy={hierarchy}
              isLoading={isLoading && tasks.length === 0}
              error={error}
              selectedTaskId={selectedTaskId}
              onTaskSelect={handleTaskSelect}
              expandedNodes={expandedNodes}
              hideCompleted={hideCompleted}
              filtering={filtering}
              summaryExpanded={summaryExpanded}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

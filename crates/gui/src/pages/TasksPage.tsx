import { useState, useCallback, useMemo, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import type { TaskFilterOptions, Task } from "../bindings";
import { useTasks } from "../hooks/useTasks";
import {
  buildTreeFromTasks,
  collectExpandableIds,
} from "../utils/buildTreeFromTasks";
import { useExpandedNodes } from "../hooks/useExpandedNodes";
import { useShellHeader } from "../hooks/useShellHeader";
import { TaskFilters, TaskTreeView } from "../components/TaskList";
import { TaskDetailPanel } from "../components/TaskDetail";
import { Count } from "../components/atoms/Count";
import { LiveCount } from "../components/shared/LiveCount";
import { isActiveRunStatus, isTaskDone } from "../utils/runState";
import { useSummaryExpanded } from "../hooks/useSummaryExpanded";
import { popOut, stashTask } from "../utils";

type TaskScope =
  | "all"
  | "active"
  | "waiting"
  | "blocked"
  | "recent"
  | "mine"
  | "queued"
  | "done";

const MINE_SCOPE_TAG_RE = /authoring|chat|live/i;

type TaskScopeCounts = Record<
  "active" | "waiting" | "blocked" | "mine" | "queued" | "done",
  number
>;

interface TaskScopeChipDefinition {
  key: Exclude<TaskScope, "all">;
  label: string;
  countKey?: keyof TaskScopeCounts;
  pulse?: boolean;
}

const TASK_SCOPE_CHIPS: TaskScopeChipDefinition[] = [
  { key: "active", label: "Active", countKey: "active", pulse: true },
  { key: "waiting", label: "Waiting", countKey: "waiting" },
  { key: "blocked", label: "Blocked", countKey: "blocked" },
  { key: "recent", label: "Recent" },
  { key: "mine", label: "Mine", countKey: "mine" },
  { key: "queued", label: "Queued", countKey: "queued" },
  { key: "done", label: "Done", countKey: "done" },
];

const COUNTED_TASK_SCOPE_CHIPS = TASK_SCOPE_CHIPS.filter(
  (
    chip
  ): chip is TaskScopeChipDefinition & { countKey: keyof TaskScopeCounts } =>
    Boolean(chip.countKey)
);

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

function matchesScope(task: Task, scope: TaskScope): boolean {
  const status = task.run_controls?.active_run?.status ?? null;

  switch (scope) {
    case "active":
      return isActiveRunStatus(status);
    case "waiting":
      return status === "waiting";
    case "blocked":
      return (task.dependency_ids?.length ?? 0) > 0;
    case "recent": {
      const updated = task.updated_at
        ? new Date(task.updated_at).getTime()
        : NaN;
      if (!Number.isFinite(updated)) return false;
      return Date.now() - updated <= 24 * 60 * 60 * 1000;
    }
    case "mine":
      return (task.tags ?? []).some((tag) => MINE_SCOPE_TAG_RE.test(tag));
    case "queued":
      return status === "queued";
    case "done":
      return isTaskDone(task);
    default:
      return true;
  }
}

function deriveScopedTasks(tasks: Task[], scope: TaskScope): Task[] {
  if (scope === "all") return tasks;

  const byId = new Map(tasks.map((task) => [task.id, task]));
  const include = new Set<string>();

  for (const task of tasks) {
    if (!matchesScope(task, scope)) continue;
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

function scopeCounts(tasks: Task[]) {
  return tasks.reduce(
    (counts, task) => {
      COUNTED_TASK_SCOPE_CHIPS.forEach(({ key, countKey }) => {
        if (matchesScope(task, key)) counts[countKey] += 1;
      });
      return counts;
    },
    { active: 0, waiting: 0, blocked: 0, mine: 0, queued: 0, done: 0 }
  );
}

function containsAllExpandedIds(
  expandedIds: ReadonlySet<string>,
  candidateIds: string[]
): boolean {
  return candidateIds.every((id) => expandedIds.has(id));
}

function ScopeChip({
  active,
  count,
  label,
  onClick,
  pulse,
}: {
  active: boolean;
  count?: number;
  label: string;
  onClick: () => void;
  pulse?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={["scope-chip", active ? "active" : ""]
        .filter(Boolean)
        .join(" ")}
    >
      {pulse && count && count > 0 && <span className="pulse" aria-hidden />}
      <span>{label}</span>
      {count != null && <Count value={count} className="n" />}
    </button>
  );
}

export function TasksPage() {
  const [searchParams] = useSearchParams();
  const [filters, setFilters] = useState<TaskFilterOptions>(INITIAL_FILTERS);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [scope, setScope] = useState<TaskScope>("all");
  const [hideCompleted, setHideCompleted] = useState(false);

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

  const { tasks, isLoading, error } = useTasks(filters);
  const scopedTasks = useMemo(
    () => deriveScopedTasks(tasks, scope),
    [tasks, scope]
  );
  const counts = useMemo(() => scopeCounts(tasks), [tasks]);

  const hierarchy = useMemo(
    () => buildTreeFromTasks(scopedTasks),
    [scopedTasks]
  );

  // "Filtering" mirrors the prototype: a scope chip (other than "all") or a
  // non-empty search narrows the list, in which case hide-done and the
  // done-summary collapse are bypassed so every match stays visible.
  const filtering = scope !== "all" || Boolean(filters.search?.trim());

  useEffect(() => {
    if (scopedTasks.length === 0) {
      if (selectedTaskId !== null) {
        setSelectedTaskId(null);
      }
      return;
    }

    if (
      !selectedTaskId ||
      !scopedTasks.some((task) => task.id === selectedTaskId)
    ) {
      setSelectedTaskId(scopedTasks[0].id);
    }
  }, [scopedTasks, selectedTaskId]);

  const handleFiltersChange = useCallback((newFilters: TaskFilterOptions) => {
    setFilters(newFilters);
  }, []);

  const handleTaskSelect = useCallback((task: Task) => {
    setSelectedTaskId(task.id);
  }, []);

  const handleClosePanel = useCallback(() => {
    setSelectedTaskId(scopedTasks[0]?.id ?? null);
  }, [scopedTasks]);

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
            t.dependency_ids?.includes(selectedTaskId))
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
  const { expandedNodeIds, expandAll } = expandedNodes;
  useEffect(() => {
    if (
      scope !== "all" &&
      expandableIds.length > 0 &&
      !containsAllExpandedIds(expandedNodeIds, expandableIds)
    ) {
      expandAll(expandableIds);
    }
  }, [scope, expandableIds, expandedNodeIds, expandAll]);

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

  const currentIsLoading = isLoading;
  const currentError = error;

  const taskCount = scopedTasks.length;

  const headerActions = useMemo(
    () => (
      <div className="flex items-center gap-3 text-[11px]">
        <LiveCount running={runningCount} />
        {!currentIsLoading && !currentError && taskCount > 0 && (
          <span className="text-[var(--color-fg-mute)]">
            <b className="font-semibold text-[var(--color-fg)]">{taskCount}</b>{" "}
            task{taskCount !== 1 ? "s" : ""}{" "}
            <span className="text-[var(--color-fg-ghost)]">·</span>{" "}
            {hierarchy.length} root{hierarchy.length !== 1 ? "s" : ""}
          </span>
        )}
      </div>
    ),
    [runningCount, currentIsLoading, currentError, taskCount, hierarchy.length]
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
              <div className="scope-primary">
                {TASK_SCOPE_CHIPS.map((item) => (
                  <ScopeChip
                    key={item.key}
                    active={scope === item.key}
                    count={item.countKey ? counts[item.countKey] : undefined}
                    label={item.label}
                    pulse={item.pulse}
                    onClick={() =>
                      setScope(scope === item.key ? "all" : item.key)
                    }
                  />
                ))}
              </div>
              <div className="scope-secondary">
                <button
                  type="button"
                  className={["hide-done", hideCompleted ? "on" : ""]
                    .filter(Boolean)
                    .join(" ")}
                  aria-pressed={hideCompleted}
                  onClick={() => setHideCompleted((v) => !v)}
                  title={
                    hideCompleted
                      ? "Show completed tasks"
                      : "Hide completed tasks"
                  }
                  data-testid="tasks-hide-done"
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    aria-hidden
                  >
                    {hideCompleted ? (
                      <>
                        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                        <line x1="1" y1="1" x2="23" y2="23" />
                      </>
                    ) : (
                      <>
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                        <circle cx="12" cy="12" r="3" />
                      </>
                    )}
                  </svg>
                  {hideCompleted ? "Done hidden" : "Hide done"}
                </button>
              </div>
            </div>
            <TaskFilters
              className="tasks-v2-filters"
              filters={filters}
              onFiltersChange={handleFiltersChange}
              allExpanded={allExpanded}
              onToggleExpandAll={handleToggleExpandAll}
              expandAllDisabled={expandableIds.length === 0}
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

      <TaskDetailPanel
        taskId={selectedTaskId}
        onClose={handleClosePanel}
        onTaskSelect={handleRelatedTaskSelect}
        onDetach={handleDetachPanel}
      />
    </div>
  );
}

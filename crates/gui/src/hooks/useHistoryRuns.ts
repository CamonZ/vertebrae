import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import type { Task, TaskRun } from "../bindings";
import { queryClient, taskRunsQueryOptions } from "../query";
import { useProjectScopeGeneration } from "../stores/projectScopedStores";
import { normalizeLocalChatSessionQuery } from "../utils/localChatSessionGroups";
import type { LocalChatRunRow } from "../utils/localChatSessionGroups";
import { useTasks } from "./useTasks";

/** Terminal runs that finished cleanly count as completed history. */
export function isCompletedRun(run: Pick<TaskRun, "status">): boolean {
  return run.status === "completed" || run.status === "stopped";
}

export function runActivityAt(run: TaskRun): string {
  return (
    run.updated_at ??
    run.ended_at ??
    run.started_at ??
    run.inserted_at ??
    new Date(0).toISOString()
  );
}

/** Search matches the task title, or a task/run id (full or prefix). */
export function runMatchesQuery(
  run: Pick<TaskRun, "id" | "task_id">,
  task: Pick<Task, "title"> | undefined,
  query: string
): boolean {
  const normalized = normalizeLocalChatSessionQuery(query);
  if (!normalized) return true;
  return (
    run.id.toLowerCase().startsWith(normalized) ||
    run.task_id.toLowerCase().startsWith(normalized) ||
    (task?.title.toLowerCase().includes(normalized) ?? false)
  );
}

const runData = (results: { data?: TaskRun[] }[]) =>
  results.map((result) => result.data);

interface UseHistoryRunsOptions {
  /** Runs live in the backend's current project only. */
  enabled: boolean;
  showCompleted: boolean;
  searchQuery: string;
}

export interface HistoryRuns {
  rows: LocalChatRunRow[];
  /** Matching runs hidden by the completed filter. */
  hiddenCompletedCount: number;
  /** Current-project task metadata for grouping run tasks. */
  tasksById: ReadonlyMap<string, Task>;
}

/**
 * Run rows for the chat history panel. v1 lists runs per task with
 * getTaskRuns for the current project's workflow tasks; completed tasks are
 * only queried while completed history is shown.
 */
export function useHistoryRuns({
  enabled,
  showCompleted,
  searchQuery,
}: UseHistoryRunsOptions): HistoryRuns {
  const generation = useProjectScopeGeneration();
  const { tasks } = useTasks(undefined, { enabled });

  const candidates = useMemo(
    () =>
      enabled
        ? tasks.filter(
            (task) =>
              task.workflow_id &&
              !task.archived &&
              (showCompleted || !task.completed_at)
          )
        : [],
    [enabled, showCompleted, tasks]
  );

  const runLists = useQueries(
    {
      queries: candidates.map((task) => ({
        ...taskRunsQueryOptions(generation, task.id),
        // Task-list hydration seeds only the active run; load full history.
        refetchOnMount: "always" as const,
      })),
      combine: runData,
    },
    queryClient
  );

  const tasksById = useMemo(
    () => new Map(tasks.map((task) => [task.id, task])),
    [tasks]
  );

  return useMemo(() => {
    const rows: LocalChatRunRow[] = [];
    let hiddenCompletedCount = 0;

    candidates.forEach((task, index) => {
      for (const run of runLists[index] ?? []) {
        if (!runMatchesQuery(run, task, searchQuery)) continue;
        const completed = !!task.completed_at || isCompletedRun(run);
        if (completed && !showCompleted) {
          hiddenCompletedCount += 1;
          continue;
        }
        rows.push({
          id: run.id,
          taskId: task.id,
          run,
          label: task.workflow_name ? `${task.workflow_name} run` : "Run",
          updatedAt: runActivityAt(run),
          completed,
        });
      }
    });

    return { rows, hiddenCompletedCount, tasksById };
  }, [candidates, runLists, searchQuery, showCompleted, tasksById]);
}

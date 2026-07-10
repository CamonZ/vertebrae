import { useCallback, useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { TaskRun } from "../bindings";
import { useProjectScopeGeneration } from "../stores/projectScopedStores";
import { errorMessage, queryClient, taskRunsQueryOptions } from "../query";
import { isActiveRunStatus } from "../utils/runState";

export type ResolvedRunSource = "active" | "latest" | "selected" | "none";
export interface ResolvedTaskRun {
  run: TaskRun | null;
  source: ResolvedRunSource;
}
export interface UseTaskRunsResult {
  runs: TaskRun[];
  activeRun: TaskRun | null;
  latestRun: TaskRun | null;
  resolveRun: (selectedRunId: string | null) => ResolvedTaskRun;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}
export interface UseTaskRunsForTasksResult {
  activeRunsByTaskId: ReadonlyMap<string, TaskRun>;
}

export function sortRunsNewestFirst(runs: readonly TaskRun[]): TaskRun[] {
  return [...runs].sort((a, b) => {
    const aTs = a.started_at ?? a.inserted_at ?? "";
    const bTs = b.started_at ?? b.inserted_at ?? "";
    return aTs !== bTs ? bTs.localeCompare(aTs) : b.id.localeCompare(a.id);
  });
}

export function selectActiveTaskRun(
  runs: readonly TaskRun[] | undefined
): TaskRun | null {
  return (
    sortRunsNewestFirst(runs ?? []).find((run) =>
      isActiveRunStatus(run.status)
    ) ?? null
  );
}

export function useTaskRuns(
  taskId: string | null | undefined
): UseTaskRunsResult {
  const generation = useProjectScopeGeneration();
  const query = useQuery(
    {
      ...taskRunsQueryOptions(
        generation,
        taskId ?? "__vertebrae_no_task_selected__"
      ),
      enabled: Boolean(taskId),
      // Task-list hydration contains only the active-run snapshot. The traces
      // surface is the sole history consumer, so it always upgrades that
      // snapshot to complete task history when mounted.
      refetchOnMount: "always",
    },
    queryClient
  );
  const runs = useMemo(
    () => sortRunsNewestFirst(query.data ?? []),
    [query.data]
  );
  const activeRun = useMemo(() => selectActiveTaskRun(runs), [runs]);
  const latestRun = useMemo(
    () => (activeRun ? null : (runs[0] ?? null)),
    [activeRun, runs]
  );
  const resolveRun = useCallback(
    (selectedRunId: string | null): ResolvedTaskRun => {
      const selected = selectedRunId
        ? runs.find((run) => run.id === selectedRunId)
        : null;
      if (selected) return { run: selected, source: "selected" };
      if (activeRun) return { run: activeRun, source: "active" };
      if (latestRun) return { run: latestRun, source: "latest" };
      return { run: null, source: "none" };
    },
    [activeRun, latestRun, runs]
  );
  return {
    runs,
    activeRun,
    latestRun,
    resolveRun,
    isLoading: query.isLoading,
    error: query.error ? errorMessage(query.error) : null,
    refetch: () => {
      void query.refetch();
    },
  };
}

export function useActiveTaskRunsForTasks(
  taskIds: readonly string[]
): UseTaskRunsForTasksResult {
  const generation = useProjectScopeGeneration();
  const taskIdsKey = [...new Set(taskIds)].sort().join("|");
  const stableTaskIds = useMemo(
    () => (taskIdsKey ? taskIdsKey.split("|") : []),
    [taskIdsKey]
  );
  const result = useQueries(
    {
      queries: stableTaskIds.map((taskId) =>
        ({ ...taskRunsQueryOptions(generation, taskId), enabled: false })
      ),
      combine: (queries) => ({
        queries,
      }),
    },
    queryClient
  );
  const activeRunsByTaskId = useMemo(
    () =>
      new Map(
        stableTaskIds.flatMap((taskId, index) => {
          const active = selectActiveTaskRun(result.queries[index]?.data);
          return active ? [[taskId, active] as [string, TaskRun]] : [];
        })
      ),
    [result.queries, stableTaskIds]
  );
  return {
    activeRunsByTaskId,
  };
}

export function useActiveTaskRun(taskId: string | null | undefined) {
  const { activeRunsByTaskId } = useActiveTaskRunsForTasks(
    taskId ? [taskId] : []
  );
  return taskId ? (activeRunsByTaskId.get(taskId) ?? null) : null;
}

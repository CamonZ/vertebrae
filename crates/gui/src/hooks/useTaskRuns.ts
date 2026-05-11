import { useCallback, useEffect, useMemo, useState } from "react";
import { commands, type TaskRun } from "../bindings";
import { useTaskRunStore } from "../stores";
import {
  getProjectScopeGeneration,
  isCurrentProjectScopeGeneration,
} from "../stores/projectScopedStores";
import { isActiveRunStatus } from "../utils/runState";

/**
 * How a TaskRun was selected for display in the traces UI.
 *
 *  - `active`   — an in-flight run is currently driving the task
 *  - `latest`   — no active run; falling back to the most recent terminal run
 *  - `selected` — an explicit `selectedRunId` matched a known run
 *  - `none`     — the task has no runs at all
 */
export type ResolvedRunSource = "active" | "latest" | "selected" | "none";

export interface ResolvedTaskRun {
  run: TaskRun | null;
  source: ResolvedRunSource;
}

export interface UseTaskRunsResult {
  /** All known runs for the task, newest first. */
  runs: TaskRun[];
  /** The active (non-terminal) run, when one exists. */
  activeRun: TaskRun | null;
  /** Most recent terminal run, when no active run exists. */
  latestRun: TaskRun | null;
  /** Resolve a `selectedRunId` (or null) into a concrete run + source. */
  resolveRun: (selectedRunId: string | null) => ResolvedTaskRun;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

/**
 * Sort runs by recency. Prefers `started_at`, falls back to `inserted_at`,
 * finally `id` for total ordering. Newer first.
 */
function sortRunsNewestFirst(runs: readonly TaskRun[]): TaskRun[] {
  return [...runs].sort((a, b) => {
    const aTs = a.started_at ?? a.inserted_at ?? "";
    const bTs = b.started_at ?? b.inserted_at ?? "";
    if (aTs !== bTs) return bTs.localeCompare(aTs);
    return b.id.localeCompare(a.id);
  });
}

/**
 * Loads durable TaskRuns for a task and keeps them in sync with the
 * `taskRunStore`, which is updated by `useTaskRunChangeListener` as
 * websocket events arrive. Returns an active/latest classification plus
 * a `resolveRun` helper used by the traces page to interpret URL state.
 */
export function useTaskRuns(
  taskId: string | null | undefined
): UseTaskRunsResult {
  const setTaskRunsForTask = useTaskRunStore(
    (state) => state.setTaskRunsForTask
  );
  const taskRunsByTaskId = useTaskRunStore((state) => state.taskRunsByTaskId);

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchRuns = useCallback(async () => {
    if (!taskId) {
      setError(null);
      return;
    }
    const projectScopeGeneration = getProjectScopeGeneration();

    setIsLoading(true);
    setError(null);
    try {
      const result = await commands.getTaskRuns(taskId);
      if (!isCurrentProjectScopeGeneration(projectScopeGeneration)) return;

      if (result.status === "ok") {
        setTaskRunsForTask(taskId, result.data);
      } else {
        setError(result.error.message);
      }
    } catch (e) {
      if (isCurrentProjectScopeGeneration(projectScopeGeneration)) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setIsLoading(false);
    }
  }, [taskId, setTaskRunsForTask]);

  useEffect(() => {
    fetchRuns();
  }, [fetchRuns]);

  const runs = useMemo(() => {
    if (!taskId) return [];
    return sortRunsNewestFirst(taskRunsByTaskId[taskId] ?? []);
  }, [taskId, taskRunsByTaskId]);

  const activeRun = useMemo(
    () => runs.find((run) => isActiveRunStatus(run.status)) ?? null,
    [runs]
  );

  const latestRun = useMemo(() => {
    if (activeRun) return null;
    return runs.find((run) => !isActiveRunStatus(run.status)) ?? null;
  }, [runs, activeRun]);

  const resolveRun = useCallback(
    (selectedRunId: string | null): ResolvedTaskRun => {
      if (selectedRunId) {
        const match = runs.find((run) => run.id === selectedRunId);
        if (match) return { run: match, source: "selected" };
      }
      if (activeRun) return { run: activeRun, source: "active" };
      if (latestRun) return { run: latestRun, source: "latest" };
      return { run: null, source: "none" };
    },
    [runs, activeRun, latestRun]
  );

  return {
    runs,
    activeRun,
    latestRun,
    resolveRun,
    isLoading,
    error,
    refetch: fetchRuns,
  };
}

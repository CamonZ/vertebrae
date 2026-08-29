import { useCallback, useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import type { StepExecution } from "../bindings";
import { useProjectScopeGeneration } from "../stores/projectScopedStores";
import { useTasks } from "./useTasks";
import { useScopedSessionLogs } from "./useScopedSessionLogs";
import {
  computeExecutionRollups,
  getDescendantTaskIds,
  type ExecutionRollups,
} from "../utils";
import { errorMessage, taskExecutionsQueryOptions } from "../query";

export interface UseSubtreeExecutionsResult {
  executions: StepExecution[];
  rollups: ExecutionRollups;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
  subtreeTaskIds: string[];
  isInSubtree: (taskId: string | null | undefined) => boolean;
}

// Live updates flow in via the app-wide `useStepExecutionChangeListener`,
// which writes through to the same by-task query keys used here.
export function useSubtreeExecutions(
  rootTaskId: string | null | undefined
): UseSubtreeExecutionsResult {
  const { tasks } = useTasks();
  const projectScopeGeneration = useProjectScopeGeneration();

  const subtreeTaskIds = useMemo(() => {
    if (!rootTaskId) return [];
    return getDescendantTaskIds(rootTaskId, tasks);
  }, [rootTaskId, tasks]);

  const subtreeSet = useMemo(() => new Set(subtreeTaskIds), [subtreeTaskIds]);

  const isInSubtree = useCallback(
    (taskId: string | null | undefined): boolean =>
      !!taskId && subtreeSet.has(taskId),
    [subtreeSet]
  );

  const executionQueries = useQueries({
    queries: subtreeTaskIds.map((taskId) =>
      taskExecutionsQueryOptions(projectScopeGeneration, taskId)
    ),
    combine: (results) => ({
      executions: results.flatMap((query) => query.data ?? []),
      firstError: results.find((query) => query.error)?.error,
      isLoading: results.some((query) => query.isLoading),
      refetch: () => {
        void Promise.all(results.map((query) => query.refetch()));
      },
    }),
  });

  const executions = executionQueries.executions;
  const firstError = executionQueries.firstError;
  const isLoading = executionQueries.isLoading;
  const refetch = useCallback(() => {
    executionQueries.refetch();
  }, [executionQueries]);

  const executionIds = useMemo(
    () => executions.map((execution) => execution.id),
    [executions]
  );
  const liveBuckets = useScopedSessionLogs(executionIds);

  const rollups = useMemo(
    () => computeExecutionRollups(executions, liveBuckets),
    [executions, liveBuckets]
  );

  return {
    executions,
    rollups,
    isLoading,
    error: firstError ? errorMessage(firstError) : null,
    refetch,
    subtreeTaskIds,
    isInSubtree,
  };
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { commands, type StepExecution } from "../bindings";
import { useExecutionStore } from "../stores";
import { useSessionLogStore } from "../stores/sessionLogStore";
import { useTaskStore } from "../stores/taskStore";
import {
  computeExecutionRollups,
  getDescendantTaskIds,
  type ExecutionRollups,
} from "../utils";

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
// which calls `upsertExecution` and writes through to the bucket cache —
// this hook re-renders by subscribing to that bucket and filtering reads
// to the subtree, rather than registering a second listener that would
// race with the global one.
export function useSubtreeExecutions(
  rootTaskId: string | null | undefined
): UseSubtreeExecutionsResult {
  const tasks = useTaskStore((state) => state.tasks);

  const subtreeTaskIds = useMemo(() => {
    if (!rootTaskId) return [];
    return getDescendantTaskIds(rootTaskId, tasks);
  }, [rootTaskId, tasks]);

  const subtreeSetRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    subtreeSetRef.current = new Set(subtreeTaskIds);
  }, [subtreeTaskIds]);

  const isInSubtree = useCallback(
    (taskId: string | null | undefined): boolean =>
      !!taskId && subtreeSetRef.current.has(taskId),
    []
  );

  const setExecutionsForTask = useExecutionStore(
    (state) => state.setExecutionsForTask
  );
  const executionsByTaskId = useExecutionStore(
    (state) => state.executionsByTaskId
  );

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetchSeqRef = useRef(0);

  const fetchAll = useCallback(async () => {
    if (subtreeTaskIds.length === 0) {
      setError(null);
      return;
    }
    const seq = ++fetchSeqRef.current;
    setIsLoading(true);
    setError(null);
    try {
      const results = await Promise.all(
        subtreeTaskIds.map((id) =>
          commands.getTaskExecutions(id).then((r) => ({ id, r }))
        )
      );
      if (seq !== fetchSeqRef.current) return;
      let firstError: string | null = null;
      for (const { id, r } of results) {
        if (r.status === "ok") {
          setExecutionsForTask(id, r.data);
        } else if (!firstError) {
          firstError = r.error.message;
        }
      }
      if (firstError) setError(firstError);
    } catch (e) {
      if (seq === fetchSeqRef.current) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (seq === fetchSeqRef.current) {
        setIsLoading(false);
      }
    }
  }, [subtreeTaskIds, setExecutionsForTask]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const executions = useMemo(() => {
    if (subtreeTaskIds.length === 0) return [];
    const merged: StepExecution[] = [];
    for (const taskId of subtreeTaskIds) {
      const bucket = executionsByTaskId[taskId];
      if (bucket) merged.push(...bucket);
    }
    return merged;
  }, [subtreeTaskIds, executionsByTaskId]);

  const logsByExecutionId = useSessionLogStore(
    (state) => state.logsByExecutionId
  );

  const rollups = useMemo(
    () => computeExecutionRollups(executions, logsByExecutionId),
    [executions, logsByExecutionId]
  );

  return {
    executions,
    rollups,
    isLoading,
    error,
    refetch: fetchAll,
    subtreeTaskIds,
    isInSubtree,
  };
}

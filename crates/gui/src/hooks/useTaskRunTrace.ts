import { useCallback, useEffect, useRef, useState } from "react";
import {
  commands,
  type SessionLog,
  type StepExecution,
  type TaskRun,
  type TaskRunTrace,
} from "../bindings";

export interface UseTaskRunTraceResult {
  /** Recursive trace tree rooted at `rootTaskRunId`, or null when not loaded. */
  trace: TaskRunTrace | null;
  /** Convenience accessor for the runs collected by the trace tree. */
  taskRuns: TaskRun[];
  /** Step executions that belong to the trace tree. */
  executions: StepExecution[];
  /** Session logs collected for executions in the trace tree. */
  sessionLogs: SessionLog[];
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

/**
 * Loads the recursive trace tree for a root TaskRun.
 *
 * Returns `null` data when `rootTaskRunId` is null/undefined; this lets the
 * traces page fall back to its legacy subtree-execution path while a run
 * resolution is still pending or when the task has no TaskRun history.
 *
 * Callers that need live updates should also rely on the global
 * step-execution and session-log listeners; this hook only owns the
 * initial fetch and explicit refetches.
 */
export function useTaskRunTrace(
  rootTaskRunId: string | null | undefined
): UseTaskRunTraceResult {
  const [trace, setTrace] = useState<TaskRunTrace | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Guards against out-of-order responses when `rootTaskRunId` flips between
  // resolutions while a fetch is in flight.
  const fetchSeqRef = useRef(0);

  const fetchTrace = useCallback(async () => {
    if (!rootTaskRunId) {
      setTrace(null);
      setError(null);
      return;
    }
    const seq = ++fetchSeqRef.current;
    setIsLoading(true);
    setError(null);
    try {
      const result = await commands.getTaskRunTrace(rootTaskRunId);
      if (seq !== fetchSeqRef.current) return;
      if (result.status === "ok") {
        setTrace(result.data);
      } else {
        setError(result.error.message);
        setTrace(null);
      }
    } catch (e) {
      if (seq === fetchSeqRef.current) {
        setError(e instanceof Error ? e.message : String(e));
        setTrace(null);
      }
    } finally {
      if (seq === fetchSeqRef.current) {
        setIsLoading(false);
      }
    }
  }, [rootTaskRunId]);

  useEffect(() => {
    fetchTrace();
  }, [fetchTrace]);

  return {
    trace,
    taskRuns: trace?.task_runs ?? EMPTY_RUNS,
    executions: trace?.step_executions ?? EMPTY_EXECUTIONS,
    sessionLogs: trace?.session_logs ?? EMPTY_LOGS,
    isLoading,
    error,
    refetch: fetchTrace,
  };
}

// Stable empty arrays so consumers can safely use these as dependency-array
// inputs without forcing re-runs on every render of the hook.
const EMPTY_RUNS: TaskRun[] = [];
const EMPTY_EXECUTIONS: StepExecution[] = [];
const EMPTY_LOGS: SessionLog[] = [];

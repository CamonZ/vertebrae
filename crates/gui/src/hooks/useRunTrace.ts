import { useMemo } from "react";
import type { SessionLog, StepExecution } from "../bindings";
import { useTaskExecutions } from "./useTaskExecutions";
import { useSubtreeSessionLogs } from "./useSubtreeSessionLogs";
import { useExecutionStore } from "../stores";

export interface UseRunTraceResult {
  /** Step executions belonging to the single active task_run, oldest-ish order. */
  stepExecutions: StepExecution[];
  /** Session logs keyed by `step_execution_id` for the run's executions. */
  logsByExecutionId: Record<string, SessionLog[]>;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

/**
 * SINGLE-RUN trace data path.
 *
 * There is no `get_run_executions(taskRunId)` command yet, so we use the
 * interim client-side approach: fetch ALL of the task's step executions via
 * `getTaskExecutions(taskId)` and FILTER to the ones that belong to
 * `activeRunId` (every execution of a run shares the same task). Live
 * executions for the run from `useExecutionStore` are overlaid so the trace
 * live-tails as new executions arrive.
 *
 * TODO(backend): get_run_executions(taskRunId) — replace the task-wide fetch
 * + client filter with a direct per-run executions query.
 */
export function useRunTrace(
  taskId: string | null | undefined,
  activeRunId: string | null | undefined
): UseRunTraceResult {
  const {
    executions: taskExecutions,
    isLoading,
    error,
    refetch,
  } = useTaskExecutions(taskId);

  // Live executions overlaid from the websocket-backed store, scoped to the run.
  const liveExecutions = useExecutionStore((state) => state.executions);

  const stepExecutions = useMemo<StepExecution[]>(() => {
    if (!activeRunId) return [];
    const byId = new Map<string, StepExecution>();
    for (const e of taskExecutions) {
      if (e.task_run_id === activeRunId && e.id) byId.set(e.id, e);
    }
    for (const e of liveExecutions) {
      if (e.task_run_id === activeRunId && e.id) byId.set(e.id, e);
    }
    return Array.from(byId.values());
  }, [taskExecutions, liveExecutions, activeRunId]);

  const { logsByExecutionId } = useSubtreeSessionLogs(stepExecutions);

  return { stepExecutions, logsByExecutionId, isLoading, error, refetch };
}

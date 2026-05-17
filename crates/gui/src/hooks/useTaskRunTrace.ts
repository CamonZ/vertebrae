import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  commands,
  type SessionLog,
  type StepExecution,
  type TaskRun,
  type TaskRunTrace,
} from "../bindings";
import {
  useExecutionStore,
  useSessionLogStore,
  useTaskRunStore,
} from "../stores";
import {
  getProjectScopeGeneration,
  isCurrentProjectScopeGeneration,
} from "../stores/projectScopedStores";
import {
  summarizeExecutions,
  summarizeRuns,
  traceDebug,
} from "../components/Traces/traceDebug";

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

type TraceState = {
  trace: TaskRunTrace;
  projectScopeGeneration: number;
};

/**
 * Loads the recursive trace tree for a root TaskRun.
 *
 * Returns `null` data when `rootTaskRunId` is null/undefined; this lets the
 * traces page fall back to its legacy subtree-execution path while a run
 * resolution is still pending or when the task has no TaskRun history.
 *
 * The fetched trace remains the source of truth for lineage. Websocket-backed
 * stores are overlaid only for runs and executions that already belong to that
 * lineage, so the page can live-tail without provider-specific render paths.
 */
export function useTaskRunTrace(
  rootTaskRunId: string | null | undefined
): UseTaskRunTraceResult {
  const [traceState, setTraceState] = useState<TraceState | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Guards against out-of-order responses when `rootTaskRunId` flips between
  // resolutions while a fetch is in flight.
  const fetchSeqRef = useRef(0);
  const pendingChildRunRefetchIdsRef = useRef<Set<string>>(new Set());

  const fetchTrace = useCallback(async () => {
    if (!rootTaskRunId) {
      traceDebug("fetch skipped", { rootTaskRunId: null });
      setTraceState(null);
      setError(null);
      return;
    }
    const seq = ++fetchSeqRef.current;
    const projectScopeGeneration = getProjectScopeGeneration();
    setIsLoading(true);
    setError(null);
    traceDebug("fetch start", {
      rootTaskRunId,
      seq,
      projectScopeGeneration,
    });
    try {
      const result = await commands.getTaskRunTrace(rootTaskRunId);
      if (
        seq !== fetchSeqRef.current ||
        !isCurrentProjectScopeGeneration(projectScopeGeneration)
      ) {
        traceDebug("fetch ignored", {
          rootTaskRunId,
          seq,
          latestSeq: fetchSeqRef.current,
          projectScopeGeneration,
          isCurrentProjectScopeGeneration: isCurrentProjectScopeGeneration(
            projectScopeGeneration
          ),
        });
        return;
      }
      if (result.status === "ok") {
        const taskRuns = result.data.task_runs ?? [];
        const executions = result.data.step_executions ?? [];
        const sessionLogs = result.data.session_logs ?? [];
        traceDebug("fetch ok", {
          rootTaskRunId,
          seq,
          taskRunCount: taskRuns.length,
          executionCount: executions.length,
          sessionLogCount: sessionLogs.length,
          taskRuns: summarizeRuns(taskRuns),
          executions: summarizeExecutions(executions),
        });
        setTraceState({
          trace: result.data,
          projectScopeGeneration,
        });
        pendingChildRunRefetchIdsRef.current.clear();
      } else {
        traceDebug("fetch error", {
          rootTaskRunId,
          seq,
          error: result.error.message,
        });
        setError(result.error.message);
        setTraceState(null);
      }
    } catch (e) {
      if (
        seq === fetchSeqRef.current &&
        isCurrentProjectScopeGeneration(projectScopeGeneration)
      ) {
        traceDebug("fetch exception", {
          rootTaskRunId,
          seq,
          error: e instanceof Error ? e.message : String(e),
        });
        setError(e instanceof Error ? e.message : String(e));
        setTraceState(null);
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

  const liveTaskRuns = useTaskRunStore((state) => state.taskRuns);
  const liveExecutions = useExecutionStore((state) => state.executions);
  const liveLogsByExecutionId = useSessionLogStore(
    (state) => state.logsByExecutionId
  );

  useEffect(() => {
    if (!traceState) return;
    if (!isCurrentProjectScopeGeneration(traceState.projectScopeGeneration)) {
      return;
    }

    const trace = traceState.trace;
    const fetchedRunIds = new Set((trace.task_runs ?? []).map((run) => run.id));
    if (fetchedRunIds.size === 0) return;

    const unseenChildRun = liveTaskRuns.find((run) => {
      if (fetchedRunIds.has(run.id)) return false;
      if (run.root_task_run_id !== trace.root_task_run_id) return false;
      return (
        run.parent_task_run_id !== null &&
        fetchedRunIds.has(run.parent_task_run_id)
      );
    });

    if (!unseenChildRun) return;
    if (pendingChildRunRefetchIdsRef.current.has(unseenChildRun.id)) return;

    pendingChildRunRefetchIdsRef.current.add(unseenChildRun.id);
    fetchTrace();
  }, [fetchTrace, liveTaskRuns, traceState]);

  const mergedTrace = useMemo<TaskRunTrace | null>(() => {
    if (!traceState) return null;
    const { trace, projectScopeGeneration } = traceState;
    if (!isCurrentProjectScopeGeneration(projectScopeGeneration)) {
      return trace;
    }

    const fetchedTaskRuns = trace.task_runs ?? EMPTY_RUNS;
    const fetchedExecutions = trace.step_executions ?? EMPTY_EXECUTIONS;
    const fetchedSessionLogs = trace.session_logs ?? EMPTY_LOGS;

    const taskRuns = mergeTaskRuns(fetchedTaskRuns, liveTaskRuns);
    const taskRunIds = new Set(taskRuns.map((run) => run.id));
    const executions = mergeExecutions(
      fetchedExecutions,
      liveExecutions,
      taskRunIds
    );
    const executionIds = new Set(
      executions
        .map((execution) => execution.id)
        .filter((id): id is string => !!id)
    );
    const sessionLogs = mergeSessionLogs(
      fetchedSessionLogs,
      liveLogsByExecutionId,
      executionIds
    );

    if (
      taskRuns === fetchedTaskRuns &&
      executions === fetchedExecutions &&
      sessionLogs === fetchedSessionLogs
    ) {
      return trace;
    }

    return {
      ...trace,
      task_runs: taskRuns,
      step_executions: executions,
      session_logs: sessionLogs,
    };
  }, [liveExecutions, liveLogsByExecutionId, liveTaskRuns, traceState]);

  return {
    trace: mergedTrace,
    taskRuns: mergedTrace?.task_runs ?? EMPTY_RUNS,
    executions: mergedTrace?.step_executions ?? EMPTY_EXECUTIONS,
    sessionLogs: mergedTrace?.session_logs ?? EMPTY_LOGS,
    isLoading,
    error,
    refetch: fetchTrace,
  };
}

function mergeTaskRuns(
  fetchedRuns: TaskRun[],
  liveRuns: readonly TaskRun[]
): TaskRun[] {
  if (fetchedRuns.length === 0 || liveRuns.length === 0) {
    return fetchedRuns;
  }

  const liveById = new Map(liveRuns.map((run) => [run.id, run]));
  let changed = false;
  const merged = fetchedRuns.map((run) => {
    const live = liveById.get(run.id);
    if (live && live !== run) {
      changed = true;
      return live;
    }
    return run;
  });
  return changed ? merged : fetchedRuns;
}

function mergeExecutions(
  fetchedExecutions: StepExecution[],
  liveExecutions: readonly StepExecution[],
  taskRunIds: ReadonlySet<string>
): StepExecution[] {
  if (liveExecutions.length === 0) {
    return fetchedExecutions;
  }

  const merged = new Map<string, StepExecution>();
  const order: string[] = [];
  let changed = false;

  for (const execution of fetchedExecutions) {
    if (!execution.id) continue;
    merged.set(execution.id, execution);
    order.push(execution.id);
  }

  for (const execution of liveExecutions) {
    if (!execution.id || !execution.task_run_id) continue;
    if (!taskRunIds.has(execution.task_run_id)) continue;
    if (!merged.has(execution.id)) {
      order.push(execution.id);
      changed = true;
    } else if (merged.get(execution.id) !== execution) {
      changed = true;
    }
    merged.set(execution.id, execution);
  }

  return changed
    ? order.map((id) => merged.get(id)).filter(isDefined)
    : fetchedExecutions;
}

function mergeSessionLogs(
  fetchedLogs: SessionLog[],
  liveLogsByExecutionId: Record<string, SessionLog[]>,
  executionIds: ReadonlySet<string>
): SessionLog[] {
  if (executionIds.size === 0) {
    return fetchedLogs;
  }

  const logsById = new Map<string, SessionLog>();
  const order: string[] = [];
  let changed = false;

  const addLog = (log: SessionLog) => {
    if (!log.id || !log.step_execution_id) return;
    if (!executionIds.has(log.step_execution_id)) return;
    if (!logsById.has(log.id)) order.push(log.id);
    logsById.set(log.id, log);
  };

  for (const log of fetchedLogs) {
    addLog(log);
  }

  for (const executionId of executionIds) {
    for (const log of liveLogsByExecutionId[executionId] ?? []) {
      const existing = log.id ? logsById.get(log.id) : undefined;
      addLog(log);
      if (!existing || existing !== log) {
        changed = true;
      }
    }
  }

  return changed
    ? order.map((id) => logsById.get(id)).filter(isDefined)
    : fetchedLogs;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

// Stable empty arrays so consumers can safely use these as dependency-array
// inputs without forcing re-runs on every render of the hook.
const EMPTY_RUNS: TaskRun[] = [];
const EMPTY_EXECUTIONS: StepExecution[] = [];
const EMPTY_LOGS: SessionLog[] = [];

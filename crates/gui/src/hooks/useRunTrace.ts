import { useQuery } from "@tanstack/react-query";
import {
  commands,
  type SessionLog,
  type StepExecution,
  type TaskRunTrace,
} from "../bindings";
import {
  isCurrentProjectScopeGeneration,
  useProjectScopeGeneration,
} from "../stores/projectScopedStores";
import { useSessionLogStore } from "../stores/sessionLogStore";
import { useSubtreeSessionLogs } from "./useSubtreeSessionLogs";
import {
  errorMessage,
  mergeFetchedTaskRunTrace,
  queryClient,
  queryKeys,
  unwrapCommand,
} from "../query";
import {
  taskDetailTraceNow,
  traceTaskDetailPhase,
} from "../utils/taskDetailTrace";

function seedSessionLogs(
  logs: readonly SessionLog[],
  logsByExecutionIdAtFetchStart: Record<string, SessionLog[]>,
  setLogs: (executionId: string, logs: SessionLog[]) => void
) {
  if (logs.length === 0) return;
  const logsByExecutionId = new Map<string, SessionLog[]>();
  for (const log of logs) {
    if (!log.step_execution_id) continue;
    const bucket = logsByExecutionId.get(log.step_execution_id) ?? [];
    bucket.push(log);
    logsByExecutionId.set(log.step_execution_id, bucket);
  }
  for (const [executionId, bucket] of logsByExecutionId) {
    const currentLogs =
      useSessionLogStore.getState().logsByExecutionId[executionId];
    const logsAtFetchStart = logsByExecutionIdAtFetchStart[executionId];
    setLogs(
      executionId,
      mergeFetchedSessionLogs(bucket, currentLogs, logsAtFetchStart)
    );
  }
}

function sessionLogKeys(log: SessionLog): string[] {
  const keys: string[] = [];
  if (log.id) keys.push(`id:${log.id}`);
  if (log.logical_key) keys.push(`logical:${log.logical_key}`);
  return keys;
}

function sessionLogMap(logs: readonly SessionLog[] | undefined) {
  const byKey = new Map<string, SessionLog>();
  for (const log of logs ?? []) {
    for (const key of sessionLogKeys(log)) {
      byKey.set(key, log);
    }
  }
  return byKey;
}

function firstMatchingSessionLog(
  byKey: ReadonlyMap<string, SessionLog>,
  log: SessionLog
): SessionLog | undefined {
  for (const key of sessionLogKeys(log)) {
    const match = byKey.get(key);
    if (match) return match;
  }
  return undefined;
}

function hasFetchedSessionLogKey(
  fetchedKeys: ReadonlySet<string>,
  log: SessionLog
): boolean {
  return sessionLogKeys(log).some((key) => fetchedKeys.has(key));
}

function mergeFetchedSessionLogs(
  fetchedLogs: readonly SessionLog[],
  currentLogs: readonly SessionLog[] | undefined,
  logsAtFetchStart: readonly SessionLog[] | undefined
): SessionLog[] {
  const currentByKey = sessionLogMap(currentLogs);
  const atFetchStartByKey = sessionLogMap(logsAtFetchStart);
  const fetchedKeys = new Set<string>();

  const merged = fetchedLogs.map((log) => {
    const keys = sessionLogKeys(log);
    if (keys.length === 0) return log;

    for (const key of keys) fetchedKeys.add(key);
    const current = firstMatchingSessionLog(currentByKey, log);
    const atFetchStart = firstMatchingSessionLog(atFetchStartByKey, log);
    return current && current !== atFetchStart ? current : log;
  });

  for (const log of currentLogs ?? []) {
    const keys = sessionLogKeys(log);
    if (keys.length === 0) {
      if (!(logsAtFetchStart ?? []).includes(log)) merged.push(log);
      continue;
    }
    if (hasFetchedSessionLogKey(fetchedKeys, log)) continue;
    if (log === firstMatchingSessionLog(atFetchStartByKey, log)) continue;
    merged.push(log);
  }

  return merged;
}

export interface UseRunTraceResult {
  /** Step executions belonging to the selected single TaskRun. */
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
 * `getTaskRunTrace(runId)` is single-run scoped. The `root_task_run_id`
 * command argument and response field names are legacy Sacrum names; callers
 * pass the concrete run id they want to display.
 */
export function useRunTrace(
  taskId: string | null | undefined,
  activeRunId: string | null | undefined
): UseRunTraceResult {
  const projectScopeGeneration = useProjectScopeGeneration();
  const queryKey = queryKeys.executions.byRun(
    projectScopeGeneration,
    activeRunId ?? "__vertebrae_no_run_selected__"
  );
  const setLogs = useSessionLogStore((state) => state.setLogs);

  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const startedAt = taskDetailTraceNow();
      if (taskId) {
        traceTaskDetailPhase(taskId, "run-trace-query-start", {
          command: "getTaskRunTrace",
          runId: activeRunId,
        });
      }
      const generationAtFetchStart = projectScopeGeneration;
      const traceAtFetchStart =
        queryClient.getQueryData<TaskRunTrace>(queryKey);
      const logsByExecutionIdAtFetchStart =
        useSessionLogStore.getState().logsByExecutionId;
      let fetchedTrace: TaskRunTrace;
      try {
        fetchedTrace = await unwrapCommand(
          commands.getTaskRunTrace(activeRunId!)
        );
      } catch (error) {
        if (taskId) {
          traceTaskDetailPhase(taskId, "run-trace-query-error", {
            durationMs: taskDetailTraceNow() - startedAt,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        throw error;
      }
      if (taskId) {
        traceTaskDetailPhase(taskId, "run-trace-query-success", {
          durationMs: taskDetailTraceNow() - startedAt,
          executions: fetchedTrace.step_executions?.length ?? 0,
        });
      }
      if (isCurrentProjectScopeGeneration(generationAtFetchStart)) {
        seedSessionLogs(
          fetchedTrace.session_logs ?? [],
          logsByExecutionIdAtFetchStart,
          setLogs
        );
      }
      const traceWithoutSessionLogs = {
        ...fetchedTrace,
        session_logs: [],
      };
      const currentTrace = queryClient.getQueryData<TaskRunTrace>(queryKey);
      return mergeFetchedTaskRunTrace(
        traceWithoutSessionLogs,
        currentTrace,
        traceAtFetchStart
      );
    },
    enabled: Boolean(activeRunId),
  });

  const stepExecutions = query.data?.step_executions ?? [];
  const { logsByExecutionId } = useSubtreeSessionLogs(stepExecutions);

  return {
    stepExecutions,
    logsByExecutionId,
    isLoading: query.isLoading,
    error: query.error ? errorMessage(query.error) : null,
    refetch: () => {
      void query.refetch();
    },
  };
}

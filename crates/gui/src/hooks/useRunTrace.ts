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
import {
  useSessionLogStore,
  type ExecutionLogBucket,
} from "../stores/sessionLogStore";
import { mergeFetchedSessionLogs } from "../stores/mergeFetchedSessionLogs";
import { useSubtreeSessionLogs } from "./useSubtreeSessionLogs";
import {
  errorMessage,
  mergeFetchedTaskRunTrace,
  queryClient,
  queryKeys,
  unwrapCommand,
} from "../query";

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
      useSessionLogStore.getState().logsByExecutionId[executionId]?.logs;
    const logsAtFetchStart = logsByExecutionIdAtFetchStart[executionId];
    // Preserve both live events and fuller execution-history responses that
    // arrived while this run snapshot was in flight.
    setLogs(
      executionId,
      mergeFetchedSessionLogs(bucket, currentLogs, logsAtFetchStart)
    );
  }
}

export interface UseRunTraceResult {
  /** Step executions belonging to the selected single TaskRun. */
  stepExecutions: StepExecution[];
  /** Session logs keyed by `step_execution_id` for the run's executions. */
  logsByExecutionId: Record<string, SessionLog[]>;
  /** Session-log buckets keyed by `step_execution_id`. */
  logBucketsByExecutionId: Record<string, ExecutionLogBucket>;
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
  _taskId: string | null | undefined,
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
      const generationAtFetchStart = projectScopeGeneration;
      const traceAtFetchStart =
        queryClient.getQueryData<TaskRunTrace>(queryKey);
      const logsByExecutionIdAtFetchStart = Object.fromEntries(
        Object.entries(useSessionLogStore.getState().logsByExecutionId).map(
          ([executionId, bucket]) => [executionId, bucket.logs]
        )
      );
      const fetchedTrace = await unwrapCommand(
        commands.getTaskRunTrace(activeRunId!)
      );
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
  const { logsByExecutionId, logBucketsByExecutionId } =
    useSubtreeSessionLogs(stepExecutions);

  return {
    stepExecutions,
    logsByExecutionId,
    logBucketsByExecutionId,
    isLoading: query.isLoading,
    error: query.error ? errorMessage(query.error) : null,
    refetch: () => {
      void query.refetch();
    },
  };
}

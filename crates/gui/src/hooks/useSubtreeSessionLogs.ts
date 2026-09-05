import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { commands, type SessionLog, type StepExecution } from "../bindings";
import {
  isLiveSessionLog,
  useSessionLogStore,
  type ExecutionLogBucket,
} from "../stores/sessionLogStore";
import { mergeFetchedSessionLogs } from "../stores/mergeFetchedSessionLogs";
import {
  isCurrentProjectScopeGeneration,
  useProjectScopeGeneration,
} from "../stores/projectScopedStores";
import { useScopedSessionLogs } from "./useScopedSessionLogs";

export interface UseSubtreeSessionLogsResult {
  /** Map: execution_id -> SessionLog[] */
  logsByExecutionId: Record<string, SessionLog[]>;
  /** Map: execution_id -> merged logs and incrementally maintained cost. */
  logBucketsByExecutionId: Record<string, ExecutionLogBucket>;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

/**
 * Seeds fetched history into the same store that receives live log events.
 * Reconcile by identity, preserving updates received while a fetch is in flight;
 * row counts cannot establish whether a live bucket contains the fetched history.
 */
export function useSubtreeSessionLogs(
  executions: readonly StepExecution[]
): UseSubtreeSessionLogsResult {
  const projectScopeGeneration = useProjectScopeGeneration();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetchSeqRef = useRef(0);

  const idsKey = executions
    .map((e) => e.id)
    .filter((id): id is string => !!id)
    .sort()
    .join("|");
  const ids = useMemo(() => (idsKey ? idsKey.split("|") : []), [idsKey]);

  const fetchAll = useCallback(async () => {
    const seq = ++fetchSeqRef.current;
    if (ids.length === 0) {
      setError(null);
      setIsLoading(false);
      return;
    }
    const bucketsAtFetchStart = useSessionLogStore.getState().logsByExecutionId;
    setIsLoading(true);
    setError(null);
    const results = await Promise.all(
      ids.map((id) => commands.getExecutionLogs(id).then((r) => ({ id, r })))
    );
    if (
      seq !== fetchSeqRef.current ||
      !isCurrentProjectScopeGeneration(projectScopeGeneration)
    ) {
      return;
    }
    let firstError: string | null = null;
    for (const { id, r } of results) {
      if (r.status === "ok") {
        const store = useSessionLogStore.getState();
        store.setLogs(
          id,
          mergeFetchedSessionLogs(
            r.data,
            store.logsByExecutionId[id]?.logs,
            bucketsAtFetchStart[id]?.logs,
            // Full execution history supersedes concurrent run snapshots,
            // but must still yield to actual live updates.
            isLiveSessionLog
          )
        );
      } else if (!firstError) {
        firstError = r.error.message;
      }
    }
    if (firstError) setError(firstError);
    setIsLoading(false);
  }, [ids, projectScopeGeneration]);

  useEffect(() => {
    const fetchSequence = fetchSeqRef;
    fetchAll();
    return () => {
      ++fetchSequence.current;
    };
  }, [fetchAll]);

  const logBucketsByExecutionId = useScopedSessionLogs(ids);

  const mergedLogsByExecutionId = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(logBucketsByExecutionId).map(([id, bucket]) => [
          id,
          bucket.logs,
        ])
      ),
    [logBucketsByExecutionId]
  );

  return {
    logsByExecutionId: mergedLogsByExecutionId,
    logBucketsByExecutionId,
    isLoading,
    error,
    refetch: fetchAll,
  };
}

import { useCallback, useEffect, useRef, useState } from "react";
import { commands, type SessionLog, type StepExecution } from "../bindings";

export interface UseSubtreeSessionLogsResult {
  /** Map: execution_id -> SessionLog[] */
  logsByExecutionId: Record<string, SessionLog[]>;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useSubtreeSessionLogs(
  executions: readonly StepExecution[]
): UseSubtreeSessionLogsResult {
  const [logsByExecutionId, setLogsByExecutionId] = useState<
    Record<string, SessionLog[]>
  >({});
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetchSeqRef = useRef(0);

  const idsKey = executions
    .map((e) => e.id)
    .filter((id): id is string => !!id)
    .sort()
    .join("|");

  const fetchAll = useCallback(async () => {
    const ids = idsKey ? idsKey.split("|") : [];
    if (ids.length === 0) {
      setLogsByExecutionId({});
      setError(null);
      return;
    }
    const seq = ++fetchSeqRef.current;
    setIsLoading(true);
    setError(null);
    const results = await Promise.all(
      ids.map((id) => commands.getExecutionLogs(id).then((r) => ({ id, r })))
    );
    if (seq !== fetchSeqRef.current) return;
    const next: Record<string, SessionLog[]> = {};
    let firstError: string | null = null;
    for (const { id, r } of results) {
      if (r.status === "ok") {
        next[id] = r.data;
      } else if (!firstError) {
        firstError = r.error.message;
      }
    }
    setLogsByExecutionId(next);
    if (firstError) setError(firstError);
    setIsLoading(false);
  }, [idsKey]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  return { logsByExecutionId, isLoading, error, refetch: fetchAll };
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { commands, type SessionLog, type StepExecution } from "../bindings";
import { useSessionLogStore } from "../stores";
import {
  getProjectScopeGeneration,
  isCurrentProjectScopeGeneration,
} from "../stores/projectScopedStores";

export interface UseSubtreeSessionLogsResult {
  /** Map: execution_id -> SessionLog[] */
  logsByExecutionId: Record<string, SessionLog[]>;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

/**
 * Fetches session logs for a set of executions and merges them with live
 * appends from the global `sessionLogStore` (populated by the
 * `useSessionLogChangeListener`). The store wins on a per-execution basis when
 * its bucket has at least as many logs as the initial fetch — this lets THREAD
 * mode live-tail new SessionLogCreatedEvents without dropping the historical
 * baseline before the listener observed any logs.
 */
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
  const ids = useMemo(() => (idsKey ? idsKey.split("|") : []), [idsKey]);

  const fetchAll = useCallback(async () => {
    if (ids.length === 0) {
      setLogsByExecutionId({});
      setError(null);
      return;
    }
    const seq = ++fetchSeqRef.current;
    const projectScopeGeneration = getProjectScopeGeneration();
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
  }, [ids]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const liveLogs = useSessionLogStore((s) => s.logsByExecutionId);

  const merged = useMemo(() => {
    if (ids.length === 0) return {} as Record<string, SessionLog[]>;
    const out: Record<string, SessionLog[]> = {};
    for (const id of ids) {
      const fetched = logsByExecutionId[id];
      const live = liveLogs[id];
      if (!live || live.length === 0) {
        if (fetched !== undefined) out[id] = fetched;
        continue;
      }
      // If live has at least as many entries as fetched, prefer live (it's a
      // superset that includes appended events). Otherwise treat the fetched
      // baseline as authoritative for now.
      const fetchedLen = fetched?.length ?? 0;
      out[id] = live.length >= fetchedLen ? live : (fetched ?? live);
    }
    return out;
  }, [ids, logsByExecutionId, liveLogs]);

  return { logsByExecutionId: merged, isLoading, error, refetch: fetchAll };
}

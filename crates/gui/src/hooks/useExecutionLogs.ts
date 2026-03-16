import { useState, useCallback } from "react";
import { commands, SessionLog } from "../bindings";

/**
 * Hook for fetching session logs for a step execution.
 * Designed for lazy loading - fetch is triggered explicitly via fetchLogs.
 *
 * @returns Object containing logs array, loading state, error state, and fetchLogs function
 */
export function useExecutionLogs() {
  const [logs, setLogs] = useState<SessionLog[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasFetched, setHasFetched] = useState(false);

  const fetchLogs = useCallback(async (executionId: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await commands.getExecutionLogs(executionId);
      if (result.status === "ok") {
        // Sort logs descending (newest first) as per requirements
        const sortedLogs = [...result.data].sort((a, b) => {
          const dateA = new Date(a.created_at ?? '').getTime();
          const dateB = new Date(b.created_at ?? '').getTime();
          return dateB - dateA;
        });
        setLogs(sortedLogs);
      } else {
        setError(result.error.message);
        setLogs([]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setLogs([]);
    } finally {
      setIsLoading(false);
      setHasFetched(true);
    }
  }, []);

  const reset = useCallback(() => {
    setLogs([]);
    setIsLoading(false);
    setError(null);
    setHasFetched(false);
  }, []);

  return { logs, isLoading, error, hasFetched, fetchLogs, reset };
}

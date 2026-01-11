import { useEffect, useState, useCallback } from "react";
import { commands, StepExecution } from "../bindings";

/**
 * Hook for fetching step executions for a task.
 * Returns a chronological list of all workflow step executions.
 *
 * @param taskId - The task ID to fetch executions for. If null/undefined, no fetch is performed.
 * @returns Object containing executions array, loading state, error state, and refetch function
 */
export function useTaskExecutions(taskId: string | null | undefined) {
  const [executions, setExecutions] = useState<StepExecution[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchExecutions = useCallback(async () => {
    if (!taskId) {
      setExecutions([]);
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const result = await commands.getTaskExecutions(taskId);
      if (result.status === "ok") {
        setExecutions(result.data);
      } else {
        setError(result.error.message);
        setExecutions([]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setExecutions([]);
    } finally {
      setIsLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    fetchExecutions();
  }, [fetchExecutions]);

  const refetch = useCallback(() => {
    fetchExecutions();
  }, [fetchExecutions]);

  return { executions, isLoading, error, refetch };
}

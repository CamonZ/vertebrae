import { useEffect, useState, useCallback } from "react";
import { commands } from "../bindings";
import { useTaskStore } from "../stores";

/**
 * Hook for fetching a single task.
 * Automatically syncs the selected task to the Zustand store.
 *
 * @param id - The task ID to fetch. If null/undefined, no fetch is performed.
 * @returns Object containing task data, loading state, error state, and refetch function
 */
export function useTask(id: string | null | undefined) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { selectedTask, selectTask, clearSelection } = useTaskStore();

  const fetchTask = useCallback(async () => {
    if (!id) {
      clearSelection();
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const result = await commands.getTask(id);
      if (result.status === "ok") {
        selectTask(id, result.data);
      } else {
        setError(result.error.message);
        clearSelection();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      clearSelection();
    } finally {
      setIsLoading(false);
    }
  }, [id, selectTask, clearSelection]);

  useEffect(() => {
    fetchTask();
  }, [fetchTask]);

  const refetch = useCallback(() => {
    fetchTask();
  }, [fetchTask]);

  return { task: selectedTask, isLoading, error, refetch };
}

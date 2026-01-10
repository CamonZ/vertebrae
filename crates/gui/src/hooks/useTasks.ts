import { useEffect, useState, useCallback } from 'react';
import { commands, type TaskFilterOptions } from '../bindings';
import { useTaskStore } from '../stores';

/**
 * Hook for fetching and managing the task list.
 * Automatically syncs fetched tasks to the Zustand store.
 *
 * @param filter - Optional filter options for the task list
 * @returns Object containing tasks array, loading state, error state, and refetch function
 */
export function useTasks(filter?: TaskFilterOptions) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { tasks, setTasks } = useTaskStore();

  const fetchTasks = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await commands.listTasks(filter ?? null);
      if (result.status === 'ok') {
        setTasks(result.data);
      } else {
        setError(result.error.message);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsLoading(false);
    }
  }, [filter, setTasks]);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  const refetch = useCallback(() => {
    fetchTasks();
  }, [fetchTasks]);

  return { tasks, isLoading, error, refetch };
}

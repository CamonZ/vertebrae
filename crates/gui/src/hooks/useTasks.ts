import { useEffect, useState, useCallback } from "react";
import { commands, type TaskFilterOptions } from "../bindings";
import { useTaskStore } from "../stores";

/**
 * Hook for fetching and managing the task list.
 * Automatically syncs fetched tasks to the Zustand store.
 *
 * After the fetch completes, any tasks that were upserted into the store
 * via WebSocket events while the fetch was in flight are preserved rather
 * than discarded by the bulk setTasks call.
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
      if (result.status === "ok") {
        // Capture any tasks that were upserted into the store via WebSocket
        // events while the fetch was in flight (these won't be in the fetch
        // result because they arrived after the server processed the request).
        const currentStoreTasks = useTaskStore.getState().tasks;
        const fetchedIds = new Set(result.data.map((t) => t.id));
        const upsertedDuringFetch = currentStoreTasks.filter(
          (t) => !fetchedIds.has(t.id)
        );

        // Replace the store with the fresh fetch result…
        setTasks(result.data);

        // …then re-add any tasks that arrived via WebSocket during the fetch
        // so they are not silently dropped.
        if (upsertedDuringFetch.length > 0) {
          const { upsertTask } = useTaskStore.getState();
          for (const task of upsertedDuringFetch) {
            upsertTask(task);
          }
        }
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

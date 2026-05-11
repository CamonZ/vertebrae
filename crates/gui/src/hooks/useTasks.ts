import { useEffect, useState, useCallback } from "react";
import { commands, type TaskFilterOptions } from "../bindings";
import { useTaskStore } from "../stores";
import {
  getProjectScopeGeneration,
  isCurrentProjectScopeGeneration,
} from "../stores/projectScopedStores";

/**
 * Hook for fetching and managing the task list.
 * Automatically syncs fetched tasks to the Zustand store.
 *
 * After the fetch completes, tasks newly inserted into the store via WebSocket
 * events while the fetch was in flight are preserved rather than discarded by
 * the bulk setTasks call.
 *
 * @param filter - Optional filter options for the task list
 * @returns Object containing tasks array, loading state, error state, and refetch function
 */
export function useTasks(filter?: TaskFilterOptions) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { tasks, setTasks } = useTaskStore();

  const fetchTasks = useCallback(async () => {
    const projectScopeGeneration = getProjectScopeGeneration();
    const taskIdsAtFetchStart = new Set(
      useTaskStore.getState().tasks.map((task) => task.id)
    );

    setIsLoading(true);
    setError(null);
    try {
      const result = await commands.listTasks(filter ?? null);
      if (result.status === "ok") {
        if (!isCurrentProjectScopeGeneration(projectScopeGeneration)) {
          return;
        }

        // Preserve only tasks newly inserted while this request was in flight.
        // Pre-existing store entries can belong to a previously selected
        // project and must not be re-added after the scoped fetch completes.
        const currentStoreTasks = useTaskStore.getState().tasks;
        const fetchedIds = new Set(result.data.map((t) => t.id));
        const upsertedDuringFetch = currentStoreTasks.filter(
          (t) => !fetchedIds.has(t.id) && !taskIdsAtFetchStart.has(t.id)
        );

        setTasks([...result.data, ...upsertedDuringFetch]);
      } else {
        if (isCurrentProjectScopeGeneration(projectScopeGeneration)) {
          setError(result.error.message);
        }
      }
    } catch (e) {
      if (isCurrentProjectScopeGeneration(projectScopeGeneration)) {
        setError(e instanceof Error ? e.message : String(e));
      }
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

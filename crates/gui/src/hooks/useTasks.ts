import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { commands, type TaskFilterOptions } from "../bindings";
import { useTaskStore } from "../stores";
import { useProjectScopeGeneration } from "../stores/projectScopedStores";
import { errorMessage, queryKeys, unwrapCommand } from "../query";

/**
 * Hook for fetching and managing the task list.
 *
 * TanStack Query owns the server-state cache. The Zustand write-through remains
 * as a compatibility bridge for views that still derive local UI from the
 * task store while the migration proceeds incrementally.
 */
export function useTasks(filter?: TaskFilterOptions) {
  const activeFilter = filter ?? null;
  const projectScopeGeneration = useProjectScopeGeneration();
  const storeTasks = useTaskStore((state) => state.tasks);
  const setTasks = useTaskStore((state) => state.setTasks);
  const setActiveFilter = useTaskStore((state) => state.setActiveFilter);

  useEffect(() => {
    setActiveFilter(activeFilter);
  }, [activeFilter, setActiveFilter]);

  const query = useQuery({
    queryKey: queryKeys.tasks.list(projectScopeGeneration, activeFilter),
    queryFn: async () => {
      const taskIdsAtFetchStart = new Set(
        useTaskStore.getState().tasks.map((task) => task.id)
      );
      const tasks = await unwrapCommand(commands.listTasks(activeFilter));

      // Preserve only tasks newly inserted while this request was in flight.
      // Pre-existing store entries can belong to a previously selected
      // project and must not be re-added after the scoped fetch completes.
      const currentStoreTasks = useTaskStore.getState().tasks;
      const fetchedIds = new Set(tasks.map((task) => task.id));
      const upsertedDuringFetch = currentStoreTasks.filter(
        (task) => !fetchedIds.has(task.id) && !taskIdsAtFetchStart.has(task.id)
      );

      return [...tasks, ...upsertedDuringFetch];
    },
  });

  useEffect(() => {
    if (query.data) setTasks(query.data);
  }, [query.data, setTasks]);

  return {
    tasks: query.data ?? storeTasks,
    isLoading: query.isLoading,
    error: query.error ? errorMessage(query.error) : null,
    refetch: () => {
      void query.refetch();
    },
  };
}

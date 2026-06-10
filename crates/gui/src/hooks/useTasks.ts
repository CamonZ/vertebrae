import { useQuery } from "@tanstack/react-query";
import { commands, type Task, type TaskFilterOptions } from "../bindings";
import { useProjectScopeGeneration } from "../stores/projectScopedStores";
import { errorMessage, queryClient, queryKeys, unwrapCommand } from "../query";

/**
 * Hook for fetching and managing the task list.
 *
 * TanStack Query owns the server-state cache for task list data.
 */
export function useTasks(filter?: TaskFilterOptions) {
  const activeFilter = filter ?? null;
  const projectScopeGeneration = useProjectScopeGeneration();
  const queryKey = queryKeys.tasks.list(projectScopeGeneration, activeFilter);

  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const taskIdsAtFetchStart = new Set(
        (queryClient.getQueryData<Task[]>(queryKey) ?? []).map(
          (task) => task.id
        )
      );
      const tasks = await unwrapCommand(commands.listTasks(activeFilter));

      // Preserve only tasks newly inserted while this request was in flight.
      // Pre-existing query entries can belong to a previously selected
      // project and must not be re-added after the scoped fetch completes.
      const currentQueryTasks =
        queryClient.getQueryData<Task[]>(queryKey) ?? [];
      const fetchedIds = new Set(tasks.map((task) => task.id));
      const upsertedDuringFetch = currentQueryTasks.filter(
        (task) => !fetchedIds.has(task.id) && !taskIdsAtFetchStart.has(task.id)
      );

      return [...tasks, ...upsertedDuringFetch];
    },
  });

  return {
    tasks: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error ? errorMessage(query.error) : null,
    refetch: () => {
      void query.refetch();
    },
  };
}

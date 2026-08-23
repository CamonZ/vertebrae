import { useQuery } from "@tanstack/react-query";
import { commands } from "../bindings";
import { useProjectScopeGeneration } from "../stores/projectScopedStores";
import {
  errorMessage,
  hydrateActiveTaskRunsFromTasks,
  queryKeys,
  unwrapCommand,
} from "../query";

const NO_TASK_SELECTED_KEY = "__vertebrae_no_task_selected__";

/**
 * Hook for fetching a single task.
 *
 * TanStack Query owns the server-state cache for task detail data.
 */
export function useTask(id: string | null | undefined) {
  const projectScopeGeneration = useProjectScopeGeneration();
  const taskId = id ?? NO_TASK_SELECTED_KEY;

  const query = useQuery({
    queryKey: queryKeys.tasks.detail(projectScopeGeneration, taskId),
    queryFn: async () => {
      const task = await unwrapCommand(commands.getTask(id!));
      hydrateActiveTaskRunsFromTasks([task], projectScopeGeneration);
      return task;
    },
    enabled: Boolean(id),
  });

  return {
    task: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error ? errorMessage(query.error) : null,
    refetch: () => {
      void query.refetch();
    },
  };
}

import { useQuery } from "@tanstack/react-query";
import { commands } from "../bindings";
import { useProjectScopeGeneration } from "../stores/projectScopedStores";
import { errorMessage, queryKeys, unwrapCommand } from "../query";

/**
 * Hook for fetching a single task.
 *
 * TanStack Query owns the server-state cache for task detail data.
 */
export function useTask(id: string | null | undefined) {
  const projectScopeGeneration = useProjectScopeGeneration();

  const query = useQuery({
    queryKey: queryKeys.tasks.detail(projectScopeGeneration, id ?? ""),
    queryFn: () => unwrapCommand(commands.getTask(id!)),
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

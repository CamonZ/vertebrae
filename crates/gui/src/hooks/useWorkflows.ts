import { useQuery } from "@tanstack/react-query";
import { commands } from "../bindings";
import { useProjectScopeGeneration } from "../stores/projectScopedStores";
import { errorMessage, queryKeys, unwrapCommand } from "../query";

/**
 * Hook for fetching and managing the workflow list.
 *
 * TanStack Query owns the server-state cache for workflow list data.
 */
export function useWorkflows() {
  const projectScopeGeneration = useProjectScopeGeneration();

  const query = useQuery({
    queryKey: queryKeys.workflows.list(projectScopeGeneration),
    queryFn: () => unwrapCommand(commands.listWorkflows()),
  });

  return {
    workflows: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error ? errorMessage(query.error) : null,
    refetch: () => {
      void query.refetch();
    },
  };
}

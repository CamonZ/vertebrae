import { useQuery } from "@tanstack/react-query";
import { commands } from "../bindings";
import { useProjectScopeGeneration } from "../stores/projectScopedStores";
import { errorMessage, queryKeys, unwrapCommand } from "../query";

/**
 * Hook for fetching a single workflow with its associated tasks.
 *
 * TanStack Query owns the server-state cache for workflow detail data.
 */
export function useWorkflow(id: string | null | undefined) {
  const projectScopeGeneration = useProjectScopeGeneration();

  const query = useQuery({
    queryKey: queryKeys.workflows.detail(projectScopeGeneration, id ?? ""),
    queryFn: () => unwrapCommand(commands.getWorkflowWithTasks(id!)),
    enabled: Boolean(id),
  });

  return {
    workflow: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error ? errorMessage(query.error) : null,
    refetch: () => {
      void query.refetch();
    },
  };
}

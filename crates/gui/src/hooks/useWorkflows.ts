import { useQuery } from "@tanstack/react-query";
import { commands } from "../bindings";
import { useProjectScopeGeneration } from "../stores/projectScopedStores";
import type { Workflow } from "../bindings";
import { errorMessage, queryKeys, unwrapCommand } from "../query";

// Stable fallback for no-data renders; see NO_TASKS in useTasks.ts.
const NO_WORKFLOWS: Workflow[] = [];

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
    workflows: query.data ?? NO_WORKFLOWS,
    isLoading: query.isLoading,
    error: query.error ? errorMessage(query.error) : null,
    refetch: () => {
      void query.refetch();
    },
  };
}

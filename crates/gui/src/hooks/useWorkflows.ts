import { useQuery } from "@tanstack/react-query";
import { commands } from "../bindings";
import { useProjectScopeGeneration } from "../stores/projectScopedStores";
import type { Workflow } from "../bindings";
import { errorMessage, queryClient, queryKeys, unwrapCommand } from "../query";

// Stable fallback for no-data renders; see NO_TASKS in useTasks.ts.
const NO_WORKFLOWS: Workflow[] = [];

/**
 * Hook for fetching and managing the workflow list.
 *
 * TanStack Query owns the server-state cache for workflow list data.
 */
export function useWorkflows() {
  const projectScopeGeneration = useProjectScopeGeneration();
  const queryKey = queryKeys.workflows.list(projectScopeGeneration);

  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      // A list response can predate a live creation, update, or deletion.
      // Fetch again if the cache changed while waiting, so the old baseline
      // cannot overwrite those events. Cancellation retires the whole loop.
      while (true) {
        const updates = queryClient.getQueryState(queryKey)?.dataUpdateCount;
        const workflows = await unwrapCommand(commands.listWorkflows());
        if (
          signal.aborted ||
          updates === queryClient.getQueryState(queryKey)?.dataUpdateCount
        ) {
          return workflows;
        }
      }
    },
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

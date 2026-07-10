import { useQuery } from "@tanstack/react-query";
import { commands } from "../bindings";
import type { Step } from "../bindings";
import { errorMessage, queryClient, queryKeys, unwrapCommand } from "../query";
import { useProjectScopeGeneration } from "../stores/projectScopedStores";

/**
 * Hook for fetching a single step with its configuration.
 * Reads from the generation-scoped TanStack Query cache so WebSocket updates
 * and normal fetches share one source of truth.
 *
 * @param stepId - The step ID to fetch. If null/undefined, no fetch is performed.
 * @returns Object containing step data, loading state, error state, and refetch function
 */
export function useStep(stepId: string | null | undefined) {
  const generation = useProjectScopeGeneration();
  const queryKey = queryKeys.steps.byId(generation, stepId ?? "");
  const query = useQuery({
    queryKey,
    queryFn: () => unwrapCommand(commands.getStep(stepId!)),
    enabled: Boolean(stepId),
  });

  /** Apply a full step payload received from a WebSocket event directly. */
  const applyUpdate = (data: Step) => {
    if (data.id)
      queryClient.setQueryData(queryKeys.steps.byId(generation, data.id), data);
  };

  return {
    step: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error ? errorMessage(query.error) : null,
    refetch: () => {
      void query.refetch();
    },
    applyUpdate,
  };
}

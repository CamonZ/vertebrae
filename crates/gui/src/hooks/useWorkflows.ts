import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { commands } from "../bindings";
import { useWorkflowStore } from "../stores";
import { useProjectScopeGeneration } from "../stores/projectScopedStores";
import { errorMessage, queryKeys, unwrapCommand } from "../query";

/**
 * Hook for fetching and managing the workflow list.
 *
 * TanStack Query owns the server-state cache. The Zustand write-through remains
 * as a compatibility bridge for views that still read workflows from the store.
 */
export function useWorkflows() {
  const projectScopeGeneration = useProjectScopeGeneration();
  const workflows = useWorkflowStore((state) => state.workflows);
  const setWorkflows = useWorkflowStore((state) => state.setWorkflows);

  const query = useQuery({
    queryKey: queryKeys.workflows.list(projectScopeGeneration),
    queryFn: () => unwrapCommand(commands.listWorkflows()),
  });

  useEffect(() => {
    if (query.data) setWorkflows(query.data);
  }, [query.data, setWorkflows]);

  return {
    workflows: query.data ?? workflows,
    isLoading: query.isLoading,
    error: query.error ? errorMessage(query.error) : null,
    refetch: () => {
      void query.refetch();
    },
  };
}

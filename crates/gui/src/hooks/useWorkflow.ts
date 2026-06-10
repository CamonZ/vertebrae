import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { commands } from "../bindings";
import { useWorkflowStore } from "../stores";
import { useProjectScopeGeneration } from "../stores/projectScopedStores";
import { errorMessage, queryKeys, unwrapCommand } from "../query";

/**
 * Hook for fetching a single workflow with its associated tasks.
 *
 * TanStack Query owns the server-state cache. The current-workflow store write
 * is retained while downstream detail views finish migrating.
 */
export function useWorkflow(id: string | null | undefined) {
  const projectScopeGeneration = useProjectScopeGeneration();
  const { currentWorkflow, setCurrentWorkflow, clearCurrentWorkflow } =
    useWorkflowStore();

  const query = useQuery({
    queryKey: queryKeys.workflows.detail(projectScopeGeneration, id ?? ""),
    queryFn: () => unwrapCommand(commands.getWorkflowWithTasks(id!)),
    enabled: Boolean(id),
  });

  useEffect(() => {
    if (!id) {
      clearCurrentWorkflow();
      return;
    }
    if (query.data) setCurrentWorkflow(query.data);
  }, [id, query.data, setCurrentWorkflow, clearCurrentWorkflow]);

  useEffect(() => {
    if (query.error) clearCurrentWorkflow();
  }, [query.error, clearCurrentWorkflow]);

  return {
    workflow: query.data ?? currentWorkflow,
    isLoading: query.isLoading,
    error: query.error ? errorMessage(query.error) : null,
    refetch: () => {
      void query.refetch();
    },
  };
}

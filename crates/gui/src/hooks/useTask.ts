import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { commands } from "../bindings";
import { useTaskStore } from "../stores";
import { useProjectScopeGeneration } from "../stores/projectScopedStores";
import { errorMessage, queryKeys, unwrapCommand } from "../query";

/**
 * Hook for fetching a single task.
 *
 * TanStack Query owns the server-state cache. The selected-task store write is
 * retained while detail panels and pop-outs finish migrating off store-backed
 * entity state.
 */
export function useTask(id: string | null | undefined) {
  const projectScopeGeneration = useProjectScopeGeneration();
  const { selectedTask, selectTask, clearSelection } = useTaskStore();

  const query = useQuery({
    queryKey: queryKeys.tasks.detail(projectScopeGeneration, id ?? ""),
    queryFn: () => unwrapCommand(commands.getTask(id!)),
    enabled: Boolean(id),
  });

  useEffect(() => {
    if (!id) {
      clearSelection();
      return;
    }
    if (query.data) selectTask(id, query.data);
  }, [id, query.data, selectTask, clearSelection]);

  useEffect(() => {
    if (query.error) clearSelection();
  }, [query.error, clearSelection]);

  return {
    task: query.data ?? (selectedTask?.id === id ? selectedTask : null),
    isLoading: query.isLoading,
    error: query.error ? errorMessage(query.error) : null,
    refetch: () => {
      void query.refetch();
    },
  };
}

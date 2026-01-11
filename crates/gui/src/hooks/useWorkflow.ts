import { useEffect, useState, useCallback } from "react";
import { commands } from "../bindings";
import { useWorkflowStore } from "../stores";

/**
 * Hook for fetching a single workflow with its associated tasks.
 * Automatically syncs the current workflow to the Zustand store.
 *
 * @param id - The workflow ID to fetch. If null/undefined, no fetch is performed.
 * @returns Object containing workflow data with tasks, loading state, error state, and refetch function
 */
export function useWorkflow(id: string | null | undefined) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { currentWorkflow, setCurrentWorkflow, clearCurrentWorkflow } =
    useWorkflowStore();

  const fetchWorkflow = useCallback(async () => {
    if (!id) {
      clearCurrentWorkflow();
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const result = await commands.getWorkflowWithTasks(id);
      if (result.status === "ok") {
        setCurrentWorkflow(result.data);
      } else {
        setError(result.error.message);
        clearCurrentWorkflow();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      clearCurrentWorkflow();
    } finally {
      setIsLoading(false);
    }
  }, [id, setCurrentWorkflow, clearCurrentWorkflow]);

  useEffect(() => {
    fetchWorkflow();
  }, [fetchWorkflow]);

  const refetch = useCallback(() => {
    fetchWorkflow();
  }, [fetchWorkflow]);

  return { workflow: currentWorkflow, isLoading, error, refetch };
}

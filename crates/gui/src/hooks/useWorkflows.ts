import { useEffect, useState, useCallback } from 'react';
import { commands } from '../bindings';
import { useWorkflowStore } from '../stores';

/**
 * Hook for fetching and managing the workflow list.
 * Automatically syncs fetched workflows to the Zustand store.
 *
 * @returns Object containing workflows array, loading state, error state, and refetch function
 */
export function useWorkflows() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { workflows, setWorkflows } = useWorkflowStore();

  const fetchWorkflows = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await commands.listWorkflows();
      if (result.status === 'ok') {
        setWorkflows(result.data);
      } else {
        setError(result.error.message);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsLoading(false);
    }
  }, [setWorkflows]);

  useEffect(() => {
    fetchWorkflows();
  }, [fetchWorkflows]);

  const refetch = useCallback(() => {
    fetchWorkflows();
  }, [fetchWorkflows]);

  return { workflows, isLoading, error, refetch };
}

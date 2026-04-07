import { useEffect, useState, useCallback } from "react";
import { commands } from "../bindings";
import type { Step } from "../bindings";
import { useStepStore } from "../stores";

/**
 * Hook for fetching a single step with its configuration.
 * Reads from the Zustand step store so WebSocket updates are reflected live.
 *
 * @param stepId - The step ID to fetch. If null/undefined, no fetch is performed.
 * @returns Object containing step data, loading state, error state, and refetch function
 */
export function useStep(stepId: string | null | undefined) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { selectedStep, selectStep, clearStepSelection } = useStepStore();

  const fetchStep = useCallback(async () => {
    if (!stepId) {
      clearStepSelection();
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const result = await commands.getStep(stepId);
      if (result.status === "ok") {
        selectStep(stepId, result.data);
      } else {
        setError(result.error.message);
        clearStepSelection();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      clearStepSelection();
    } finally {
      setIsLoading(false);
    }
  }, [stepId, selectStep, clearStepSelection]);

  useEffect(() => {
    fetchStep();
  }, [fetchStep]);

  const refetch = useCallback(() => {
    fetchStep();
  }, [fetchStep]);

  /** Apply a full step payload received from a WebSocket event directly. */
  const applyUpdate = useCallback((data: Step) => {
    selectStep(data.id ?? null, data);
  }, [selectStep]);

  return { step: selectedStep, isLoading, error, refetch, applyUpdate };
}

import { useEffect, useState, useCallback } from "react";
import { commands, type Step } from "../bindings";

/**
 * Hook for fetching a single step with its configuration.
 *
 * @param stepId - The step ID to fetch. If null/undefined, no fetch is performed.
 * @returns Object containing step data, loading state, error state, and refetch function
 */
export function useStep(stepId: string | null | undefined) {
  const [step, setStep] = useState<Step | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStep = useCallback(async () => {
    if (!stepId) {
      setStep(null);
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const result = await commands.getStep(stepId);
      if (result.status === "ok") {
        setStep(result.data);
      } else {
        setError(result.error.message);
        setStep(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep(null);
    } finally {
      setIsLoading(false);
    }
  }, [stepId]);

  useEffect(() => {
    fetchStep();
  }, [fetchStep]);

  const refetch = useCallback(() => {
    fetchStep();
  }, [fetchStep]);

  return { step, isLoading, error, refetch };
}

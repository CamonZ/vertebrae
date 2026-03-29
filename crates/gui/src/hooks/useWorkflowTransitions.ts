import { useEffect, useState, useCallback } from "react";
import type { WorkflowTransition } from "../bindings";
import { commands } from "../bindings";

export function useWorkflowTransitions() {
  const [transitions, setTransitions] = useState<WorkflowTransition[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchTransitions = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await commands.listWorkflowTransitions();
      if (result.status === "ok") {
        setTransitions(result.data);
      } else {
        setError(result.error.message);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTransitions();
  }, [fetchTransitions]);

  const refetch = useCallback(() => {
    fetchTransitions();
  }, [fetchTransitions]);

  return { transitions, isLoading, error, refetch };
}

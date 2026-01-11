import { useEffect, useState, useCallback } from "react";
import { commands, type TaskHierarchyNode } from "../bindings";

/**
 * Hook for fetching hierarchical task data as a tree structure.
 * Uses the getTaskHierarchy command to fetch parent-child relationships.
 *
 * @param rootId - Optional root task ID. If null, fetches all root-level tasks with their hierarchies.
 * @returns Object containing hierarchy array, loading state, error state, and refetch function
 */
export function useTaskHierarchy(rootId?: string | null) {
  const [hierarchy, setHierarchy] = useState<TaskHierarchyNode[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchHierarchy = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await commands.getTaskHierarchy(rootId ?? null);
      if (result.status === "ok") {
        setHierarchy(result.data);
      } else {
        setError(result.error.message);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsLoading(false);
    }
  }, [rootId]);

  useEffect(() => {
    fetchHierarchy();
  }, [fetchHierarchy]);

  const refetch = useCallback(() => {
    fetchHierarchy();
  }, [fetchHierarchy]);

  return { hierarchy, isLoading, error, refetch };
}

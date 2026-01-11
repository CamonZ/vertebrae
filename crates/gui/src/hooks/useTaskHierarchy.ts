import { useEffect, useState, useCallback, useMemo } from "react";
import { commands, type TaskHierarchyNode, type TaskFilterOptions } from "../bindings";

/**
 * Check if a task matches the search query (case-insensitive).
 * Searches in task ID and title.
 */
function taskMatchesSearch(node: TaskHierarchyNode, search: string): boolean {
  const lowerSearch = search.toLowerCase();
  return (
    node.task.id.toLowerCase().includes(lowerSearch) ||
    node.task.title.toLowerCase().includes(lowerSearch)
  );
}

/**
 * Recursively filter hierarchy nodes based on search.
 * Returns nodes that match the search OR have descendants that match.
 * Preserves the tree structure by keeping parent nodes if any child matches.
 */
function filterHierarchyBySearch(
  nodes: TaskHierarchyNode[],
  search: string
): TaskHierarchyNode[] {
  if (!search || search.trim() === "") {
    return nodes;
  }

  return nodes
    .map((node) => {
      // Recursively filter children first
      const filteredChildren = filterHierarchyBySearch(node.children, search);

      // Check if this node matches OR any of its children match
      const nodeMatches = taskMatchesSearch(node, search);
      const hasMatchingChildren = filteredChildren.length > 0;

      if (nodeMatches || hasMatchingChildren) {
        // Return node with filtered children
        return {
          ...node,
          children: filteredChildren,
        };
      }

      // Node doesn't match and has no matching children
      return null;
    })
    .filter((node): node is TaskHierarchyNode => node !== null);
}

/**
 * Check if a task matches status filter.
 */
function taskMatchesStatus(
  node: TaskHierarchyNode,
  statuses: TaskFilterOptions["statuses"]
): boolean {
  if (!statuses || statuses.length === 0) return true;
  return statuses.includes(node.task.status);
}

/**
 * Check if a task matches level filter.
 */
function taskMatchesLevel(
  node: TaskHierarchyNode,
  levels: TaskFilterOptions["levels"]
): boolean {
  if (!levels || levels.length === 0) return true;
  return levels.includes(node.task.level);
}

/**
 * Recursively filter hierarchy nodes based on status and level.
 * Preserves the tree structure by keeping parent nodes if any child matches.
 */
function filterHierarchyByFilters(
  nodes: TaskHierarchyNode[],
  filters: TaskFilterOptions
): TaskHierarchyNode[] {
  const hasFilters =
    (filters.statuses && filters.statuses.length > 0) ||
    (filters.levels && filters.levels.length > 0);

  if (!hasFilters) {
    return nodes;
  }

  return nodes
    .map((node) => {
      // Recursively filter children first
      const filteredChildren = filterHierarchyByFilters(node.children, filters);

      // Check if this node matches filters
      const nodeMatches =
        taskMatchesStatus(node, filters.statuses) &&
        taskMatchesLevel(node, filters.levels);

      const hasMatchingChildren = filteredChildren.length > 0;

      if (nodeMatches || hasMatchingChildren) {
        // Return node with filtered children
        return {
          ...node,
          children: filteredChildren,
        };
      }

      // Node doesn't match and has no matching children
      return null;
    })
    .filter((node): node is TaskHierarchyNode => node !== null);
}

/**
 * Hook for fetching hierarchical task data as a tree structure.
 * Uses the getTaskHierarchy command to fetch parent-child relationships.
 * Supports client-side filtering by search, status, and level.
 *
 * @param rootId - Optional root task ID. If null, fetches all root-level tasks with their hierarchies.
 * @param filter - Optional filter options for client-side filtering.
 * @returns Object containing hierarchy array, loading state, error state, and refetch function
 */
export function useTaskHierarchy(
  rootId?: string | null,
  filter?: TaskFilterOptions
) {
  const [rawHierarchy, setRawHierarchy] = useState<TaskHierarchyNode[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchHierarchy = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await commands.getTaskHierarchy(rootId ?? null);
      if (result.status === "ok") {
        setRawHierarchy(result.data);
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

  // Apply client-side filtering
  const hierarchy = useMemo(() => {
    if (!filter) {
      return rawHierarchy;
    }

    // Apply search filter first
    let filtered = rawHierarchy;
    if (filter.search && filter.search.trim() !== "") {
      filtered = filterHierarchyBySearch(filtered, filter.search);
    }

    // Apply status/level filters
    filtered = filterHierarchyByFilters(filtered, filter);

    return filtered;
  }, [rawHierarchy, filter]);

  return { hierarchy, isLoading, error, refetch };
}

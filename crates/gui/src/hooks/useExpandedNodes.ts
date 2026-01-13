import { useState, useCallback, useMemo } from "react";

/**
 * Hook for managing which tree nodes are expanded/collapsed.
 * Persists expansion state across data updates.
 *
 * @returns Object containing expanded node IDs, toggle and set methods
 */
export function useExpandedNodes() {
  const [expandedNodeIds, setExpandedNodeIds] = useState<Set<string>>(new Set());

  /**
   * Toggle a node's expanded state
   */
  const toggleNode = useCallback((nodeId: string) => {
    setExpandedNodeIds((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  }, []);

  /**
   * Set a node as expanded
   */
  const setNodeExpanded = useCallback((nodeId: string, expanded: boolean) => {
    setExpandedNodeIds((prev) => {
      const next = new Set(prev);
      if (expanded) {
        next.add(nodeId);
      } else {
        next.delete(nodeId);
      }
      return next;
    });
  }, []);

  /**
   * Check if a node is expanded
   */
  const isNodeExpanded = useCallback(
    (nodeId: string): boolean => {
      return expandedNodeIds.has(nodeId);
    },
    [expandedNodeIds]
  );

  /**
   * Reset all expanded nodes
   */
  const resetExpandedNodes = useCallback(() => {
    setExpandedNodeIds(new Set());
  }, []);

  /**
   * Expand all nodes (for a given set of IDs)
   */
  const expandAll = useCallback((nodeIds: string[]) => {
    setExpandedNodeIds(new Set(nodeIds));
  }, []);

  return useMemo(
    () => ({
      expandedNodeIds,
      toggleNode,
      setNodeExpanded,
      isNodeExpanded,
      resetExpandedNodes,
      expandAll,
    }),
    [expandedNodeIds, toggleNode, setNodeExpanded, isNodeExpanded, resetExpandedNodes, expandAll]
  );
}

import { useState, useCallback, useMemo } from "react";

/**
 * Tracks which collapsed done-leaf summary rows are expanded, keyed by parent
 * task id. Mirrors the {@link useExpandedNodes} pattern: a plain in-memory
 * `Set<string>` that is intentionally NOT persisted across sessions — showing
 * a fold of completed tasks is a transient, per-view affordance.
 */
export function useSummaryExpanded() {
  const [summaryExpandedIds, setSummaryExpandedIds] = useState<Set<string>>(
    new Set()
  );

  const toggleSummary = useCallback((parentId: string) => {
    setSummaryExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(parentId)) {
        next.delete(parentId);
      } else {
        next.add(parentId);
      }
      return next;
    });
  }, []);

  return useMemo(
    () => ({ summaryExpandedIds, toggleSummary }),
    [summaryExpandedIds, toggleSummary]
  );
}

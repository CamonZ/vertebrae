import { useCallback, useMemo, useState } from "react";

const NO_VIEWED: ReadonlySet<string> = new Set();

/**
 * Files marked viewed, in marking order. Marks belong to one comparison
 * (`comparisonKey`): another base or target starts fresh, and files that
 * leave the comparison (`present`) drop out.
 */
export function useViewedPaths(
  comparisonKey: string,
  present: ReadonlyMap<string, unknown>
) {
  const [viewedState, setViewedState] = useState<{
    key: string;
    paths: ReadonlySet<string>;
  }>({ key: comparisonKey, paths: NO_VIEWED });

  const viewedPaths = useMemo<ReadonlySet<string>>(() => {
    if (viewedState.key !== comparisonKey) return NO_VIEWED;
    const kept = [...viewedState.paths].filter((path) => present.has(path));
    return kept.length === viewedState.paths.size
      ? viewedState.paths
      : new Set(kept);
  }, [viewedState, comparisonKey, present]);

  const setViewed = useCallback(
    (path: string, viewed: boolean) =>
      setViewedState((current) => {
        const paths = current.key === comparisonKey ? current.paths : NO_VIEWED;
        if (paths.has(path) === viewed)
          return current.key === comparisonKey
            ? current
            : { key: comparisonKey, paths };
        const next = new Set(paths);
        if (viewed) next.add(path);
        else next.delete(path);
        return { key: comparisonKey, paths: next };
      }),
    [comparisonKey]
  );

  return { viewedPaths, setViewed };
}

import { useEffect, useMemo, useState } from "react";
import {
  commands,
  type ComparisonSnapshot,
  type GithubFailure,
  type GithubPrReviewThreads,
  type GithubThreadPosition,
} from "../../../../bindings";
import type { PrReviewThreadsState } from "../../../../stores/worktreePrStore";
import { settleGithubCommand } from "../../../../stores/worktreePrStore";
import {
  buildReviewModel,
  mappingRequest,
  type GithubReviewModel,
  type LineShown,
} from "./model";

export interface GithubPlacement {
  /** The linked PR; null without one. */
  prNumber: number | null;
  /** Threads placed on the shown comparison; null until both are known. */
  model: GithubReviewModel | null;
  loading: boolean;
  error: GithubFailure | null;
}

interface Placed {
  source: GithubPrReviewThreads;
  comparison: string;
  /** The Changes load the placement was asked for. */
  generation: number;
  positions: readonly GithubThreadPosition[];
}

/**
 * The linked PR's review threads (read with the PR by `prSync`), placed on
 * the comparison Changes shows. Placement is local Git work, redone whenever
 * the threads, the comparison or the loaded changes (`generation`: local
 * edits) change, never asking GitHub again.
 */
export function useGithubPlacement(
  worktreePath: string,
  prNumber: number | null,
  threads: PrReviewThreadsState,
  comparison: ComparisonSnapshot | null,
  generation: number,
  shown: LineShown
): GithubPlacement {
  const loaded = prNumber === null ? null : threads.data;
  const [placed, setPlaced] = useState<Placed | null>(null);
  const [placeError, setPlaceError] = useState<{
    source: GithubPrReviewThreads;
    failure: GithubFailure;
  } | null>(null);
  const comparisonKey = comparison ? JSON.stringify(comparison) : null;
  // Keyed by value: Changes hands over a new snapshot object on each load.
  const request = useMemo(
    () =>
      loaded && comparisonKey !== null
        ? mappingRequest(
            loaded.headOid,
            loaded.baseOid,
            JSON.parse(comparisonKey) as ComparisonSnapshot,
            loaded.threads
          )
        : null,
    [loaded, comparisonKey]
  );

  useEffect(() => {
    if (!request || !loaded || comparisonKey === null) return;
    let cancelled = false;
    void settleGithubCommand(() =>
      commands.mapWorktreePrReviewThreads(worktreePath, request)
    ).then((outcome) => {
      if (cancelled) return;
      if (!outcome.ok) {
        setPlaceError({ source: loaded, failure: outcome.failure });
        return;
      }
      setPlaceError(null);
      setPlaced({
        source: loaded,
        comparison: comparisonKey,
        generation,
        positions: outcome.data,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [worktreePath, request, loaded, comparisonKey, generation]);

  // Positions from an earlier comparison would draw threads on wrong lines;
  // positions of earlier threads or an earlier load of this comparison are
  // still right for what they cover until the new placement lands.
  const current =
    placed && loaded && placed.comparison === comparisonKey ? placed : null;
  const model = useMemo(
    () =>
      current && loaded && prNumber !== null
        ? buildReviewModel(
            prNumber,
            loaded.threads,
            current.positions,
            loaded.truncated,
            shown
          )
        : null,
    [current, loaded, prNumber, shown]
  );
  const stale =
    !!loaded &&
    (!current ||
      current.source !== loaded ||
      current.generation !== generation) &&
    placeError?.source !== loaded;
  return {
    prNumber,
    model,
    loading: prNumber !== null && (threads.loading || stale),
    error:
      prNumber === null
        ? null
        : (threads.error ??
          (placeError?.source === loaded ? placeError.failure : null)),
  };
}

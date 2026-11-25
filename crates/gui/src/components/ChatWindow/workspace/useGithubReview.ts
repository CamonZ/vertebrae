import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  commands,
  type ComparisonSnapshot,
  type GithubFailure,
  type GithubThreadPosition,
} from "../../../bindings";
import { useWorktreePrAssociation } from "../../../hooks/useWorktreePrAssociation";
import { errorMessage } from "../../../query";
import { useGithubReviewThreads } from "../../../stores/githubReviewThreadsStore";
import { linkedPullRequest } from "../../../stores/worktreePrStore";
import {
  buildReviewModel,
  mappingRequest,
  type GithubReviewModel,
  type LineShown,
  type PlacedThread,
  type ThreadMarker,
} from "./githubReview";

export interface GithubReview {
  /** The linked PR; null without one (no GitHub reads then). */
  prNumber: number | null;
  /** Threads placed on the shown comparison; null until both are known. */
  model: GithubReviewModel | null;
  loading: boolean;
  error: GithubFailure | null;
  refresh(): void;
}

/**
 * The linked PR's review threads, placed on the comparison Changes shows.
 * GitHub is read on its own cadence (the shared threads store); placement is
 * local Git work, redone whenever the threads or the shown changes change
 * (`generation` counts Changes loads, so local edits re-place threads
 * without asking GitHub again).
 */
export function useGithubReview(
  worktreePath: string,
  branch: string | null,
  comparison: ComparisonSnapshot | null,
  generation: number,
  shown: LineShown
): GithubReview {
  const association = useWorktreePrAssociation(worktreePath, branch);
  const prNumber = linkedPullRequest(association.association)?.number ?? null;
  const entry = useGithubReviewThreads(worktreePath, branch, prNumber);
  const loaded = entry.threads;
  const [placed, setPlaced] = useState<{
    source: typeof loaded;
    comparison: string;
    positions: readonly GithubThreadPosition[];
  } | null>(null);
  const [placeError, setPlaceError] = useState<GithubFailure | null>(null);
  const comparisonKey = comparison ? JSON.stringify(comparison) : null;

  useEffect(() => {
    if (!loaded || !comparison || comparisonKey === null) return;
    let cancelled = false;
    const request = mappingRequest(
      loaded.headOid,
      loaded.baseOid,
      comparison,
      loaded.threads
    );
    commands
      .mapWorktreePrReviewThreads(worktreePath, request)
      .then((result) => {
        if (cancelled) return;
        if (result.status === "error") {
          setPlaceError(result.error);
          return;
        }
        setPlaceError(null);
        setPlaced({
          source: loaded,
          comparison: comparisonKey,
          positions: result.data,
        });
      })
      .catch((cause: unknown) => {
        if (!cancelled)
          setPlaceError({
            kind: "other",
            message: errorMessage(cause),
            retryAfterSecs: null,
          });
      });
    return () => {
      cancelled = true;
    };
    // `comparison` is read through its key; `generation` re-places after a
    // reload of the same comparison (local edits).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktreePath, loaded, comparisonKey, generation]);

  // Positions from an earlier comparison would draw threads on wrong lines;
  // positions of earlier threads on this comparison are still right for the
  // threads they cover until the new placement lands.
  const current =
    placed && loaded && prNumber !== null && placed.comparison === comparisonKey
      ? placed
      : null;
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
  return {
    prNumber,
    model,
    loading: entry.loading || (!!loaded && !current),
    error: entry.error ?? placeError,
    refresh: entry.refresh,
  };
}

/** What Changes needs to draw and drive the GitHub threads on its diff. */
export interface GithubDiffThreads {
  model: GithubReviewModel;
  /** Threads expanded inline (under their line, or a file's outdated group). */
  openThreads: ReadonlySet<string>;
  /** The thread whose card takes focus when it renders. */
  focusThreadId: string | null;
  /** That card took focus. */
  focused(): void;
  /** Expand (with focus in its first card) or collapse a marker's threads. */
  toggleMarker(marker: ThreadMarker): void;
  /** Expand or collapse a file's outdated threads; `opener` gets focus back. */
  toggleOutdated(path: string, opener: HTMLElement): void;
  /**
   * Close one card. True when focus went back to the control that opened it
   * (a rail entry or Outdated pill); else the caller returns it to the marker.
   */
  closeThread(threadId: string): boolean;
}

/**
 * Which GitHub threads are expanded in Changes and who opened them, kept by
 * Changes itself so switching comparisons (which remounts the diff) keeps
 * them open.
 */
export function useGithubThreadViews(model: GithubReviewModel | null) {
  const [openThreads, setOpenThreads] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [focusThreadId, setFocusThreadId] = useState<string | null>(null);
  const openers = useRef(new Map<string, HTMLElement>());

  const open = useCallback(
    (ids: readonly string[], opener: HTMLElement | null, focus: boolean) => {
      for (const id of ids) {
        if (opener) openers.current.set(id, opener);
        else openers.current.delete(id);
      }
      setOpenThreads((current) => new Set([...current, ...ids]));
      setFocusThreadId(focus ? (ids[0] ?? null) : null);
    },
    []
  );
  const close = useCallback((ids: readonly string[]) => {
    setOpenThreads((current) => {
      const next = new Set(current);
      for (const id of ids) next.delete(id);
      return next;
    });
    setFocusThreadId(null);
  }, []);

  const views = useMemo<GithubDiffThreads | null>(() => {
    if (!model) return null;
    return {
      model,
      openThreads,
      focusThreadId,
      focused: () => setFocusThreadId(null),
      toggleMarker: (marker) => {
        const ids = marker.threads.map(({ thread }) => thread.id);
        if (ids.some((id) => openThreads.has(id))) close(ids);
        else open(ids, null, true);
      },
      toggleOutdated: (path, opener) => {
        const ids = (model.outdatedByPath.get(path) ?? []).map(
          ({ thread }) => thread.id
        );
        if (ids.some((id) => openThreads.has(id))) close(ids);
        else open(ids, opener, true);
      },
      closeThread: (threadId) => {
        const opener = openers.current.get(threadId);
        openers.current.delete(threadId);
        close([threadId]);
        if (opener?.isConnected) {
          opener.focus({ preventScroll: true });
          return true;
        }
        return false;
      },
    };
  }, [model, openThreads, focusThreadId, open, close]);

  /** Show one thread from the Review rail: `opener` gets focus back. */
  const reveal = useCallback(
    (placed: PlacedThread, opener: HTMLElement) => {
      const ids =
        placed.kind === "outdated" && model
          ? (model.outdatedByPath.get(placed.thread.path) ?? []).map(
              ({ thread }) => thread.id
            )
          : [placed.thread.id];
      open(ids, opener, true);
      setFocusThreadId(placed.thread.id);
    },
    [model, open]
  );
  return { views, reveal, close };
}

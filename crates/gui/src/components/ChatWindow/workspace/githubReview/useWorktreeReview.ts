import { useCallback, useMemo, useRef, useState, type RefObject } from "react";
import type { ComparisonSnapshot, WorktreeChange } from "../../../../bindings";
import type { WorktreePr } from "../../../../hooks/useWorktreePr";
import type { ReviewEntry } from "../PrAssociationBar";
import { hunksShow, type LineShown, type PlacedThread } from "./model";
import { useGithubPlacement } from "./useGithubPlacement";
import { useRailFocus, useReviewController } from "./useReviewController";

/** Below this Changes width, opening the rail folds the file list. */
const RAIL_WITH_FILES_MIN_WIDTH = 960;

interface HunkSpan {
  additionStart: number;
  additionCount: number;
  deletionStart: number;
  deletionCount: number;
}

/**
 * Changes' GitHub review: the linked PR's threads placed on the shown
 * comparison, the controller for what is expanded and where focus goes,
 * the Review rail's open state, and the review bar's entry into it.
 */
export function useWorktreeReview({
  worktreePath,
  prBranch,
  pr,
  comparison,
  generation,
  files,
  hunksByFile,
  reviewOpen,
  setReviewOpen,
  pane,
  filesOpen,
  hideFiles,
  jumpToFile,
}: {
  worktreePath: string;
  prBranch: string | null;
  pr: WorktreePr;
  comparison: ComparisonSnapshot | null;
  generation: number;
  files: readonly WorktreeChange[];
  /** Each changed file's hunks, in `files` order. */
  hunksByFile: readonly (readonly HunkSpan[])[];
  reviewOpen: boolean;
  setReviewOpen(open: boolean): void;
  pane: RefObject<HTMLElement | null>;
  filesOpen: boolean;
  hideFiles(): void;
  jumpToFile(
    path: string,
    focusHeader?: boolean,
    location?: { line: number; side: "old" | "new" }
  ): void;
}) {
  const prNumber =
    prBranch && pr.association?.status === "linked"
      ? pr.association.pr.number
      : null;
  // Rows the diff shows, as it reports them (revealed context included);
  // until then each file's hunks. A thread elsewhere is read from the rail.
  const [reported, setReported] = useState<LineShown | null>(null);
  const onLinesShown = useCallback(
    (shown: LineShown) => setReported(() => shown),
    []
  );
  const hunkShown = useMemo<LineShown>(() => {
    const hunks = new Map(
      files.map((file, index) => [file.path, hunksByFile[index] ?? []])
    );
    return (path, side, line) => hunksShow(hunks.get(path) ?? [], side, line);
  }, [files, hunksByFile]);
  const placement = useGithubPlacement(
    worktreePath,
    prNumber,
    pr.reviewThreads,
    comparison,
    generation,
    reported ?? hunkShown
  );

  const railRef = useRef<HTMLElement>(null);
  // A narrow Changes pane lays the rail over the diff (githubReview.css).
  const railCovers = useCallback(
    () =>
      !!railRef.current &&
      getComputedStyle(railRef.current).position === "absolute",
    []
  );
  /** A rail entry: shows its thread in the diff, if the diff has it. */
  const showInDiff = useCallback(
    (placed: PlacedThread): boolean => {
      const path = placed.thread.anchor.path;
      if (!files.some((file) => file.path === path)) return false;
      if (placed.kind === "line" && placed.inDiff)
        jumpToFile(path, false, {
          line: placed.line,
          side: placed.side === "deletions" ? "old" : "new",
        });
      else if (placed.kind === "outdated") jumpToFile(path);
      else return false;
      // Otherwise the rail would cover the thread it just showed.
      if (railCovers()) setReviewOpen(false);
      return true;
    },
    [files, jumpToFile, railCovers, setReviewOpen]
  );
  const controller = useReviewController(
    placement.model,
    pane,
    showInDiff,
    railCovers
  );

  const showRail = reviewOpen && !!prBranch;
  useRailFocus(showRail, railRef, controller.focusTarget);
  const toggleRail = () => {
    if (
      !reviewOpen &&
      filesOpen &&
      (pane.current?.clientWidth ?? Infinity) < RAIL_WITH_FILES_MIN_WIDTH
    )
      hideFiles();
    setReviewOpen(!reviewOpen);
  };

  const review: ReviewEntry | undefined =
    prNumber === null
      ? undefined
      : {
          openCount: pr.reviewThreads.data ? pr.openThreads : null,
          status: pr.reviewThreads.data
            ? "ready"
            : pr.reviewThreads.error
              ? "failed"
              : "loading",
          open: showRail,
          onToggle: toggleRail,
        };

  return {
    placement,
    diff: controller.diff,
    rail: controller.rail,
    railRef,
    showRail,
    closeRail: () => setReviewOpen(false),
    review,
    onLinesShown,
  };
}

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { ComparisonSnapshot, WorktreeChange } from "../../../../bindings";
import type { WorktreePr } from "../../../../hooks/useWorktreePr";
import type { DiffCursor } from "../../../../stores/chatSideColumnStore";
import { DIFF_CURSOR_HOST_ATTRIBUTE } from "../../../thread/toolChange/diffCursor";
import type { DiscussionValue } from "../../selectionDiscussionState";
import type { ReviewEntry } from "../PrAssociationBar";
import {
  hunksShow,
  stepThread,
  type GithubReviewModel,
  type LineShown,
  type PlacedThread,
  type ThreadStepFrom,
} from "./model";
import { useGithubPlacement } from "./useGithubPlacement";
import {
  REVIEW_ENTRY_ATTRIBUTE,
  useRailFocus,
  useReviewController,
} from "./useReviewController";

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

  /**
   * Show a GitHub thread where it can be read (the diff, else the Review
   * rail). "pending" until the threads are placed; "missing" when the PR no
   * longer has it.
   */
  const revealThread = (
    githubThreadId: string
  ): "shown" | "pending" | "missing" => {
    const { model } = placement;
    if (!model) return "pending";
    const placed = model.byThread.get(githubThreadId);
    if (!placed) return "missing";
    if (controller.reveal(placed) === "rail" && !reviewOpen) toggleRail();
    return "shown";
  };

  /**
   * `[` (-1) or `]` (1): the previous or next thread, shown with focus in its
   * card (the Review rail opens for one the diff cannot show). False when
   * there is none that way.
   */
  const lastStepped = useRef<string | null>(null);
  const stepThreads = (from: ThreadStepFrom, direction: -1 | 1): boolean => {
    const { model } = placement;
    if (!model) return false;
    // Stepping again from outside the threads continues from the last one.
    const start = from ?? lastThread(model, lastStepped.current);
    const next = stepThread(model, start, direction);
    if (!next) return false;
    lastStepped.current = next.thread.id;
    const fromId = start?.kind === "thread" ? start.id : null;
    if (controller.step(fromId, next) === "rail" && !reviewOpen) toggleRail();
    return true;
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
    revealThread,
    stepThreads,
    review,
    onLinesShown,
  };
}

function lastThread(
  model: GithubReviewModel,
  id: string | null
): ThreadStepFrom {
  return id && model.byThread.has(id) ? { kind: "thread", id } : null;
}

/**
 * Show the GitHub thread a discussion asks to see (from Discussions or its
 * attachment chip), in the diff or the Review rail, once the threads are
 * placed.
 */
export function useThreadRevealRequests(
  review: Pick<
    ReturnType<typeof useWorktreeReview>,
    "placement" | "revealThread"
  >,
  discussion: Pick<DiscussionValue, "reveal" | "revealed"> | null
): void {
  const request = discussion?.reveal ?? null;
  const placed = review.placement.model;
  const latest = useRef({ discussion, revealThread: review.revealThread });
  latest.current = { discussion, revealThread: review.revealThread };
  useEffect(() => {
    const { discussion, revealThread } = latest.current;
    if (!request || !discussion) return;
    const shown = revealThread(request.githubThreadId);
    if (shown !== "pending") discussion.revealed(request.nonce);
  }, [request, placed]);
}

/**
 * Where `[`/`]` step from: the GitHub thread card or rail entry with focus,
 * else the line cursor when the diff has focus, else the last thread
 * stepped to (null).
 */
export function stepOrigin(
  origin: HTMLElement,
  cursor: DiffCursor
): ThreadStepFrom {
  const thread =
    origin.closest<HTMLElement>(".gh-thread[data-thread-id]")?.dataset
      .threadId ??
    origin
      .closest<HTMLElement>(`[${REVIEW_ENTRY_ATTRIBUTE}]`)
      ?.getAttribute(REVIEW_ENTRY_ATTRIBUTE);
  if (thread) return { kind: "thread", id: thread };
  if (cursor && origin.closest(`[${DIFF_CURSOR_HOST_ATTRIBUTE}]`))
    return { kind: "line", path: cursor.path, line: cursor.range.end };
  return null;
}

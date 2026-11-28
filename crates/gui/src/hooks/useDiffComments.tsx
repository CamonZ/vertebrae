import {
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  type HTMLAttributes,
  type KeyboardEvent,
  type RefObject,
} from "react";
import {
  SelectionDiscussionActionsContext,
  SelectionDiscussionAnchorsContext,
  SelectionDiscussionSelectionContext,
} from "../components/ChatWindow/selectionDiscussionState";
import {
  captureCodeSelection,
  drawnOn,
  type CodeSelection,
} from "../components/ChatWindow/selectionDiscussions";
import { supportsInlineDiscussion } from "../components/ChatWindow/reviewAnchors";
import type {
  DiffLineAnnotation,
  SelectedLineRange,
  SelectionSide,
} from "@pierre/diffs";
import {
  DIFF_CURSOR_ENTRY_ATTRIBUTE,
  DIFF_CURSOR_HOST_ATTRIBUTE,
  cursorSide,
  gapScrollPoint,
  lineCursor,
  moveCursor,
  moveToLandmark,
  selectedCode,
  switchCursorSide,
  type CursorPoint,
  type CursorView,
  type DiffCursor,
  type DiffLayout,
  type GapCursor,
} from "../components/thread/toolChange/diffCursor";
import {
  revealGap,
  type FileContext,
  type GapReach,
  type GapReveal,
} from "../components/thread/toolChange/diffGaps";
import {
  DIFF_COMMENT_KEYS,
  DISCUSSION_COLLAPSE_SHORTCUT,
  DISCUSSION_OPEN_KEY,
  matchesChatShortcut,
} from "../components/ChatWindow/chatShortcuts";
import {
  DiffCommentThread,
  type ReviewAnnotation,
} from "../components/thread/toolChange/DiffCommentThread";
import { DiffReviewContext } from "../components/thread/toolChange/DiffReviewContext";
import type { ReviewSurface } from "../components/thread/toolChange/diffComments";
import type { CommentedRange } from "../components/thread/toolChange/commentedLines";
import {
  canonicalPath,
  resolveSelection,
  type FilePatch,
  type LineSpan,
} from "../components/thread/toolChange/diffLineMapper";
import type { DiffCommentHome } from "../components/ChatWindow/assistantTextComments";

export type ReviewDiffAnnotation = DiffLineAnnotation<ReviewAnnotation>;

interface Draft {
  path: string;
  span: LineSpan;
  anchor: CodeSelection;
  range: SelectedLineRange;
}

export interface DiffCommentsApi {
  /** Review is available here (a ChatWindow provides pending comments). */
  enabled: boolean;
  /** Pierre annotations for one file, stable until its comments change. */
  annotationsFor(path: string): ReviewDiffAnnotation[];
  /** Explicit Comment action: open the composer for the selected lines. */
  openComposer(path: string, range: SelectedLineRange): void;
  /**
   * The user's line selection (click, drag or shift-click on line numbers) in
   * one file, for Pierre's controlled `selectedLines`; null when none. The
   * selection stays highlighted until the comment is submitted.
   */
  selectedLinesFor(path: string): SelectedLineRange | null;
  /** Pierre's selection-end notification for one file. */
  onSelectionChange(path: string, range: SelectedLineRange | null): void;
  /** Retire a file's transient selection/composer when its body is hidden. */
  clearInteraction(path: string): void;
  /**
   * Props for the element that owns the keyboard line cursor. Spread them on
   * the diff group; its `ref` is where Esc from the composer returns focus.
   */
  keyboardProps: HTMLAttributes<HTMLDivElement> & {
    ref: RefObject<HTMLDivElement | null>;
  };
  renderAnnotation(annotation: { metadata: ReviewAnnotation }): ReactNode;
  /**
   * The lines each comment and inline discussion in one file is about, to
   * highlight beside their cards; stable until those change.
   */
  commentedRangesFor(path: string): readonly CommentedRange[];
  /** The keyboard cursor when it rests on a collapsed gap; null otherwise. */
  gapCursor: GapCursor | null;
}

const NONE: ReviewDiffAnnotation[] = [];
const NO_RANGES: readonly CommentedRange[] = [];

export interface DiffCursorOptions {
  /** How the surface lays out rows; split diffs have a column per side. */
  layout?: DiffLayout;
  /** The keyboard cursor moved to this line; scroll it into view. */
  onCursorMove?(path: string, line: number, side: SelectionSide): void;
  /**
   * Leave the surface for the main chat input: Esc on a single-line cursor,
   * and after sending a selection to the main chat.
   */
  onExit?(): void;
  /** `v`: mark a file as viewed (or unviewed, from its heading). */
  onToggleViewed?(path: string): void;
  /**
   * PgUp/PgDn (⇧ extends the range): the surface scrolls a page in
   * `direction` and moves the line cursor with it.
   */
  page?(direction: -1 | 1, extend: boolean): void;
  /**
   * A file's collapsed gaps and revealed lines. Gaps become cursor rows only
   * where this is provided (with `onRevealGap`).
   */
  context?(path: string): FileContext | undefined;
  /** ↵ on a gap: show these lines of gap `gap`. */
  onRevealGap?(path: string, gap: number, reveal: GapReveal): void;
  /**
   * The line cursor and its selection as a state pair, when the caller keeps
   * it (a surface that remounts in place); else the hook holds its own.
   */
  selectionState?: readonly [
    DiffSelection | null,
    Dispatch<SetStateAction<DiffSelection | null>>,
  ];
  /** More lines ⌥↑/⌥↓ stop at, beside comments and discussions. */
  marks?(path: string): readonly { side: SelectionSide; line: number }[];
  /**
   * `o` on a line without a discussion of its own: open what the surface
   * has there. True when it did.
   */
  onOpenAt?(path: string, side: SelectionSide, line: number): boolean;
}

export interface DiffSelection {
  path: string;
  range: SelectedLineRange;
}

/** ↵ reveals a section toward the arrival, ⌥↵ one at the other end. */
function gapReach(event: KeyboardEvent<HTMLDivElement>): GapReach | null {
  if (event.key !== "Enter" || event.metaKey || event.ctrlKey) return null;
  if (event.shiftKey) return null;
  return event.altKey ? "other" : "batch";
}


function writeClipboard(text: string) {
  navigator.clipboard.writeText(text).catch((error: unknown) => {
    console.error("Failed to copy selected code", error);
  });
}

function hasTextSelection(): boolean {
  const selection = document.getSelection();
  return !!selection && !selection.isCollapsed;
}

/**
 * Review props for one diff surface: annotations for the comments placed on
 * it, the gutter composer, and the annotation renderer. Kept apart from
 * `usePierreDiffOptions`, which only carries appearance.
 *
 * `files` are the parsed patch files the surface renders; `toolName` labels
 * comments written on a tool-call surface.
 */
export function useDiffComments(
  surface: ReviewSurface,
  files: readonly FilePatch[],
  toolName?: string,
  cursor: DiffCursorOptions = {}
): DiffCommentsApi {
  const {
    layout = "unified",
    onCursorMove,
    onExit,
    onToggleViewed,
    page,
    context,
    onRevealGap,
    selectionState,
    marks,
    onOpenAt,
  } = cursor;
  const view: CursorView = {
    layout,
    context: onRevealGap ? context : undefined,
  };
  const groupRef = useRef<HTMLDivElement | null>(null);
  const review = useContext(DiffReviewContext);
  const discussion = useContext(SelectionDiscussionActionsContext);
  const threadAnchors = useContext(SelectionDiscussionAnchorsContext);
  const sharedSelection = useContext(SelectionDiscussionSelectionContext);
  const [draft, setDraft] = useState<Draft | null>(null);
  const currentDraft = useRef(draft);
  currentDraft.current = draft;
  const ownSelection = useState<DiffSelection | null>(null);
  const [selection, setSelection] = selectionState ?? ownSelection;
  // The cursor on a collapsed gap; the line selection is empty meanwhile.
  const [gapCursor, setGapCursor] = useState<GapCursor | null>(null);
  // After ↵ revealed lines of a gap that is still collapsed, the cursor sits
  // on the revealed line beside it; until the cursor moves, ↵ keeps
  // expanding that gap.
  const [revealing, setRevealing] = useState<{
    gap: GapCursor;
    at: CursorPoint;
  } | null>(null);
  // Pierre reports the selection a gutter press completed right after the
  // press itself; ignore that echo so the draft keeps its captured range.
  const ignoreSelection = useRef(false);
  const placements = review?.placements;
  const toolUseId = surface.kind === "tool_call" ? surface.toolUseId : null;
  // `surface` by value, so memos keyed on its fields can use it.
  const here = useMemo<ReviewSurface>(
    () => (toolUseId === null ? { kind: "worktree" } : { kind: "tool_call", toolUseId }),
    [toolUseId]
  );
  // Closing a discussion puts the cursor back on its anchor; set each render
  // so the memoized annotation renderer calls the current cursor state.
  const returnToAnchor = useRef<(anchor: CodeSelection) => void>(() => {});

  const annotationsByPath = useMemo(() => {
    const byPath = new Map<string, Map<string, ReviewDiffAnnotation>>();
    const at = (
      path: string,
      side: "additions" | "deletions",
      lineNumber: number
    ): ReviewAnnotation => {
      const lines = byPath.get(path) ?? new Map();
      byPath.set(path, lines);
      const key = `${side}:${lineNumber}`;
      const existing = lines.get(key);
      if (existing) return existing.metadata;
      const metadata: ReviewAnnotation = { commentIds: [], draft: false };
      lines.set(key, { side, lineNumber, metadata });
      return metadata;
    };
    for (const placement of placements ?? []) {
      const matches =
        placement.surface.kind === surface.kind &&
        (placement.surface.kind !== "tool_call" ||
          placement.surface.toolUseId === toolUseId);
      if (!matches) continue;
      const side = placement.side === "old" ? "deletions" : "additions";
      at(placement.path, side, placement.endLine).commentIds.push(
        placement.commentId
      );
    }
    for (const thread of threadAnchors) {
      if (!drawnOn(thread, here)) continue;
      const metadata = at(
        thread.anchor.path,
        thread.anchor.side === "old" ? "deletions" : "additions",
        thread.anchor.endLine
      );
      (metadata.threadIds ??= []).push(thread.id);
    }
    if (draft) {
      at(
        draft.path,
        draft.span.side === "old" ? "deletions" : "additions",
        draft.span.endLine
      ).draft = true;
    }
    return new Map<string, ReviewDiffAnnotation[]>(
      [...byPath].map(([path, lines]) => [path, [...lines.values()]])
    );
  }, [placements, surface.kind, toolUseId, here, draft, threadAnchors]);

  const annotationsFor = useCallback(
    (path: string) => annotationsByPath.get(path) ?? NONE,
    [annotationsByPath]
  );

  const activeCommentId = review?.activeCommentId ?? review?.focus?.commentId;
  const rangesByPath = useMemo(() => {
    const byPath = new Map<string, CommentedRange[]>();
    const add = (path: string, range: CommentedRange) => {
      const ranges = byPath.get(path) ?? [];
      byPath.set(path, ranges);
      ranges.push(range);
    };
    for (const placement of placements ?? []) {
      const matches =
        placement.surface.kind === surface.kind &&
        (placement.surface.kind !== "tool_call" ||
          placement.surface.toolUseId === toolUseId);
      // A file-level comment (endLine 0) has no lines to mark.
      if (!matches || placement.endLine < 1) continue;
      add(placement.path, {
        side: placement.side === "old" ? "deletions" : "additions",
        start: placement.startLine,
        end: placement.endLine,
        active: placement.commentId === activeCommentId,
      });
    }
    for (const thread of threadAnchors) {
      if (!drawnOn(thread, here)) continue;
      const { anchor } = thread;
      add(anchor.path, {
        side: anchor.side === "old" ? "deletions" : "additions",
        start: anchor.startLine,
        end: anchor.endLine,
        active: false,
      });
    }
    return byPath;
  }, [placements, threadAnchors, surface.kind, toolUseId, here, activeCommentId]);

  const commentedRangesFor = useCallback(
    (path: string) => rangesByPath.get(path) ?? NO_RANGES,
    [rangesByPath]
  );
  const addComment = review?.addComment;
  const worktreeBranch = review?.worktree?.wholeBranch ?? false;
  const comparisonIdentity = review?.worktree?.comparisonIdentity;
  const home: DiffCommentHome = useMemo(
    () =>
      toolUseId
        ? { kind: "tool_call", toolUseId, ...(toolName ? { toolName } : {}) }
        : { kind: "worktree", wholeBranch: worktreeBranch, comparisonIdentity },
    [toolUseId, toolName, worktreeBranch, comparisonIdentity]
  );

  const openComposer = useCallback(
    (path: string, range: SelectedLineRange) => {
      const file = files.find((candidate) => canonicalPath(candidate) === path);
      if (!file) return;

      const span = resolveSelection(
        file,
        { side: range.side ?? "additions", line: range.start },
        {
          side: range.endSide ?? range.side ?? "additions",
          line: range.end,
        }
      );

      ignoreSelection.current = true;
      setTimeout(() => {
        ignoreSelection.current = false;
      }, 0);

      setSelection({ path, range });
      const anchor = captureCodeSelection(file, range, home);
      if (span && anchor) {
        setDraft({ path, span, anchor, range });
        discussion?.select(anchor);
      }
    },
    [files, home, discussion, setSelection]
  );

  const onSelectionChange = useCallback(
    (path: string, range: SelectedLineRange | null) => {
      if (ignoreSelection.current || draft) return;

      setSelection(range ? { path, range } : null);
      if (range) setGapCursor(null);
      setRevealing(null);
      const file = files.find((file) => canonicalPath(file) === path);
      const anchor =
        file && range ? captureCodeSelection(file, range, home) : null;

      discussion?.select(anchor);
    },
    [files, home, discussion, draft, setSelection]
  );

  const clearInteraction = useCallback(
    (path: string) => {
      setDraft((current) => (current?.path === path ? null : current));
      setSelection((current) => (current?.path === path ? null : current));
      setGapCursor((current) => (current?.path === path ? null : current));
      ignoreSelection.current = false;
      if (sharedSelection?.path === path) discussion?.select(null);
    },
    [sharedSelection, discussion, setSelection]
  );

  const renderAnnotation = useCallback(
    (annotation: { metadata: ReviewAnnotation }): ReactNode => {
      const clearDraft = () => {
        setSelection(null);
        discussion?.select(null);
        setDraft(null);
      };

      return (
        <DiffCommentThread
          annotation={annotation.metadata}
          onDiscussionClosed={(anchor) => returnToAnchor.current(anchor)}
          onCancelDraft={() => {
            // The selection stays; the cursor resumes from its line.
            setDraft(null);
            groupRef.current?.focus({ preventScroll: true });
          }}
          onDiscussDraft={
            discussion?.canAsk && draft &&
            supportsInlineDiscussion(draft.anchor)
              ? (body) => {
                  void discussion.discuss(draft.anchor, body).then((started) => {
                    if (started && currentDraft.current === draft) clearDraft();
                  });
                }
              : undefined
          }
          draftAnchor={draft?.anchor}
          onGithubPosted={() => {
            // A post answering late must not close a newer selection.
            if (currentDraft.current === draft) clearDraft();
          }}
          onAttachDraft={
            discussion && draft
              ? (body) => {
                  discussion.attach(draft.anchor, false, body);
                  clearDraft();
                  // The selection is now in the main chat; continue there.
                  onExit?.();
                }
              : undefined
          }
          onSaveDraft={(body) => {
            if (!draft || !body) return;
            addComment?.({
              home: draft.anchor.home,
              file: draft.anchor.file,
              span: draft.span,
              body,
            });
            clearDraft();
          }}
        />
      );
    },
    [addComment, draft, discussion, onExit, setSelection]
  );

  const selectedFile =
    selection && files.find((file) => canonicalPath(file) === selection.path);
  const anchor =
    selectedFile && selection
      ? captureCodeSelection(selectedFile, selection.range, home)
      : null;
  const sharedRange = useMemo<SelectedLineRange | null>(
    () =>
      sharedSelection
        ? {
            start: sharedSelection.startLine,
            end: sharedSelection.endLine,
            side: sharedSelection.side === "old" ? "deletions" : "additions",
          }
        : null,
    [sharedSelection]
  );

  const selectedLinesFor = useCallback(
    (path: string) => {
      if (sharedSelection) {
        const sameSurface =
          !sharedSelection.fullFile && sharedSelection.home.kind === surface.kind &&
          (sharedSelection.home.kind !== "tool_call" ||
            sharedSelection.home.toolUseId === toolUseId);
        if (!sameSurface || sharedSelection.path !== path) return null;

        if (
          anchor?.path === path &&
          anchor.side === sharedSelection.side &&
          anchor.startLine === sharedSelection.startLine &&
          anchor.endLine === sharedSelection.endLine
        )
          return selection!.range;

        return sharedRange;
      }

      if (draft?.path === path) return draft.range;
      return selection?.path === path ? selection.range : null;
    },
    [
      draft,
      sharedSelection,
      surface.kind,
      toolUseId,
      anchor,
      selection,
      sharedRange,
    ]
  );

  const moveTo = (next: DiffCursor) => {
    setRevealing(null);
    if (next.kind === "line") {
      const { path, range } = next;
      setGapCursor(null);
      onSelectionChange(path, range);
      onCursorMove?.(path, range.end, range.endSide ?? range.side ?? "additions");
      return;
    }
    if (draft) return;
    onSelectionChange(next.path, null);
    setGapCursor(next);
    const near = gapScrollPoint(files, view, next);
    if (near) onCursorMove?.(next.path, near.line, near.side);
  };

  returnToAnchor.current = (anchor) => {
    moveTo({
      kind: "line",
      path: anchor.path,
      range: {
        start: anchor.startLine,
        end: anchor.endLine,
        side: anchor.side === "old" ? "deletions" : "additions",
      },
    });
    groupRef.current?.focus({ preventScroll: true });
  };

  /** The discussion whose anchor covers the line cursor's end line. */
  const discussionAt = (cursor: DiffCursor) => {
    if (cursor.kind !== "line") return undefined;
    const side = cursorSide(cursor);
    const line = cursor.range.end;
    return threadAnchors.find(
      ({ anchor, detached }) =>
        !detached &&
        !anchor.fullFile && anchor.home.kind === surface.kind &&
        (anchor.home.kind !== "tool_call" || anchor.home.toolUseId === toolUseId) &&
        anchor.path === cursor.path &&
        (anchor.side === "old" ? "deletions" : "additions") === side &&
        anchor.startLine <= line &&
        line <= anchor.endLine
    );
  };

  const landmarkMarks = (path: string) => [
    ...(annotationsByPath.get(path) ?? NONE).map((annotation) => ({
      side: annotation.side,
      line: annotation.lineNumber,
    })),
    ...(marks?.(path) ?? []),
  ];

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    const group = event.currentTarget;
    const entry =
      event.target instanceof HTMLElement && event.target !== group
        ? event.target.closest<HTMLElement>(`[${DIFF_CURSOR_ENTRY_ATTRIBUTE}]`)
        : null;
    if (event.target !== group && !(entry && group.contains(entry))) return;

    const command = event.metaKey || event.ctrlKey;
    const plain = !command && !event.shiftKey && !event.altKey;
    const current: DiffCursor | null = gapCursor
      ? gapCursor
      : selection
        ? { kind: "line", ...selection }
        : null;
    const vertical = event.key === "ArrowDown" || event.key === "ArrowUp";
    const direction = event.key === "ArrowDown" ? 1 : -1;
    // The gap ↵ expands: the cursor's, or the one just revealed beside it.
    const expanding =
      current?.kind === "gap"
        ? current
        : revealing &&
            current?.path === revealing.gap.path &&
            current.range.start === revealing.at.line &&
            current.range.end === revealing.at.line &&
            cursorSide(current) === revealing.at.side &&
            (current.range.side ?? "additions") === revealing.at.side
          ? revealing.gap
          : null;

    // ⌥↑/⌥↓: hunks, comments and discussions; ⌥⇧↑/⌥⇧↓: files only.
    if (vertical && event.altKey && !command) {
      const next = moveToLandmark(files, view, current, direction, {
        filesOnly: event.shiftKey,
        marks: landmarkMarks,
      });
      if (!next) return;
      event.preventDefault();
      if (entry) group.focus({ preventScroll: true });
      moveTo(next);
      return;
    }

    // ↵ / ⌥↵ on a gap reveal a section of its hidden lines; the cursor lands on
    // the revealed line beside what is still hidden.
    const reach = !entry && expanding ? gapReach(event) : null;
    if (reach && expanding) {
      event.preventDefault();
      const file = files.find((candidate) => canonicalPath(candidate) === expanding.path);
      const fileContext = view.context?.(expanding.path);
      const result =
        file && fileContext
          ? revealGap(file, fileContext, expanding.gap, expanding.arrival, reach)
          : null;
      if (!result) return;
      onRevealGap?.(expanding.path, expanding.gap, result.reveal);
      const at: CursorPoint = {
        side: expanding.side,
        line:
          expanding.side === "deletions"
            ? result.landing.oldLine
            : result.landing.newLine,
      };
      moveTo(lineCursor(expanding.path, at));
      if (result.hidden > 0) setRevealing({ gap: expanding, at });
      return;
    }
    if (event.altKey) return;

    if (entry) {
      const path = entry.getAttribute(DIFF_CURSOR_ENTRY_ATTRIBUTE) ?? "";
      if (event.key === "Escape" && plain && onExit) {
        event.preventDefault();
        onExit();
        return;
      }
      if (event.key === "v" && plain && onToggleViewed) {
        event.preventDefault();
        if (!event.repeat) onToggleViewed(path);
        return;
      }
      // A file heading: ↓ starts the cursor on that file's first line.
      if (!plain || event.key !== "ArrowDown") return;
      const file = files.find((candidate) => canonicalPath(candidate) === path);
      const start = file && moveCursor([file], view, null, 1, false);
      if (!start) return;
      event.preventDefault();
      group.focus({ preventScroll: true });
      moveTo(start);
      return;
    }

    if (event.key === "PageDown" || event.key === "PageUp") {
      if (command || !page) return;
      event.preventDefault();
      page(event.key === "PageDown" ? 1 : -1, event.shiftKey);
      return;
    }

    if (vertical) {
      if (command) return;
      const next = moveCursor(files, view, current, direction, event.shiftKey);
      if (!next) return;
      event.preventDefault();
      if (next !== current) moveTo(next);
      return;
    }

    if (event.key === "Escape") {
      if (!plain) return;
      // A range collapses to its end line; a single line or a gap leaves.
      const line = current?.kind === "line" ? current : null;
      const end = line && {
        side: line.range.endSide ?? line.range.side ?? "additions",
        line: line.range.end,
      };
      const multiLine =
        line &&
        end &&
        (line.range.start !== end.line ||
          (line.range.side ?? "additions") !== end.side);
      if (line && end && multiLine) {
        event.preventDefault();
        moveTo(lineCursor(line.path, end));
      } else if (onExit) {
        event.preventDefault();
        onExit();
      }
      return;
    }

    if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && plain) {
      const toward = event.key === "ArrowLeft" ? -1 : 1;
      // ← / → only switch split columns. At the outer column (or in a
      // one-column diff, or on a gap spanning both) they are inert: the cursor
      // stays in the diff and Esc is the way out.
      event.preventDefault();
      if (
        layout === "unified" ||
        current?.kind !== "line" ||
        cursorSide(current) === (toward === -1 ? "deletions" : "additions")
      )
        return;
      const next = switchCursorSide(
        files,
        view,
        current,
        toward === -1 ? "deletions" : "additions"
      );
      if (next !== current) moveTo(next);
      return;
    }

    if (!current) return;

    if (event.key === "v" && plain && onToggleViewed) {
      event.preventDefault();
      if (event.repeat) return;
      // Mark the file reviewed and carry on with the next one.
      const at = files.findIndex((file) => canonicalPath(file) === current.path);
      const next = moveCursor(files.slice(at + 1), view, null, 1, false);
      onToggleViewed(current.path);
      if (next) moveTo(next);
      else setGapCursor(null);
      return;
    }

    // Copying, commenting and discussions apply to lines.
    if (current.kind === "gap") return;

    const thread = discussion && discussionAt(current);
    if (thread && event.key === DISCUSSION_OPEN_KEY && plain) {
      event.preventDefault();
      if (!event.repeat) discussion.reopen(thread.id, { focus: true });
      return;
    }
    if (!thread && onOpenAt && event.key === DISCUSSION_OPEN_KEY && plain) {
      if (event.repeat) {
        event.preventDefault();
        return;
      }
      if (onOpenAt(current.path, cursorSide(current), current.range.end)) {
        event.preventDefault();
        return;
      }
    }
    if (thread && matchesChatShortcut(event, DISCUSSION_COLLAPSE_SHORTCUT)) {
      event.preventDefault();
      if (!event.repeat) discussion.toggleCollapsed(thread.id);
      return;
    }

    if (
      command &&
      !event.shiftKey &&
      event.key.toLowerCase() === "c" &&
      !hasTextSelection()
    ) {
      const code =
        selectedFile &&
        (selectedCode(selectedFile, view, current.range) ?? anchor?.code);
      if (code == null) return;
      event.preventDefault();
      writeClipboard(code);
      return;
    }

    if (
      review &&
      !command &&
      !event.shiftKey &&
      (DIFF_COMMENT_KEYS as readonly string[]).includes(event.key)
    ) {
      event.preventDefault();
      if (!event.repeat) openComposer(current.path, current.range);
    }
  };

  const keyboardProps = {
    ref: groupRef,
    tabIndex: review ? 0 : undefined,
    role: "group",
    "aria-label": "Code diff selection",
    "data-line-cursor": gapCursor || revealing ? "gap" : selection ? "" : undefined,
    [DIFF_CURSOR_HOST_ATTRIBUTE]: "",
    // The diff fills the host and its scroller clips an outer ring.
    "data-focus-halo": "overlay",
    // Esc steps out of the cursor here instead of closing the chat panel.
    "data-owns-escape": onExit ? "" : undefined,
    onKeyDown,
  };
  return {
    keyboardProps,
    clearInteraction,
    enabled: review !== null,
    annotationsFor,
    openComposer,
    selectedLinesFor,
    onSelectionChange,
    renderAnnotation,
    commentedRangesFor,
    gapCursor,
  };
}

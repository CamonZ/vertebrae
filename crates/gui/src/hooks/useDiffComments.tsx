import {
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
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
  moveCursor,
  moveToLandmark,
  selectedCode,
  switchCursorSide,
  type DiffLayout,
} from "../components/thread/toolChange/diffCursor";
import { DIFF_COMMENT_KEYS } from "../components/ChatWindow/chatShortcuts";
import {
  DiffCommentThread,
  type ReviewAnnotation,
} from "../components/thread/toolChange/DiffCommentThread";
import { DiffReviewContext } from "../components/thread/toolChange/DiffReviewContext";
import type { ReviewSurface } from "../components/thread/toolChange/diffComments";
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
}

const NONE: ReviewDiffAnnotation[] = [];

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
  /** ← or → past the diff's outer column: move focus to the neighbouring area. */
  onEdge?(direction: -1 | 1): void;
  /** `v`: mark a file as viewed (or unviewed, from its heading). */
  onToggleViewed?(path: string): void;
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
    onEdge,
    onToggleViewed,
  } = cursor;
  const groupRef = useRef<HTMLDivElement | null>(null);
  const review = useContext(DiffReviewContext);
  const discussion = useContext(SelectionDiscussionActionsContext);
  const threadAnchors = useContext(SelectionDiscussionAnchorsContext);
  const sharedSelection = useContext(SelectionDiscussionSelectionContext);
  const [draft, setDraft] = useState<Draft | null>(null);
  const currentDraft = useRef(draft);
  currentDraft.current = draft;
  const [selection, setSelection] = useState<{
    path: string;
    range: SelectedLineRange;
  } | null>(null);
  // Pierre reports the selection a gutter press completed right after the
  // press itself; ignore that echo so the draft keeps its captured range.
  const ignoreSelection = useRef(false);
  const placements = review?.placements;
  const toolUseId = surface.kind === "tool_call" ? surface.toolUseId : null;

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
      const home = thread.anchor.home;
      if (
        home.kind !== surface.kind ||
        (home.kind === "tool_call" && home.toolUseId !== toolUseId)
      )
        continue;
      if (thread.detached) continue;
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
  }, [placements, surface.kind, toolUseId, draft, threadAnchors]);

  const annotationsFor = useCallback(
    (path: string) => annotationsByPath.get(path) ?? NONE,
    [annotationsByPath]
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
    [files, home, discussion]
  );

  const onSelectionChange = useCallback(
    (path: string, range: SelectedLineRange | null) => {
      if (ignoreSelection.current || draft) return;

      setSelection(range ? { path, range } : null);
      const file = files.find((file) => canonicalPath(file) === path);
      const anchor =
        file && range ? captureCodeSelection(file, range, home) : null;

      discussion?.select(anchor);
    },
    [files, home, discussion, draft]
  );

  const clearInteraction = useCallback(
    (path: string) => {
      setDraft((current) => (current?.path === path ? null : current));
      setSelection((current) => (current?.path === path ? null : current));
      ignoreSelection.current = false;
      if (sharedSelection?.path === path) discussion?.select(null);
    },
    [sharedSelection, discussion]
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
    [addComment, draft, discussion, onExit]
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
          sharedSelection.home.kind === surface.kind &&
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

  const moveTo = (path: string, range: SelectedLineRange) => {
    onSelectionChange(path, range);
    onCursorMove?.(path, range.end, range.endSide ?? range.side ?? "additions");
  };

  const landmarkMarks = (path: string) =>
    (annotationsByPath.get(path) ?? NONE).map((annotation) => ({
      side: annotation.side,
      line: annotation.lineNumber,
    }));

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
    const current = selection;
    const vertical = event.key === "ArrowDown" || event.key === "ArrowUp";
    const direction = event.key === "ArrowDown" ? 1 : -1;

    // ⌥↑/⌥↓: hunks, comments and discussions; ⌥⇧↑/⌥⇧↓: files only.
    if (vertical && event.altKey && !command) {
      const next = moveToLandmark(files, layout, current, direction, {
        filesOnly: event.shiftKey,
        marks: landmarkMarks,
      });
      if (!next) return;
      event.preventDefault();
      if (entry) group.focus({ preventScroll: true });
      moveTo(next.path, next.range);
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
      const start = file && moveCursor([file], layout, null, 1, false);
      if (!start) return;
      event.preventDefault();
      group.focus({ preventScroll: true });
      moveTo(start.path, start.range);
      return;
    }

    if (vertical) {
      if (command) return;
      const next = moveCursor(files, layout, current, direction, event.shiftKey);
      if (!next) return;
      event.preventDefault();
      if (next !== current) moveTo(next.path, next.range);
      return;
    }

    if (event.key === "Escape") {
      if (!plain) return;
      const end = current && {
        side: current.range.endSide ?? current.range.side ?? "additions",
        line: current.range.end,
      };
      const multiLine =
        current &&
        end &&
        (current.range.start !== end.line ||
          (current.range.side ?? "additions") !== end.side);
      if (current && end && multiLine) {
        event.preventDefault();
        moveTo(current.path, { start: end.line, end: end.line, side: end.side });
      } else if (onExit) {
        event.preventDefault();
        onExit();
      }
      return;
    }

    if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && plain) {
      const toward = event.key === "ArrowLeft" ? -1 : 1;
      const side = current
        ? (current.range.endSide ?? current.range.side ?? "additions")
        : null;
      // Past the outer column (or in a one-column diff) focus leaves the diff.
      const atEdge =
        layout === "unified" ||
        !current ||
        (toward === -1 ? side === "deletions" : side === "additions");
      if (atEdge) {
        if (!onEdge) return;
        event.preventDefault();
        onEdge(toward);
        return;
      }
      event.preventDefault();
      const next = switchCursorSide(
        files,
        layout,
        current,
        toward === -1 ? "deletions" : "additions"
      );
      if (next !== current) moveTo(next.path, next.range);
      return;
    }

    if (!current) return;

    if (event.key === "v" && plain && onToggleViewed) {
      event.preventDefault();
      if (event.repeat) return;
      // Mark the file reviewed and carry on with the next one.
      const at = files.findIndex((file) => canonicalPath(file) === current.path);
      const next = moveCursor(files.slice(at + 1), layout, null, 1, false);
      onToggleViewed(current.path);
      if (next) moveTo(next.path, next.range);
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
        (selectedCode(selectedFile, layout, current.range) ?? anchor?.code);
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
    "data-line-cursor": selection ? "" : undefined,
    // The cursor line's accent bar is the focus indicator once there is one.
    "data-focus-halo": selection ? "none" : undefined,
    [DIFF_CURSOR_HOST_ATTRIBUTE]: "",
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
  };
}

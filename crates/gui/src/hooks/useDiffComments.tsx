import {
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type HTMLAttributes,
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
import type { DiffLineAnnotation, SelectedLineRange } from "@pierre/diffs";
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
  keyboardProps: HTMLAttributes<HTMLDivElement>;
  renderAnnotation(annotation: { metadata: ReviewAnnotation }): ReactNode;
}

const NONE: ReviewDiffAnnotation[] = [];

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
  toolName?: string
): DiffCommentsApi {
  const review = useContext(DiffReviewContext);
  const discussion = useContext(SelectionDiscussionActionsContext);
  const threadAnchors = useContext(SelectionDiscussionAnchorsContext);
  const sharedSelection = useContext(SelectionDiscussionSelectionContext);
  const [draft, setDraft] = useState<Draft | null>(null);
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

  const renderAnnotation = useCallback(
    (annotation: { metadata: ReviewAnnotation }): ReactNode => (
      <DiffCommentThread
        annotation={annotation.metadata}
        onCancelDraft={() => setDraft(null)}
        onDiscussDraft={
          discussion && draft
            ? (body) => {
                discussion.discuss(draft.anchor, body);
                setSelection(null);
                discussion.select(null);
                setDraft(null);
              }
            : undefined
        }
        onSaveDraft={(body) => {
          if (!draft || (!body && !discussion)) return;

          if (discussion) discussion.attach(draft.anchor, false, body);
          else
            addComment?.({
              home: draft.anchor.home,
              file: draft.anchor.file,
              span: draft.span,
              body,
            });

          setSelection(null);
          discussion?.select(null);
          setDraft(null);
        }}
      />
    ),
    [addComment, draft, discussion]
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

  const keyboardProps: HTMLAttributes<HTMLDivElement> = {
    tabIndex: review ? 0 : undefined,
    role: "group",
    "aria-label": "Code diff selection",
    onKeyDown: (event) => {
      if (
        event.target !== event.currentTarget ||
        !["ArrowDown", "ArrowUp"].includes(event.key)
      )
        return;
      const file = selectedFile || files[0];
      if (!file) return;
      const side = selection?.range.side ?? "additions";
      const lines = file.hunks
        .flatMap((hunk) => hunk.rows)
        .flatMap((row) => {
          const line = side === "deletions" ? row.oldLine : row.newLine;
          return line === null ? [] : [line];
        });
      if (!lines.length) return;
      event.preventDefault();
      const current = selection?.range.end;
      const line =
        current == null
          ? lines[0]
          : event.key === "ArrowDown"
            ? (lines.find((line) => line > current) ?? current)
            : ([...lines].reverse().find((line) => line < current) ?? current);
      const path = canonicalPath(file);
      const range = {
        side,
        start: event.shiftKey ? (selection?.range.start ?? line) : line,
        end: line,
      };

      onSelectionChange(path, range);
    },
  };
  return {
    keyboardProps,
    enabled: review !== null,
    annotationsFor,
    openComposer,
    selectedLinesFor,
    onSelectionChange,
    renderAnnotation,
  };
}

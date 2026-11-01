import {
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
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
}

export interface DiffCommentsApi {
  /** Review is available here (a ChatWindow provides pending comments). */
  enabled: boolean;
  /** Pierre annotations for one file, stable until its comments change. */
  annotationsFor(path: string): ReviewDiffAnnotation[];
  /** Gutter "+" click or drag: open the composer for the selected lines. */
  openComposer(path: string, range: SelectedLineRange): void;
  /**
   * The user's line selection (click, drag or shift-click on line numbers) in
   * one file, for Pierre's controlled `selectedLines`; null when none. The
   * selection is cleared once a composer opens.
   */
  selectedLinesFor(path: string): SelectedLineRange | null;
  /** Pierre's selection-end notification for one file. */
  onSelectionChange(path: string, range: SelectedLineRange | null): void;
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
  const [draft, setDraft] = useState<Draft | null>(null);
  const [selection, setSelection] = useState<{
    path: string;
    range: SelectedLineRange;
  } | null>(null);
  // Pierre reports the selection a gutter press completed right after the
  // press itself; ignore that echo so the highlight does not linger.
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
  }, [placements, surface.kind, toolUseId, draft]);

  const annotationsFor = useCallback(
    (path: string) => annotationsByPath.get(path) ?? NONE,
    [annotationsByPath]
  );
  const addComment = review?.addComment;
  const worktreeBranch = review?.worktree?.wholeBranch ?? false;
  const home: DiffCommentHome = useMemo(
    () =>
      toolUseId
        ? { kind: "tool_call", toolUseId, ...(toolName ? { toolName } : {}) }
        : { kind: "worktree", wholeBranch: worktreeBranch },
    [toolUseId, toolName, worktreeBranch]
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
      setSelection(null);
      if (span) setDraft({ path, span });
    },
    [files]
  );

  const selectedLinesFor = useCallback(
    (path: string) => (selection?.path === path ? selection.range : null),
    [selection]
  );
  const onSelectionChange = useCallback(
    (path: string, range: SelectedLineRange | null) => {
      if (ignoreSelection.current) return;
      setSelection(range ? { path, range } : null);
    },
    []
  );

  const renderAnnotation = useCallback(
    (annotation: { metadata: ReviewAnnotation }): ReactNode => (
      <DiffCommentThread
        annotation={annotation.metadata}
        onCancelDraft={() => setDraft(null)}
        onSaveDraft={(body) => {
          if (!draft || !body) return;
          const file = files.find(
            (candidate) => canonicalPath(candidate) === draft.path
          );
          if (file) addComment?.({ home, file, span: draft.span, body });
          setDraft(null);
        }}
      />
    ),
    [addComment, draft, files, home]
  );

  return {
    enabled: review !== null,
    annotationsFor,
    openComposer,
    selectedLinesFor,
    onSelectionChange,
    renderAnnotation,
  };
}

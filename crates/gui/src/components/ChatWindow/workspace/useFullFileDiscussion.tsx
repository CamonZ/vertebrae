import {
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type { LineAnnotation, SelectedLineRange } from "@pierre/diffs";
import { errorMessage } from "../../../query/commandResult";
import {
  DiffCommentThread,
  type ReviewAnnotation,
} from "../../thread/toolChange/DiffCommentThread";
import { DIFF_COMMENT_KEYS, DISCUSSION_OPEN_KEY } from "../chatShortcuts";
import { SelectionDiscussionContext } from "../selectionDiscussionState";
import {
  sameFullFile,
  type CodeSelection,
  type FullFileSource,
} from "../selectionDiscussions";

// The annotation is a full row. Use the gutter's measured width so a narrow
// pane can spend that space on the composer instead of a blank gutter cell.
const FULL_FILE_ANNOTATION_CSS = `
[data-file][data-overflow="scroll"] [data-line-annotation] {
  z-index: 4;
}
[data-file][data-overflow="scroll"] [data-annotation-content] {
  margin-inline-start: calc(0px - var(--diffs-column-number-width, 0px));
  width: calc(var(--diffs-column-content-width, 100%) + var(--diffs-column-number-width, 0px));
  left: 0;
  background: var(--diffs-line-bg);
}
`;

export const FULL_FILE_SELECTION_LABEL =
  "File lines. Use arrow keys to select, Shift to extend, C to discuss, and O to reopen.";

export function useFullFileDiscussion(
  source: FullFileSource | undefined,
  path: string,
  contents: string | null,
  revealed: SelectedLineRange | null,
  dirty: boolean,
  onNavigate?: (line: number) => void
) {
  const discussion = useContext(SelectionDiscussionContext);
  const focus = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<
    SelectedLineRange | null | undefined
  >();
  const [draft, setDraft] = useState<SelectedLineRange | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const pending = useRef<SelectedLineRange | null>(null);
  const shared = discussion?.selection;
  const selectedAnchor =
    source && shared?.path === path && sameFullFile(shared.fullFile, source)
      ? shared
      : null;
  const range = selectedAnchor
    ? { start: selectedAnchor.startLine, end: selectedAnchor.endLine }
    : selection === undefined
      ? revealed
      : selection;
  const moveSelection = (next: SelectedLineRange | null) => {
    if (selectedAnchor) discussion?.select(null);
    setSelection(next);
  };
  const enabled = !!source && !!discussion;
  const reason = dirty
    ? "Save your edits before starting a discussion on these lines."
    : !discussion?.canAskFullFile
      ? "Inline discussions require a saved chat and a Git checkout."
      : null;

  const lines = useMemo(
    () => (contents ? contents.replace(/\n$/, "").split("\n") : []),
    [contents]
  );
  const codeAt = (start: number, end: number) =>
    start >= 1 && end >= start && end <= lines.length
      ? lines.slice(start - 1, end).join("\n")
      : null;
  const annotations = new Map<number, ReviewAnnotation>();
  const at = (line: number) => {
    let annotation = annotations.get(line);
    if (!annotation) {
      annotation = { commentIds: [], threadIds: [], draft: false };
      annotations.set(line, annotation);
    }
    return annotation;
  };
  const threads =
    source && !dirty
      ? (discussion?.threads.filter(
          ({ anchor, status }) =>
            anchor.path === path &&
            sameFullFile(anchor.fullFile, source) &&
            (source.turn && status.kind === "unreadable"
              ? codeAt(anchor.startLine, anchor.endLine) !== null
              : status.kind === "inline" &&
                codeAt(anchor.startLine, anchor.endLine) === anchor.code)
        ) ?? [])
      : [];
  for (const { id, anchor } of threads) at(anchor.endLine).threadIds?.push(id);
  if (draft && !reason) at(Math.max(draft.start, draft.end)).draft = true;

  const anchorFor = (range: SelectedLineRange): CodeSelection | null => {
    if (!source || reason) return null;
    const startLine = Math.min(range.start, range.end);
    const endLine = Math.max(range.start, range.end);
    const code = codeAt(startLine, endLine);
    return code === null
      ? null
      : {
          path,
          code,
          startLine,
          endLine,
          side: "new",
          file: { oldPath: null, newPath: path, hunks: [] },
          home: { kind: "worktree", wholeBranch: false },
          fullFile: source,
        };
  };
  const openDraft = (next: SelectedLineRange) => {
    if (pending.current) return;
    setSubmitError(null);
    setSelection(next);
    setDraft(next);
    const anchor = anchorFor(next);
    if (anchor) discussion?.select(anchor);
  };
  const closeDraft = () => {
    setDraft(null);
    focus.current?.focus({ preventScroll: true });
  };

  const submit = (question: string) => {
    const anchor = draft && anchorFor(draft);
    if (!anchor || !discussion || pending.current) return;
    pending.current = draft;
    setSubmitError(null);
    void discussion
      .discuss(anchor, question)
      .then((started) => {
        if (started)
          setDraft((current) => (current === draft ? null : current));
      })
      .catch((error: unknown) => setSubmitError(errorMessage(error)))
      .finally(() => {
        pending.current = null;
      });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      !enabled ||
      event.nativeEvent.isComposing ||
      event.target !== event.currentTarget ||
      event.altKey ||
      event.metaKey ||
      event.ctrlKey
    )
      return;
    const end = range?.end ?? 1;
    if (
      lines.length &&
      (event.key === "ArrowDown" || event.key === "ArrowUp")
    ) {
      const line = range
        ? Math.max(
            1,
            Math.min(lines.length, end + (event.key === "ArrowDown" ? 1 : -1))
          )
        : 1;
      const start = event.shiftKey ? (range?.start ?? line) : line;
      moveSelection({ start, end: line });
      onNavigate?.(line);
    } else if (event.key === DISCUSSION_OPEN_KEY && range) {
      const thread = threads.find(
        ({ anchor }) => anchor.startLine <= end && end <= anchor.endLine
      );
      if (!thread) return;
      discussion?.reopen(thread.id, { focus: true });
    } else if (
      range &&
      !event.shiftKey &&
      DIFF_COMMENT_KEYS.some((key) => key === event.key)
    ) {
      if (!event.repeat) openDraft(range);
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  // Pierre compares options by reference and can rebuild its editable DOM
  // when a callback changes. Keep its handlers stable as the draft text changes.
  const interactions = useRef({ openDraft, moveSelection, draft });
  interactions.current = { openDraft, moveSelection, draft };
  const onGutterUtilityClick = useCallback((next: SelectedLineRange) => {
    interactions.current.openDraft(next);
  }, []);
  const onLineSelectionEnd = useCallback((next: SelectedLineRange | null) => {
    if (interactions.current.draft || pending.current) return;
    interactions.current.moveSelection(next);
    if (next) focus.current?.focus({ preventScroll: true });
  }, []);

  return {
    enabled,
    annotationCSS: FULL_FILE_ANNOTATION_CSS,
    focus,
    range,
    reason: draft ? (reason ?? submitError ?? discussion?.anchorError) : null,
    options: enabled
      ? {
          enableLineSelection: true,
          enableGutterUtility: true,
          onLineSelectionEnd,
          onGutterUtilityClick,
        }
      : {},
    onKeyDown,
    annotations: [...annotations].map(([lineNumber, metadata]) => ({
      lineNumber,
      metadata,
    })),
    renderAnnotation: ({ metadata }: LineAnnotation<ReviewAnnotation>) => (
      <div className="full-file-discussion">
        <DiffCommentThread
          annotation={metadata}
          onDiscussDraft={submit}
          onCancelDraft={closeDraft}
          onDiscussionClosed={() =>
            focus.current?.focus({ preventScroll: true })
          }
        />
      </div>
    ),
  };
}

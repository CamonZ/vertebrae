import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import type { CodeViewHandle } from "@pierre/diffs/react";
import type { ReviewAnnotation } from "./DiffCommentThread";

/** Lines a diff comment or inline discussion is about, on one side. */
export interface CommentedRange {
  side: "additions" | "deletions";
  start: number;
  end: number;
  /** The comment whose chip or card is hovered, pinned or focused. */
  active: boolean;
}

type ViewRef = RefObject<CodeViewHandle<ReviewAnnotation, undefined> | null>;

export const COMMENTED_LINE_ATTRIBUTE = "data-review-comment";
/** Set on the line-number cell where a comment's range ends (its speech-bubble glyph). */
export const COMMENT_END_ATTRIBUTE = "data-review-comment-end";

/** A filled speech bubble; only its alpha is used as a mask. */
const COMMENT_GLYPH = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M5 3h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10l-5 4v-4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z'/%3E%3C/svg%3E")`;

/**
 * Commented rows: a quiet accent tint over the diff colours, a range bar on
 * the gutter's inner edge and, where the comment ends, a speech-bubble glyph
 * in the gutter's left slot. All are stronger for the active comment, with
 * no size change. The transient selection is a plain fill without a glyph,
 * so the two never read alike.
 */
export const COMMENTED_LINES_CSS = `
[data-line][${COMMENTED_LINE_ATTRIBUTE}] {
  background-image: linear-gradient(var(--review-comment-tint), var(--review-comment-tint));
}
[data-column-number][${COMMENTED_LINE_ATTRIBUTE}] {
  background-image: linear-gradient(var(--review-comment-edge), var(--review-comment-edge));
  background-repeat: no-repeat;
  background-position: right top;
  background-size: var(--review-comment-bar) 100%;
}
/* A speech-bubble glyph in the reserved left slot (the one the semantic
   indicator uses), so it never touches the digits and is not a circle. A row
   that already carries a semantic indicator keeps only the bar and tint. */
[data-column-number][${COMMENT_END_ATTRIBUTE}]::after {
  content: "";
  position: absolute;
  inset-inline-start: 6px;
  inset-block-start: calc((1lh - 10px) / 2);
  width: 10px;
  height: 10px;
  background: var(--color-accent);
  opacity: var(--review-comment-glyph-opacity);
  -webkit-mask: ${COMMENT_GLYPH} center / contain no-repeat;
  mask: ${COMMENT_GLYPH} center / contain no-repeat;
  pointer-events: none;
}
[data-column-number][${COMMENT_END_ATTRIBUTE}]:has([data-semantic-indicator])::after {
  display: none;
}
[${COMMENTED_LINE_ATTRIBUTE}] {
  --review-comment-tint: color-mix(in oklab, var(--color-accent) 9%, transparent);
  --review-comment-edge: color-mix(in oklab, var(--color-accent) 55%, transparent);
  --review-comment-bar: 2px;
  --review-comment-glyph-opacity: 0.7;
}
[${COMMENTED_LINE_ATTRIBUTE}="active"] {
  --review-comment-tint: color-mix(in oklab, var(--color-accent) 17%, transparent);
  --review-comment-edge: var(--color-accent);
  --review-comment-bar: 3px;
  --review-comment-glyph-opacity: 1;
}
`;

/**
 * Mark the rows each comment covers in Pierre's rendered diffs. Rows mount
 * and unmount as the view virtualizes, so call the returned `schedule` from
 * the view's `onPostRender`; range changes repaint on their own.
 */
export function useCommentedLines(
  viewRef: ViewRef,
  /** The commented ranges of one rendered item, by item id. */
  rangesFor: (itemId: string) => readonly CommentedRange[]
): () => void {
  const rangesRef = useRef(rangesFor);
  rangesRef.current = rangesFor;
  const marked = useRef(new Map<Element, string>());
  const markedEnds = useRef(new Set<Element>());
  const frame = useRef(0);

  const paint = useCallback(() => {
    frame.current = 0;
    const next = new Map<Element, string>();
    const nextEnds = new Set<Element>();
    const rendered = viewRef.current?.getInstance()?.getRenderedItems() ?? [];
    for (const item of rendered) {
      const root = item.element.shadowRoot;
      if (item.type !== "diff" || !root) continue;
      for (const range of rangesRef.current(item.id)) {
        const value = range.active ? "active" : "";
        const column =
          root.querySelector(`[data-code][data-${range.side}]`) ??
          root.querySelector("[data-code][data-unified]");
        if (!column) continue;
        for (let line = range.start; line <= range.end; line++) {
          const index = item.instance.getLineIndex(line, range.side)?.join(",");
          if (index === undefined) continue;
          for (const row of column.querySelectorAll(
            `[data-line-index="${index}"]:is([data-line], [data-column-number])`
          )) {
            // An active comment wins where ranges overlap.
            if (next.get(row) !== "active") next.set(row, value);
            if (line === range.end && row.hasAttribute("data-column-number"))
              nextEnds.add(row);
          }
        }
      }
    }
    for (const row of marked.current.keys())
      if (!next.has(row)) row.removeAttribute(COMMENTED_LINE_ATTRIBUTE);
    for (const [row, value] of next)
      if (row.getAttribute(COMMENTED_LINE_ATTRIBUTE) !== value)
        row.setAttribute(COMMENTED_LINE_ATTRIBUTE, value);
    marked.current = next;
    for (const row of markedEnds.current)
      if (!nextEnds.has(row)) row.removeAttribute(COMMENT_END_ATTRIBUTE);
    for (const row of nextEnds)
      if (!row.hasAttribute(COMMENT_END_ATTRIBUTE))
        row.setAttribute(COMMENT_END_ATTRIBUTE, "");
    markedEnds.current = nextEnds;
  }, [viewRef]);

  const schedule = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(paint);
  }, [paint]);

  useLayoutEffect(() => {
    schedule();
  }, [rangesFor, schedule]);

  useLayoutEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      frame.current = 0;
      for (const row of marked.current.keys())
        row.removeAttribute(COMMENTED_LINE_ATTRIBUTE);
      marked.current = new Map();
      for (const row of markedEnds.current)
        row.removeAttribute(COMMENT_END_ATTRIBUTE);
      markedEnds.current = new Set();
    },
    []
  );

  return schedule;
}

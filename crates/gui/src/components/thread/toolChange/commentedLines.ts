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

/**
 * Commented rows: a quiet accent tint over the diff colours and a thin accent
 * edge on the line number, stronger for the active comment. Selection paints
 * over it, so a fresh selection inside a commented range still reads.
 */
export const COMMENTED_LINES_CSS = `
[data-line][${COMMENTED_LINE_ATTRIBUTE}] {
  background-image: linear-gradient(var(--review-comment-tint), var(--review-comment-tint));
}
[data-column-number][${COMMENTED_LINE_ATTRIBUTE}] {
  box-shadow: inset 2px 0 0 var(--review-comment-edge);
}
[${COMMENTED_LINE_ATTRIBUTE}] {
  --review-comment-tint: color-mix(in oklab, var(--color-accent) 9%, transparent);
  --review-comment-edge: color-mix(in oklab, var(--color-accent) 55%, transparent);
}
[${COMMENTED_LINE_ATTRIBUTE}="active"] {
  --review-comment-tint: color-mix(in oklab, var(--color-accent) 17%, transparent);
  --review-comment-edge: var(--color-accent);
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
  const frame = useRef(0);

  const paint = useCallback(() => {
    frame.current = 0;
    const next = new Map<Element, string>();
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
    },
    []
  );

  return schedule;
}

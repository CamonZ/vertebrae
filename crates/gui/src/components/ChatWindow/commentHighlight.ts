import { useEffect, type RefObject } from "react";
import {
  ASSISTANT_RESPONSE_SELECTOR,
  type PendingTextComment,
} from "./assistantTextComments";

/** CSS Custom Highlight names; styled in chatComments.css. */
export const PENDING_HIGHLIGHT = "vtb-comment";
export const ACTIVE_HIGHLIGHT = "vtb-comment-active";

interface Position {
  node: Text;
  offset: number;
}

/**
 * Locate a comment's quote in the rendered transcript. Rendered text and the
 * captured selection differ in whitespace (block breaks, list markers), so
 * both are compared with whitespace removed; when the quote occurs more than
 * once, the occurrence whose preceding text best matches the captured context
 * wins.
 */
export function findQuoteRange(
  transcript: HTMLElement,
  comment: Pick<
    PendingTextComment,
    "responseId" | "quote" | "contextBefore" | "contextAfter"
  >
): Range | null {
  const response = [
    ...transcript.querySelectorAll<HTMLElement>(ASSISTANT_RESPONSE_SELECTOR),
  ].find(
    (element) =>
      element.dataset.localChatAssistantResponseId === comment.responseId
  );
  if (!response) return null;

  const positions: Position[] = [];
  let text = "";
  const walker = document.createTreeWalker(response, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.nodeValue ?? "";
    for (let offset = 0; offset < value.length; offset++) {
      if (/\s/.test(value[offset])) continue;
      positions.push({ node: node as Text, offset });
      text += value[offset];
    }
  }

  const strip = (value: string) => value.replace(/\s+/g, "");
  const quote = strip(comment.quote);
  if (!quote) return null;
  const before = strip(comment.contextBefore);
  const after = strip(comment.contextAfter);

  let best = -1;
  let bestScore = -1;
  for (
    let index = text.indexOf(quote);
    index >= 0;
    index = text.indexOf(quote, index + 1)
  ) {
    const score =
      sharedSuffix(text.slice(0, index), before) +
      sharedPrefix(text.slice(index + quote.length), after);
    if (score > bestScore) {
      best = index;
      bestScore = score;
    }
  }
  if (best < 0) return null;

  const start = positions[best];
  const end = positions[best + quote.length - 1];
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset + 1);
  return range;
}

function sharedSuffix(a: string, b: string): number {
  let count = 0;
  while (
    count < a.length &&
    count < b.length &&
    a[a.length - 1 - count] === b[b.length - 1 - count]
  )
    count++;
  return count;
}

function sharedPrefix(a: string, b: string): number {
  let count = 0;
  while (count < a.length && count < b.length && a[count] === b[count]) count++;
  return count;
}

function highlightsSupported(): boolean {
  return (
    typeof CSS !== "undefined" &&
    "highlights" in CSS &&
    typeof Highlight !== "undefined"
  );
}

/**
 * Each mounted transcript contributes its own ranges; the shared named
 * highlights are rebuilt from all of them, so split panes do not overwrite
 * each other.
 */
const contributions = new Map<object, { pending: Range[]; active: Range[] }>();

function publish() {
  const pending = new Highlight();
  const active = new Highlight();
  for (const ranges of contributions.values()) {
    ranges.pending.forEach((range) => pending.add(range));
    ranges.active.forEach((range) => active.add(range));
  }
  CSS.highlights.set(PENDING_HIGHLIGHT, pending);
  CSS.highlights.set(ACTIVE_HIGHLIGHT, active);
}

/**
 * Mark every pending text comment's quote in the transcript, the hovered or
 * pinned one more strongly.
 * Degrades to nothing where the CSS Custom Highlight API is missing.
 */
export function useCommentHighlights(
  transcriptRef: RefObject<HTMLElement | null>,
  comments: readonly PendingTextComment[],
  activeId: string | null,
  /** Re-resolve when the rendered transcript changes. */
  revision: unknown
) {
  useEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript || !highlightsSupported()) return;

    const key = {};
    const ranges = { pending: [] as Range[], active: [] as Range[] };
    for (const comment of comments) {
      const range = findQuoteRange(transcript, comment);
      if (range)
        (comment.id === activeId ? ranges.active : ranges.pending).push(range);
    }
    contributions.set(key, ranges);
    publish();

    return () => {
      contributions.delete(key);
      publish();
    };
  }, [transcriptRef, comments, activeId, revision]);
}

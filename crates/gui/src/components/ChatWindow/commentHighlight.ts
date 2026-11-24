import {
  useEffect,
  useRef,
  type MutableRefObject,
  type RefObject,
} from "react";
import {
  ASSISTANT_RESPONSE_SELECTOR,
  type PendingTextComment,
} from "./assistantTextComments";

/** CSS Custom Highlight names; styled in chatComments.css. */
export const PENDING_HIGHLIGHT = "vtb-comment";
export const ACTIVE_HIGHLIGHT = "vtb-comment-active";
export const HOVER_HIGHLIGHT = "vtb-comment-hover";
export const JUMP_HIGHLIGHT = "vtb-comment-jump";

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
interface Contribution {
  pending: Range[];
  hover: Range[];
  active: Range[];
}
const contributions = new Map<object, Contribution>();

function publish() {
  const pending = new Highlight();
  const hover = new Highlight();
  const active = new Highlight();
  for (const ranges of contributions.values()) {
    ranges.pending.forEach((range) => pending.add(range));
    ranges.hover.forEach((range) => hover.add(range));
    ranges.active.forEach((range) => active.add(range));
  }
  CSS.highlights.set(PENDING_HIGHLIGHT, pending);
  CSS.highlights.set(HOVER_HIGHLIGHT, hover);
  CSS.highlights.set(ACTIVE_HIGHLIGHT, active);
}

/**
 * Keep the text a comment is being written on marked (as the focused
 * highlight) while its card is open: focusing the card's textarea drops the
 * native selection, and the quote would otherwise lose its mark. Cleared when
 * `range` becomes null (cancel, submit) or the pane unmounts.
 */
export function useDraftHighlight(range: Range | null) {
  useEffect(() => {
    if (!range || !highlightsSupported()) return;
    const key = {};
    contributions.set(key, { pending: [], hover: [], active: [range] });
    publish();
    return () => {
      contributions.delete(key);
      publish();
    };
  }, [range]);
}

/**
 * Mark every pending text comment's quote in the transcript: the pointer's
 * one more strongly, the hovered-chip or pinned one most. Returns the
 * resolved range of each comment, for the transcript's comment markers.
 * Degrades to nothing where the CSS Custom Highlight API is missing.
 */
export function useCommentHighlights(
  transcriptRef: RefObject<HTMLElement | null>,
  comments: readonly PendingTextComment[],
  activeId: string | null,
  /** Re-resolve when the rendered transcript changes. */
  revision: unknown,
  /** The comment whose highlight the pointer is over. */
  hoveredId: string | null = null,
  /** Receives each comment's resolved range; one is created if omitted. */
  externalRangesRef?: MutableRefObject<ReadonlyMap<string, Range>>
): RefObject<ReadonlyMap<string, Range>> {
  const ownRangesRef = useRef<ReadonlyMap<string, Range>>(new Map());
  const rangesRef = externalRangesRef ?? ownRangesRef;

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    const resolved = new Map<string, Range>();
    for (const comment of comments) {
      const range = findQuoteRange(transcript, comment);
      if (range) resolved.set(comment.id, range);
    }
    rangesRef.current = resolved;
    if (!highlightsSupported()) return;

    const key = {};
    const ranges: Contribution = { pending: [], hover: [], active: [] };
    for (const [id, range] of resolved) {
      const bucket =
        id === activeId
          ? ranges.active
          : id === hoveredId
            ? ranges.hover
            : ranges.pending;
      bucket.push(range);
    }
    contributions.set(key, ranges);
    publish();

    return () => {
      contributions.delete(key);
      publish();
    };
  }, [transcriptRef, comments, activeId, hoveredId, revision, rangesRef]);

  return rangesRef;
}

const JUMP_HIGHLIGHT_MS = 1600;
let jumpTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Scroll a comment's quote into view and tint it briefly, for jumping back
 * from a sent comment to the text it quoted.
 */
export function revealCommentAnchor(range: Range) {
  const element =
    range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
  const reduced =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  element?.scrollIntoView?.({
    block: "center",
    behavior: reduced ? "auto" : "smooth",
  });
  if (!highlightsSupported()) return;
  clearTimeout(jumpTimer);
  CSS.highlights.set(JUMP_HIGHLIGHT, new Highlight(range));
  jumpTimer = setTimeout(
    () => CSS.highlights.delete(JUMP_HIGHLIGHT),
    JUMP_HIGHLIGHT_MS
  );
}

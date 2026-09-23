export const ASSISTANT_RESPONSE_SELECTOR =
  "[data-local-chat-assistant-response-id]";

export interface TextSelectionAnchor {
  /** Stable assistant response identity, preferring the provider item id. */
  responseId: string;
  /** Provider identity when available. */
  itemId: string | null;
  /** Exact selected text from the rendered response. */
  quote: string;
  /** Nearby rendered text before the quote, when it can be resolved. */
  contextBefore: string;
  /** Nearby rendered text after the quote, when it can be resolved. */
  contextAfter: string;
}

export interface PendingTextComment extends TextSelectionAnchor {
  id: string;
  body: string;
}

const CONTEXT_LENGTH = 80;

function elementFor(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE
    ? (node as Element)
    : node.parentElement;
}

function responseFor(node: Node): HTMLElement | null {
  return (
    elementFor(node)?.closest<HTMLElement>(ASSISTANT_RESPONSE_SELECTOR) ?? null
  );
}

function contextAroundQuote(
  response: HTMLElement,
  range: Range,
  quote: string
): { contextBefore: string; contextAfter: string } {
  const startParagraph = elementFor(range.startContainer)?.closest("p");
  const endParagraph = elementFor(range.endContainer)?.closest("p");
  const contextElement =
    startParagraph && startParagraph === endParagraph
      ? startParagraph
      : response;
  const text = contextElement.textContent ?? "";
  const prefixRange = range.cloneRange();
  prefixRange.selectNodeContents(contextElement);
  prefixRange.setEnd(range.startContainer, range.startOffset);
  const quoteIndex = prefixRange.toString().length;
  if (text.slice(quoteIndex, quoteIndex + quote.length) !== quote) {
    return { contextBefore: "", contextAfter: "" };
  }

  return {
    contextBefore: text.slice(
      Math.max(0, quoteIndex - CONTEXT_LENGTH),
      quoteIndex
    ),
    contextAfter: text.slice(
      quoteIndex + quote.length,
      quoteIndex + quote.length + CONTEXT_LENGTH
    ),
  };
}

/**
 * Resolve a browser text selection to one completed assistant response.
 * Rendered DOM text is used for the quote and local context; Markdown source
 * offsets are intentionally not part of this contract.
 */
export function textSelectionToAnchor(
  selection: Selection | null,
  transcript: HTMLElement
): TextSelectionAnchor | null {
  if (!selection || selection.rangeCount === 0) return null;

  const range = selection.getRangeAt(0);
  const startResponse = responseFor(range.startContainer);
  const endResponse = responseFor(range.endContainer);
  if (
    !startResponse ||
    startResponse !== endResponse ||
    !transcript.contains(startResponse)
  ) {
    return null;
  }

  const quote = selection.toString();
  if (!quote.trim()) return null;

  const responseId = startResponse.dataset.localChatAssistantResponseId;
  if (!responseId) return null;

  return {
    responseId,
    itemId: startResponse.dataset.localChatAssistantItemId || null,
    quote,
    ...contextAroundQuote(startResponse, range, quote),
  };
}

function quoteLines(quote: string): string {
  return quote
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/** Format pending comments as readable quoted context for the existing text send API. */
export function formatTextCommentsForReply(
  comments: readonly PendingTextComment[],
  followUp: string
): string {
  const sections = comments.map((comment, index) => {
    const context = `${comment.contextBefore}⟦selection⟧${comment.contextAfter}`;
    const lines = [`${index + 1}. Selected text:`, quoteLines(comment.quote)];
    if (comment.contextBefore || comment.contextAfter) {
      lines.push(`Nearby context: ${context}`);
    }
    lines.push(`Comment: ${comment.body.trim()}`);
    return lines.join("\n");
  });

  const message = [
    `Comments on the previous response:\n\n${sections.join("\n\n")}`,
  ];
  if (followUp.trim()) message.push(`Follow-up:\n${followUp.trim()}`);
  return message.join("\n\n");
}

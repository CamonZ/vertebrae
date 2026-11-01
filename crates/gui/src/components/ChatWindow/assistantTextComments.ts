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
  kind: "text";
  id: string;
  body: string;
}

/** Where a diff comment was written. */
export type DiffCommentHome =
  | { kind: "worktree"; wholeBranch: boolean }
  | {
      kind: "tool_call";
      /** Provider tool-call id of the recorded worktree patch. */
      toolUseId: string;
      /** Tool name at comment time, for the message label. */
      toolName?: string;
    };

/**
 * A line comment on a diff: attached to path, side and line range of its home
 * patch, never to quoted text or file contents.
 */
export interface PendingDiffComment {
  kind: "diff";
  id: string;
  body: string;
  home: DiffCommentHome;
  path: string;
  side: "new" | "old";
  startLine: number;
  /** Equal to `startLine` for a single line. */
  endLine: number;
  /** Hunk text from the `@@` header through the last commented row. */
  hunk: string;
  /** The home patch changed since the hunk was captured. */
  outdated: boolean;
}

export type PendingComment = PendingTextComment | PendingDiffComment;

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

function textCommentEntry(comment: PendingTextComment, number: number): string {
  const context = `${comment.contextBefore}⟦selection⟧${comment.contextAfter}`;
  const lines = [`${number}. Selected text:`, quoteLines(comment.quote)];
  if (comment.contextBefore || comment.contextAfter) {
    lines.push(`Nearby context: ${context}`);
  }
  lines.push(`Comment: ${comment.body.trim()}`);
  return lines.join("\n");
}

/** The label a message and a chip give the patch a diff comment lives on. */
export function diffCommentHomeLabel(comment: PendingDiffComment): string {
  if (comment.home.kind === "worktree") return "All Changes";
  const name = comment.home.toolName?.trim();
  return name
    ? `Tool call ${name} ${comment.path}`
    : `Tool call ${comment.path}`;
}

/** `path:start[-end]` for a diff comment. */
export function diffCommentLocation(comment: PendingDiffComment): string {
  const range =
    comment.endLine === comment.startLine
      ? `${comment.startLine}`
      : `${comment.startLine}-${comment.endLine}`;
  return `${comment.path}:${range}`;
}

const ENTRY_INDENT = "   ";

function diffCommentEntry(comment: PendingDiffComment, number: number): string {
  const longestRun = Math.max(
    0,
    ...(comment.hunk.match(/`+/g) ?? []).map((run) => run.length)
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  const heading = [
    `${number}. ${diffCommentHomeLabel(comment)} · ${diffCommentLocation(comment)} (${comment.side})`,
    comment.outdated ? " [outdated]" : "",
  ].join("");
  const lines = [
    `${fence}diff`,
    ...comment.hunk.split("\n"),
    fence,
    `Comment: ${comment.body.trim()}`,
  ].flatMap((line) => line.split("\n"));
  return [heading, ...lines.map((line) => `${ENTRY_INDENT}${line}`)].join("\n");
}

function commentsHeading(comments: readonly PendingComment[]): string {
  const hasText = comments.some((comment) => comment.kind === "text");
  const hasDiff = comments.some((comment) => comment.kind === "diff");
  if (hasText && hasDiff) {
    return "Comments on the previous response and on the worktree changes";
  }
  return hasDiff
    ? "Review comments on the worktree changes"
    : "Comments on the previous response";
}

/**
 * Format pending comments (selected assistant text and diff line comments) as
 * one readable message for the existing text send API.
 */
export function formatTextCommentsForReply(
  comments: readonly PendingComment[],
  followUp: string
): string {
  const sections = comments.map((comment, index) =>
    comment.kind === "diff"
      ? diffCommentEntry(comment, index + 1)
      : textCommentEntry(comment, index + 1)
  );

  const message = [`${commentsHeading(comments)}:\n\n${sections.join("\n\n")}`];
  if (followUp.trim()) message.push(`Follow-up:\n${followUp.trim()}`);
  return message.join("\n\n");
}

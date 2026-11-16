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
  | { kind: "worktree"; wholeBranch: boolean; comparisonIdentity?: string }
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
  /** Exact selected code for an explicit main-composer attachment. */
  selectionCode?: string;
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
const ENTRY_INDENT = "   ";

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

/** Collapse whitespace so nearby context reads as one line. */
function flatten(text: string): string {
  return text.replace(/\s+/g, " ");
}

/**
 * Context before a selection with whitespace collapsed, dropping a first word
 * the fixed-length capture may have cut.
 */
function leadingContext(text: string): string {
  const flat = flatten(text);
  if (!flat.trim()) return "";
  const cut = flat.indexOf(" ");
  // Context is captured at a fixed length, so its first word may be partial.
  return flat.length >= CONTEXT_LENGTH && cut >= 0
    ? `…${flat.slice(cut + 1)}`
    : flat.trimStart();
}

/** Context after a selection, dropping a cut last word. */
function trailingContext(text: string): string {
  const flat = flatten(text);
  if (!flat.trim()) return "";
  const cut = flat.lastIndexOf(" ");
  return flat.length >= CONTEXT_LENGTH && cut >= 0
    ? `${flat.slice(0, cut)}…`
    : flat.trimEnd();
}

/** Bold one line of the selection, keeping surrounding spaces outside. */
function emphasize(line: string): string {
  const core = line.trim();
  if (!core || core.includes("**")) return line;
  const lead = line.slice(0, line.indexOf(core));
  const tail = line.slice(lead.length + core.length);
  return `${lead}**${core}**${tail}`;
}

const PUNCTUATION = /[\p{P}\p{S}]/u;
const isPunctuation = (char: string | undefined) =>
  char !== undefined && PUNCTUATION.test(char);
const isWordChar = (char: string | undefined) =>
  char !== undefined && !/\s/.test(char) && !isPunctuation(char);

/**
 * `**` between a letter and punctuation does not open or close bold in
 * CommonMark (selecting "(" in "(a)" would send `**(**a)` literally). A
 * selection edge cut mid-word next to punctuation gets a space instead.
 */
function joinAtSelectionEdge(left: string, right: string): string {
  const opens = right.startsWith("**") && isPunctuation(right[2]);
  const closes = left.endsWith("**") && isPunctuation(left.at(-3));
  const gap =
    (opens && isWordChar(left.at(-1))) || (closes && isWordChar(right[0]));
  return gap ? `${left} ${right}` : `${left}${right}`;
}

/** Context before + bolded selection + context after, as quoted lines. */
function quotedSelection(comment: PendingTextComment): string[] {
  const lines = comment.quote
    .replace(/\r\n?/g, "\n")
    .replace(/^\n+|\n+$/g, "")
    .split("\n")
    .map(emphasize);
  const last = lines.length - 1;
  lines[0] = joinAtSelectionEdge(
    leadingContext(comment.contextBefore),
    lines[0]
  );
  lines[last] = joinAtSelectionEdge(
    lines[last],
    trailingContext(comment.contextAfter)
  );
  return lines.map((line) => (line.trim() ? `> ${line}` : ">"));
}

/** Indent a block so it stays inside its numbered list item. */
function indent(lines: readonly string[]): string[] {
  return lines.map((line) => (line ? `${ENTRY_INDENT}${line}` : ""));
}

/** The reply after a quote or diff: plain text, separated by a blank line. */
function replyLines(body: string): string[] {
  const reply = body.trim();
  return reply ? ["", ...reply.split("\n")] : [];
}

function textCommentEntry(comment: PendingTextComment, number: number): string {
  return [
    `${number}. Selected text:`,
    ...indent([...quotedSelection(comment), ...replyLines(comment.body)]),
  ].join("\n");
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

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
/** Rows of unselected context kept before the selection in a reply. */
const REPLY_CONTEXT_ROWS = 3;

/**
 * The captured hunk cut down to the selected rows and a few rows before
 * them, with a header recomputed for that slice. The stored hunk runs from
 * the `@@` header, which can be far above the selection.
 */
export function replyHunk(comment: PendingDiffComment): string {
  const [header, ...rest] = comment.hunk.split("\n");
  const match = HUNK_HEADER.exec(header);
  if (!match) return comment.hunk;

  // An empty side names the line before it, as in unified diff.
  let oldLine = Number(match[1]) + (match[2] === "0" ? 1 : 0);
  let newLine = Number(match[3]) + (match[4] === "0" ? 1 : 0);
  const rows = rest.map((text) => {
    const sign = text[0];
    const row = { text, oldLine, newLine, counts: sign !== "\\" };
    if (sign === " " || sign === "-") oldLine++;
    if (sign === " " || sign === "+") newLine++;
    return row;
  });
  const first = rows.findIndex(
    (row) =>
      row.counts &&
      (comment.side === "old" ? row.text[0] !== "+" : row.text[0] !== "-") &&
      (comment.side === "old" ? row.oldLine : row.newLine) === comment.startLine
  );
  if (first < 0) return comment.hunk;

  let from = first;
  for (let kept = 0; from > 0 && kept < REPLY_CONTEXT_ROWS; ) {
    from--;
    if (rows[from].counts) kept++;
  }
  // A "no newline" marker belongs to the row above it.
  while (from > 0 && !rows[from].counts) from--;
  const slice = rows.slice(from);
  const oldCount = slice.filter(
    (row) => row.counts && row.text[0] !== "+"
  ).length;
  const newCount = slice.filter(
    (row) => row.counts && row.text[0] !== "-"
  ).length;
  const range = (start: number, count: number) =>
    `${count === 0 ? start - 1 : start},${count}`;

  return [
    `@@ -${range(slice[0].oldLine, oldCount)} +${range(slice[0].newLine, newCount)} @@${match[5]}`,
    ...slice.map((row) => row.text),
  ].join("\n");
}

function diffCommentEntry(comment: PendingDiffComment, number: number): string {
  const hunk = replyHunk(comment);
  const longestRun = Math.max(
    0,
    ...(hunk.match(/`+/g) ?? []).map((run) => run.length)
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  const heading = [
    `${number}. ${diffCommentHomeLabel(comment)} · ${diffCommentLocation(comment)} (${comment.side})`,
    comment.outdated ? " [outdated]" : "",
  ].join("");

  return [
    heading,
    ...indent([
      `${fence}diff`,
      ...hunk.split("\n"),
      fence,
      ...replyLines(comment.body),
    ]),
  ].join("\n");
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

/**
 * Reads a sent comment set back out of the user message text that
 * formatTextCommentsForReply produced, so the user turn can show structured
 * quote cards. The agent payload is plain text and is never changed here;
 * anything this reader does not recognise renders as ordinary text.
 */

const HEADINGS = [
  "Comments on the previous response and on the worktree changes",
  "Review comments on the worktree changes",
  "Comments on the previous response",
] as const;

export type SentCommentsHeading = (typeof HEADINGS)[number];

/** One `context **selection** context` line of a quoted selection. */
export interface QuoteSegment {
  text: string;
  selected: boolean;
}

export interface SentTextComment {
  kind: "text";
  number: number;
  /** Quote lines; selected runs are the bolded part of each line. */
  lines: QuoteSegment[][];
  /** The selection alone, one entry per quoted line. */
  selection: string;
  /** Context shown before the selection, with any `…` marker removed. */
  contextBefore: string;
  /** Context shown after the selection, with any `…` marker removed. */
  contextAfter: string;
  body: string;
}

export interface SentDiffComment {
  kind: "diff";
  number: number;
  /** "All Changes" or "Tool call …", as written in the message. */
  home: string;
  path: string;
  startLine: number;
  endLine: number;
  side: "new" | "old";
  outdated: boolean;
  hunk: string;
  body: string;
}

export type SentComment = SentTextComment | SentDiffComment;

export interface SentCommentSet {
  heading: SentCommentsHeading;
  comments: SentComment[];
  followUp: string;
}

const INDENT = "   ";
const FOLLOW_UP = "\n\nFollow-up:\n";
const ENTRY_START = /^(\d+)\. (.*)$/;
const DIFF_HEADING =
  /^(.+) · (.+):(\d+)(?:-(\d+)) \((new|old)\)( \[outdated\])?$/;
const DIFF_HEADING_SINGLE = /^(.+) · (.+):(\d+) \((new|old)\)( \[outdated\])?$/;
const FENCE = /^(`{3,})diff$/;

/** Bold runs split out of one quote line. */
function quoteSegments(line: string): QuoteSegment[] {
  const segments: QuoteSegment[] = [];
  const pattern = /\*\*(.+?)\*\*/g;
  let last = 0;
  for (const match of line.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last)
      segments.push({ text: line.slice(last, index), selected: false });
    segments.push({ text: match[1], selected: true });
    last = index + match[0].length;
  }
  if (last < line.length)
    segments.push({ text: line.slice(last), selected: false });
  return segments;
}

/** Lines of one numbered entry, its indentation removed; null if malformed. */
function dedent(lines: readonly string[]): string[] | null {
  const out: string[] = [];
  for (const line of lines) {
    if (line === "") out.push("");
    else if (line.startsWith(INDENT)) out.push(line.slice(INDENT.length));
    else return null;
  }
  return out;
}

/** The reply after a blank line, or "" when the entry has none. */
function replyAfter(lines: readonly string[]): string | null {
  if (lines.length === 0) return "";
  if (lines[0] !== "") return null;
  return lines.slice(1).join("\n");
}

function textEntry(
  number: number,
  title: string,
  lines: readonly string[]
): SentTextComment | null {
  if (title !== "Selected text:") return null;
  const end = lines.findIndex((line) => !line.startsWith(">"));
  const quoteLines = (end < 0 ? lines : lines.slice(0, end)).map((line) =>
    line === ">" ? "" : line.startsWith("> ") ? line.slice(2) : null
  );
  if (quoteLines.length === 0 || quoteLines.some((line) => line === null))
    return null;
  const body = replyAfter(end < 0 ? [] : lines.slice(end));
  if (body === null) return null;

  const segmented = (quoteLines as string[]).map(quoteSegments);
  const flat = segmented.flat();
  const firstSelected = flat.findIndex((segment) => segment.selected);
  let lastSelected = flat.length - 1;
  while (lastSelected >= 0 && !flat[lastSelected].selected) lastSelected--;
  const trimMarker = (value: string) => value.replace(/^…|…$/g, "");
  return {
    kind: "text",
    number,
    lines: segmented,
    selection: segmented
      .map((line) =>
        line
          .filter((segment) => segment.selected)
          .map((segment) => segment.text)
          .join("")
      )
      .filter(Boolean)
      .join("\n"),
    contextBefore:
      firstSelected > 0
        ? trimMarker(
            flat
              .slice(0, firstSelected)
              .map((segment) => segment.text)
              .join("")
          )
        : "",
    contextAfter:
      lastSelected >= 0
        ? trimMarker(
            flat
              .slice(lastSelected + 1)
              .map((segment) => segment.text)
              .join("")
          )
        : "",
    body,
  };
}

function diffEntry(
  number: number,
  title: string,
  lines: readonly string[]
): SentDiffComment | null {
  const range = DIFF_HEADING.exec(title);
  const single = range ? null : DIFF_HEADING_SINGLE.exec(title);
  if (!range && !single) return null;
  const fence = FENCE.exec(lines[0] ?? "");
  if (!fence) return null;
  const close = lines.indexOf(fence[1], 1);
  if (close < 0) return null;
  const body = replyAfter(lines.slice(close + 1));
  if (body === null) return null;

  const [home, path, start, end, side, outdated] = range
    ? [range[1], range[2], range[3], range[4], range[5], range[6]]
    : [single![1], single![2], single![3], single![3], single![4], single![5]];
  return {
    kind: "diff",
    number,
    home,
    path,
    startLine: Number(start),
    endLine: Number(end),
    side: side as "new" | "old",
    outdated: !!outdated,
    hunk: lines.slice(1, close).join("\n"),
    body,
  };
}

/**
 * The structured form of a message sent with pending comments, or null when
 * the text is not exactly in that shape.
 */
export function parseSentComments(text: string): SentCommentSet | null {
  const heading = HEADINGS.find((candidate) =>
    text.startsWith(`${candidate}:\n\n`)
  );
  if (!heading) return null;

  let rest = text.slice(heading.length + 3);
  let followUp = "";
  // Comment lines are indented, so the first unindented Follow-up line
  // always belongs to the message, never to a comment.
  const split = rest.indexOf(FOLLOW_UP);
  if (split >= 0) {
    followUp = rest.slice(split + FOLLOW_UP.length);
    rest = rest.slice(0, split);
    if (!followUp.trim()) return null;
  }

  const comments: SentComment[] = [];
  const lines = rest.split("\n");
  let index = 0;
  while (index < lines.length) {
    const start = ENTRY_START.exec(lines[index]);
    if (!start || Number(start[1]) !== comments.length + 1) return null;
    let next = index + 1;
    while (next < lines.length && !ENTRY_START.exec(lines[next])) next++;
    const entry = lines.slice(index + 1, next);
    // Entries are separated by one blank line.
    if (next < lines.length) {
      if (entry[entry.length - 1] !== "") return null;
      entry.pop();
    }
    const body = dedent(entry);
    if (!body) return null;
    const number = comments.length + 1;
    const comment =
      textEntry(number, start[2], body) ?? diffEntry(number, start[2], body);
    if (!comment) return null;
    comments.push(comment);
    index = next;
  }
  return comments.length ? { heading, comments, followUp } : null;
}

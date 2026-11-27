import type {
  ComparisonSnapshot,
  GithubReviewThread,
  ReviewAnchorLocation,
  ReviewLineRange,
} from "../../../../bindings";
import type { ChatMessage } from "../../../../stores/chatStore";
import type { PendingGithubThreadComment } from "../../assistantTextComments";
import type {
  CodeSelection,
  SelectionThread,
} from "../../selectionDiscussions";
import type { WorktreeSnapshot } from "../../../thread/toolChange/diffComments";
import { selectedCode } from "../../../thread/toolChange/diffCursor";
import { authorOf, type PlacedThread } from "./model";

/** Where a GitHub thread's private discussion captures its code. */
export interface GithubDiscussionTarget {
  githubThreadId: string;
  location: ReviewAnchorLocation;
  range: ReviewLineRange;
}

/** Whether a thread has lines here to discuss (see `githubDiscussionTarget`). */
export function canDiscussGithub(placed: PlacedThread): boolean {
  switch (placed.kind) {
    case "line":
      return placed.drift.kind !== "unverified";
    case "outdated":
      return placed.originalCommit !== null && placed.originalLine !== null;
    case "file":
    case "unplaceable":
      return false;
  }
}

/**
 * The lines a GitHub thread is commented on, read from the commit that has
 * them: the shown comparison's side for unchanged lines (as a selection
 * there is captured), the published commit for lines edited locally (the
 * code reviewers see), the original diff's commit for an outdated thread.
 * Null when there are no such lines here: a file-level, not shown or
 * unplaceable thread, or one whose commit is not in this clone.
 */
export function githubDiscussionTarget(
  placed: PlacedThread,
  comparison: ComparisonSnapshot
): GithubDiscussionTarget | null {
  const { thread } = placed;
  const { path, side } = thread.anchor;
  const at = (commit: string | null, startLine: number, line: number) => ({
    githubThreadId: thread.id,
    location: { path, side, source: { kind: "worktree", commit } } as const,
    range: { startLine, line },
  });
  switch (placed.kind) {
    case "line":
      if (placed.drift.kind === "unverified") return null;
      if (placed.drift.kind === "edited")
        return at(placed.drift.commit, placed.startLine, placed.line);
      return at(
        side === "LEFT"
          ? comparison.base_commit
          : comparison.working_tree
            ? null
            : comparison.target_commit,
        placed.startLine,
        placed.line
      );
    case "outdated":
      return placed.originalCommit !== null && placed.originalLine !== null
        ? at(
            placed.originalCommit,
            placed.originalStartLine ?? placed.originalLine,
            placed.originalLine
          )
        : null;
    case "file":
    case "unplaceable":
      return null;
  }
}

/**
 * The anchor a GitHub thread's discussion keeps: the captured lines, in the
 * shown file when the comparison has it. GitHub's placement draws it, so the
 * anchor only labels it and carries the code.
 */
export function githubDiscussionAnchor(
  { location: { path, side }, range }: GithubDiscussionTarget,
  code: string,
  snapshot: WorktreeSnapshot | null
): CodeSelection {
  const diffSide = side === "LEFT" ? "old" : "new";
  const file = snapshot?.files.find(
    (file) => (diffSide === "old" ? file.oldPath : file.newPath) === path
  ) ?? {
    oldPath: diffSide === "old" ? path : null,
    newPath: diffSide === "new" ? path : null,
    hunks: [],
  };
  return {
    path,
    side: diffSide,
    startLine: range.startLine,
    endLine: range.line,
    code,
    file,
    home: { kind: "worktree", wholeBranch: snapshot?.wholeBranch ?? false },
  };
}

/** The GitHub thread a private discussion's first turn carries. */
export interface GithubDiscussionContext {
  resolved: boolean;
  outdated: boolean;
  comments: { author: string; body: string; createdAt: string | null }[];
  /** GitHub returned only the first comments of a longer thread. */
  commentsTruncated: boolean;
}

export function githubDiscussionContext(
  thread: GithubReviewThread
): GithubDiscussionContext {
  return {
    resolved: thread.resolved,
    outdated: thread.anchor.outdated,
    comments: thread.comments.map((comment) => ({
      author: authorOf(comment),
      body: comment.body,
      createdAt: comment.createdAt,
    })),
    commentsTruncated: thread.commentsTruncated,
  };
}

/** The question and reply text of a discussion's transcript, in order. */
export function discussionTurns(
  messages: readonly ChatMessage[]
): PendingGithubThreadComment["turns"] {
  return messages.flatMap((message) =>
    (message.kind === "user" || message.kind === "assistant") &&
    !(message.kind === "assistant" && message.parentToolUseId) &&
    message.text.trim()
      ? [{ role: message.kind, text: message.text }]
      : []
  );
}

/** Where a GitHub thread's attachment points: its lines and their code. */
export type GithubThreadPlace = Pick<
  PendingGithubThreadComment,
  "path" | "side" | "startLine" | "endLine" | "code"
>;

/** A discussion's place: the lines it captured. */
export function discussionPlace({
  anchor,
}: SelectionThread): GithubThreadPlace {
  return {
    path: anchor.path,
    side: anchor.side,
    startLine: anchor.startLine,
    endLine: anchor.endLine,
    code: anchor.code,
  };
}

/**
 * A thread's place without a discussion: the lines it is commented on,
 * with their code as the shown diff (or, edited or outdated, the published
 * or original snippet) has it;
 * else GitHub's own anchor lines, without code. A file-level comment has no
 * lines.
 */
export function githubThreadPlace(
  placed: PlacedThread,
  comparison: ComparisonSnapshot | null,
  snapshot: WorktreeSnapshot | null
): GithubThreadPlace {
  const { anchor } = placed.thread;
  const side = anchor.side === "LEFT" ? "old" : "new";
  const target = comparison && githubDiscussionTarget(placed, comparison);
  if (target) {
    const { startLine, line } = target.range;
    const snippet =
      placed.kind === "outdated"
        ? placed.original
        : placed.kind === "line" && placed.drift.kind === "edited"
          ? placed.published
          : null;
    const code = snippet
      ? snippet
          .filter(({ number }) => startLine <= number && number <= line)
          .map(({ text }) => text)
          .join("\n")
      : shownCode(snapshot, anchor.path, side, startLine, line);
    return { path: anchor.path, side, startLine, endLine: line, code };
  }
  const line = anchor.fileLevel ? null : (anchor.line ?? anchor.originalLine);
  const start = anchor.startLine ?? anchor.originalStartLine ?? line;
  return {
    path: anchor.path,
    side,
    startLine: line === null ? null : start,
    endLine: line,
    code: "",
  };
}

/** The lines as the shown diff has them; empty when it does not show them. */
function shownCode(
  snapshot: WorktreeSnapshot | null,
  path: string,
  side: "new" | "old",
  startLine: number,
  line: number
): string {
  const diffSide = side === "old" ? "deletions" : "additions";
  const file = snapshot?.files.find(
    (file) => (side === "old" ? file.oldPath : file.newPath) === path
  );
  if (!file) return "";
  return (
    selectedCode(
      file,
      { layout: "split" },
      { start: startLine, end: line, side: diffSide, endSide: diffSide }
    ) ?? ""
  );
}

/**
 * Send to main chat for a GitHub thread: the thread as GitHub has it and,
 * when it has one, its private discussion so far. An unsent question stays
 * the discussion's draft; the note is written in the main composer.
 */
export function githubThreadAttachment(
  githubThreadId: string,
  /** As the PR's review state has it; undefined once it no longer does. */
  thread: GithubReviewThread | undefined,
  place: GithubThreadPlace,
  discussion: { id: string; messages: readonly ChatMessage[] } | null,
  id: string
): PendingGithubThreadComment {
  return {
    kind: "github_thread",
    id,
    body: "",
    githubThreadId,
    discussionId: discussion?.id ?? null,
    ...place,
    author: thread ? authorOf(thread.comments[0]) : null,
    comments: (thread?.comments ?? []).map((comment) => ({
      author: authorOf(comment),
      body: comment.body,
    })),
    turns: discussion ? discussionTurns(discussion.messages) : [],
  };
}

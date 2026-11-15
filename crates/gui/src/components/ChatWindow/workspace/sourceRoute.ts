import type { FileDiffMetadata } from "@pierre/diffs";
import type { WorktreeChange } from "../../../bindings";
import type { JumpTarget } from "./AllChangesView";

/** Lines to select and scroll to in a full-file document. */
export interface FileReveal {
  path: string;
  line: number;
  endLine: number;
  /** Distinguishes repeated reveals of the same lines. */
  nonce: number;
}

/**
 * Where the Changes workspace shows a code reference: its diff in All
 * Changes when the referenced lines changed, else the full file.
 */
export type SourceRoute =
  | { view: "diff"; target: JumpTarget }
  | { view: "file"; path: string; reveal: FileReveal | null };

interface Span {
  /** First line of the change group on the referenced side. */
  start: number;
  /** Lines the group occupies on that side; `0` for a pure insertion. */
  count: number;
  /** Lines the group adds when read from old to new. */
  delta: number;
}

/** Each change group's position on one side of the diff. */
function changeSpans(diff: FileDiffMetadata, side: "old" | "new"): Span[] {
  const spans: Span[] = [];
  for (const hunk of diff.hunks) {
    for (const content of hunk.hunkContent) {
      if (content.type !== "change") continue;
      const delta = content.additions - content.deletions;
      spans.push(
        side === "new"
          ? {
              start:
                hunk.additionStart +
                content.additionLineIndex -
                hunk.additionLineIndex,
              count: content.additions,
              delta,
            }
          : {
              start:
                hunk.deletionStart +
                content.deletionLineIndex -
                hunk.deletionLineIndex,
              count: content.deletions,
              delta,
            }
      );
    }
  }
  return spans;
}

/**
 * Whether lines `line..endLine` touch a change group. A group occupying no
 * lines on this side sits between `start - 1` and `start`, so a range
 * spanning that boundary includes it.
 */
const touches = ({ start, count }: Span, line: number, endLine: number) =>
  count > 0
    ? line < start + count && endLine >= start
    : line <= start && endLine >= start - 1;

/** The new-side number of an unchanged old-side line. */
const newLine = (spans: Span[], line: number) =>
  spans.reduce(
    (result, span) =>
      (span.count > 0 ? span.start + span.count <= line : span.start <= line)
        ? result + span.delta
        : result,
    line
  );

/**
 * Routes a working-copy reference between the All Changes diff and the full
 * file. `files` and `parsed` are the loaded comparison, index-aligned.
 */
export function routeSource(
  target: JumpTarget,
  files: readonly WorktreeChange[],
  parsed: readonly { files: FileDiffMetadata[] | null }[]
): SourceRoute {
  const index = files.findIndex(
    (file) =>
      file.path === target.path ||
      (target.side === "old" && file.old_path === target.path)
  );
  const change = index >= 0 ? files[index] : undefined;
  const diff = parsed[index]?.files?.[0];
  const reveal = (path: string, line: number, endLine: number) => ({
    view: "file" as const,
    path,
    reveal: { path, line, endLine, nonce: target.nonce },
  });

  if (!change) {
    if (target.line === undefined)
      return { view: "file", path: target.path, reveal: null };
    return reveal(
      target.path,
      target.line,
      Math.max(target.endLine ?? target.line, target.line)
    );
  }

  // Whole-file references, added, deleted and textless changes are the diff.
  const diffRoute = {
    view: "diff" as const,
    target: { ...target, path: change.path },
  };
  if (
    target.line === undefined ||
    change.marker != null ||
    change.status === "added" ||
    change.status === "deleted" ||
    !diff
  )
    return diffRoute;

  const side = target.side === "old" ? "old" : "new";
  const line = target.line;
  const endLine = Math.max(target.endLine ?? line, line);
  const spans = changeSpans(diff, side);
  if (spans.some((span) => touches(span, line, endLine))) return diffRoute;

  // The full file is the working copy, so old-side lines are renumbered.
  return side === "old"
    ? reveal(change.path, newLine(spans, line), newLine(spans, endLine))
    : reveal(change.path, line, endLine);
}

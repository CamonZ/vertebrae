/**
 * Pure comment-level logic for diff review: where a pending diff comment is
 * shown (its home patch and every projected location), capturing a comment
 * from a gutter selection, and marking All Changes comments outdated when
 * their patch changes. Line arithmetic lives in `diffLineMapper`.
 */
import type {
  DiffCommentHome,
  PendingComment,
  PendingDiffComment,
} from "../../ChatWindow/assistantTextComments";
import type { ToolAnnotations } from "../../../stores/toolAnnotations";
import {
  canonicalPath,
  captureHunk,
  findRow,
  parsePatch,
  projectToolRowToWorktree,
  projectWorktreeRowToToolCall,
  rowLine,
  spanRows,
  type DiffSide,
  type FilePatch,
  type LineSpan,
  type ToolPatch,
} from "./diffLineMapper";
import { parseWorktreeDelta } from "./worktreeDelta";

/** The All Changes patch as last loaded, parsed. */
export interface WorktreeSnapshot {
  wholeBranch: boolean;
  files: readonly FilePatch[];
}

export type ReviewSurface =
  | { kind: "worktree" }
  | { kind: "tool_call"; toolUseId: string };

/** One place a comment is drawn. */
export interface Placement {
  commentId: string;
  surface: ReviewSurface;
  /** The file's canonical path in the surface's patch. */
  path: string;
  side: DiffSide;
  startLine: number;
  /** The annotation is drawn after this line; 0 for a file-level comment. */
  endLine: number;
  /** The comment lives here (rather than being projected from elsewhere). */
  home: boolean;
}

export function parseWorktreeSnapshot(
  wholeBranch: boolean,
  patches: readonly string[]
): WorktreeSnapshot {
  return {
    wholeBranch,
    files: patches.flatMap((patch) => (patch ? parsePatch(patch) : [])),
  };
}

/**
 * Recorded worktree patches in the order they were recorded. Entries without
 * a usable patch are skipped.
 */
export function buildToolChain(
  annotations: ToolAnnotations | undefined
): ToolPatch[] {
  const entries: Array<{
    id: string;
    at: number;
    order: number;
    patch: string;
  }> = [];
  let order = 0;
  for (const [id, byKind] of Object.entries(annotations ?? {})) {
    const annotation = byKind.worktree_delta;
    const delta = annotation && parseWorktreeDelta(annotation.payload);
    if (!annotation || !delta || delta.patch.trim().length === 0) continue;
    const at = Date.parse(annotation.recorded_at);
    entries.push({
      id,
      at: Number.isNaN(at) ? 0 : at,
      order: order++,
      patch: delta.patch,
    });
  }
  entries.sort((a, b) => a.at - b.at || a.order - b.order);
  return entries.map(({ id, patch }) => ({ id, files: parsePatch(patch) }));
}

/** Split sorted-or-not line numbers into runs of consecutive lines. */
function runsOf(lines: readonly number[]): Array<[number, number]> {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const runs: Array<[number, number]> = [];
  for (const line of sorted) {
    const last = runs[runs.length - 1];
    if (last && line === last[1] + 1) last[1] = line;
    else runs.push([line, line]);
  }
  return runs;
}

function fileFor(
  files: readonly FilePatch[],
  path: string
): FilePatch | undefined {
  return files.find((file) => canonicalPath(file) === path);
}

function span(comment: PendingDiffComment): LineSpan {
  return {
    side: comment.side,
    startLine: comment.startLine,
    endLine: comment.endLine,
  };
}

function homePlacement(
  comment: PendingDiffComment,
  surface: ReviewSurface,
  file: FilePatch
): Placement {
  // Outdated comments stay at their last known lines, or at file level when
  // those lines are gone.
  const shown = spanRows(file, span(comment)) !== null;
  return {
    commentId: comment.id,
    surface,
    path: comment.path,
    side: comment.side,
    startLine: shown ? comment.startLine : 0,
    endLine: shown ? comment.endLine : 0,
    home: true,
  };
}

/**
 * Every place the pending diff comments are drawn.
 *
 * A comment is always drawn on its home patch (when that patch is loaded). A
 * tool-call comment is also drawn on All Changes where its line exists; an
 * All Changes comment is also drawn on the one tool call that produced each
 * of its lines. Outdated All Changes comments are not projected.
 */
export function computePlacements(
  comments: readonly PendingComment[],
  chain: readonly ToolPatch[],
  worktree: WorktreeSnapshot | null
): Placement[] {
  const placements: Placement[] = [];
  for (const comment of comments) {
    if (comment.kind !== "diff") continue;
    if (comment.home.kind === "tool_call") {
      const toolUseId = comment.home.toolUseId;
      const index = chain.findIndex((patch) => patch.id === toolUseId);
      const file = index >= 0 && fileFor(chain[index].files, comment.path);
      if (!file) continue;
      placements.push(
        homePlacement(comment, { kind: "tool_call", toolUseId }, file)
      );
      if (!worktree) continue;
      const landed = new Map<FilePatch, number[]>();
      for (let line = comment.startLine; line <= comment.endLine; line++) {
        const row = findRow(file, comment.side, line)?.row;
        const target =
          row &&
          projectToolRowToWorktree(chain, index, file, row, worktree.files);
        const number = target && rowLine(target.location.row, comment.side);
        if (target && number != null) {
          landed.set(target.file, [...(landed.get(target.file) ?? []), number]);
        }
      }
      for (const [target, lines] of landed) {
        for (const [startLine, endLine] of runsOf(lines)) {
          placements.push({
            commentId: comment.id,
            surface: { kind: "worktree" },
            path: canonicalPath(target),
            side: comment.side,
            startLine,
            endLine,
            home: false,
          });
        }
      }
      continue;
    }

    const file = worktree && fileFor(worktree.files, comment.path);
    if (!worktree || !file) continue;
    placements.push(homePlacement(comment, { kind: "worktree" }, file));
    if (comment.outdated) continue;
    const landed = new Map<string, { file: FilePatch; lines: number[] }>();
    for (let line = comment.startLine; line <= comment.endLine; line++) {
      const row = findRow(file, comment.side, line)?.row;
      const target = row && projectWorktreeRowToToolCall(chain, file, row);
      const number = target && rowLine(target.location.row, comment.side);
      if (target && number != null) {
        const toolUseId = chain[target.patchIndex].id;
        const entry = landed.get(toolUseId) ?? { file: target.file, lines: [] };
        entry.lines.push(number);
        landed.set(toolUseId, entry);
      }
    }
    for (const [toolUseId, { file: target, lines }] of landed) {
      for (const [startLine, endLine] of runsOf(lines)) {
        placements.push({
          commentId: comment.id,
          surface: { kind: "tool_call", toolUseId },
          path: canonicalPath(target),
          side: comment.side,
          startLine,
          endLine,
          home: false,
        });
      }
    }
  }
  return placements;
}

/** Build a pending comment from a resolved selection; null if no row matches. */
export function createDiffComment(input: {
  id: string;
  body: string;
  home: DiffCommentHome;
  file: FilePatch;
  span: LineSpan;
}): PendingDiffComment | null {
  const hunk = captureHunk(input.file, input.span.side, input.span.endLine);
  if (hunk === null) return null;
  return {
    kind: "diff",
    id: input.id,
    body: input.body,
    home: input.home,
    path: canonicalPath(input.file),
    side: input.span.side,
    startLine: input.span.startLine,
    endLine: input.span.endLine,
    hunk,
    outdated: false,
  };
}

/**
 * Re-evaluate All Changes comments against a freshly loaded patch (refresh,
 * baseline toggle, or HEAD moving). The hunk is rebuilt for the comment's
 * stored lines; if it differs from the captured one the comment is outdated.
 * Returns the same array when nothing changed.
 */
export function reconcileWorktreeComments(
  comments: readonly PendingComment[],
  worktree: WorktreeSnapshot
): readonly PendingComment[] {
  let changed = false;
  const next = comments.map((comment) => {
    if (comment.kind !== "diff" || comment.home.kind !== "worktree") {
      return comment;
    }
    const file = fileFor(worktree.files, comment.path);
    const rebuilt = file
      ? captureHunk(file, comment.side, comment.endLine)
      : null;
    const outdated = rebuilt !== comment.hunk;
    if (outdated === comment.outdated) return comment;
    changed = true;
    return { ...comment, outdated };
  });
  return changed ? next : comments;
}

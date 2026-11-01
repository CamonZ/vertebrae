import { createContext } from "react";
import type {
  DiffCommentHome,
  PendingDiffComment,
} from "../../ChatWindow/assistantTextComments";
import type { Placement, WorktreeSnapshot } from "./diffComments";
import type { FilePatch, LineSpan, ToolPatch } from "./diffLineMapper";

/** A request to bring one comment into view. */
export interface DiffReviewFocus {
  commentId: string;
  /** Distinguishes repeated requests for the same comment. */
  nonce: number;
}

export interface NewDiffComment {
  home: DiffCommentHome;
  file: FilePatch;
  span: LineSpan;
  body: string;
}

/**
 * Pending diff comments shared by the conversation's inline tool-call diffs
 * and the Changes overlay. Provided by ChatWindow, which owns the pending
 * comment list.
 */
export interface DiffReviewValue {
  comments: readonly PendingDiffComment[];
  /** Where each comment is drawn (home patch and projections). */
  placements: readonly Placement[];
  /** Recorded tool-call patches, oldest first. */
  chain: readonly ToolPatch[];
  /** The All Changes patch as last loaded. */
  worktree: WorktreeSnapshot | null;
  focus: DiffReviewFocus | null;
  addComment(comment: NewDiffComment): void;
  updateComment(id: string, body: string): void;
  removeComment(id: string): void;
}

export const DiffReviewContext = createContext<DiffReviewValue | null>(null);

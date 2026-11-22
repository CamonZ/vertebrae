import {
  type Result,
  type ReviewAnchorError,
  type ReviewAnchorLocation,
} from "../../bindings";
import { unwrapCommand } from "../../query/commandResult";
import type { ComparisonSnapshot } from "../../bindings";
import type { CodeSelection } from "./selectionDiscussions";

const anchorErrors: Record<ReviewAnchorError, string> = {
  not_repository: "Selection discussions require a Git repository.",
  unborn_head: "Make a first commit to start a selection discussion.",
  invalid_path: "The selected file is unavailable.",
  invalid_range: "The selected lines are unavailable.",
  parent_unavailable: "Save this chat in a Vertebrae project before starting an inline discussion.",
  catalog_unavailable: "The discussion could not be saved. Try again.",
  content_unavailable: "The selected snapshot is unavailable. Reload the file or diff and select the lines again.",
  git: "Git could not load the review anchor.",
};

export function unwrapAnchor<T>(command: Promise<Result<T, ReviewAnchorError>>) {
  return unwrapCommand(command.then((result) =>
    result.status === "ok"
      ? result
      : { status: "error", error: { message: anchorErrors[result.error] } }
  ));
}

export function supportsInlineDiscussion(anchor: CodeSelection): boolean {
  return anchor.home.kind === "worktree" || anchor.side === "new";
}

export function reviewLocation(
  anchor: CodeSelection,
  chatId: string,
  comparison?: ComparisonSnapshot
): ReviewAnchorLocation {
  const side = anchor.side === "old" ? "LEFT" : "RIGHT";
  const { home } = anchor;
  if (anchor.fullFile) {
    return { path: anchor.path, side, source: { kind: "full_file", turn: anchor.fullFile.turn } };
  }
  if (home.kind === "tool_call") {
    return {
      path: anchor.path,
      side,
      source: { kind: "tool_call", chatId, toolUseId: home.toolUseId },
    };
  }
  return {
    path: side === "LEFT" ? anchor.file.oldPath ?? anchor.path : anchor.path,
    side,
    source: {
      kind: "worktree",
      commit: side === "LEFT"
        ? comparison?.base_commit ?? null
        : comparison && !comparison.working_tree
          ? comparison.target_commit
          : null,
    },
  };
}

export function reviewRange(anchor: CodeSelection) {
  return { startLine: anchor.startLine, line: anchor.endLine };
}

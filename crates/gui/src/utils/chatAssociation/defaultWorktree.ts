import { commands, type AssociationWorktree } from "../../bindings";

export const emptyChatAssociation = {
  ticketId: null,
  ticketTitle: null,
  worktreePath: null,
  branch: null,
  lastProcessedAt: null,
  processedAtCount: 0,
  awaitingWorktree: null,
  recentWorktrees: [],
};

export async function loadMainChatWorktree(
  projectPath?: string | null
): Promise<AssociationWorktree | null> {
  if (!projectPath) return null;
  try {
    return (await commands.getMainChatWorktree(projectPath)) ?? null;
  } catch {
    // Chat can still open when its local checkout is unavailable.
    return null;
  }
}

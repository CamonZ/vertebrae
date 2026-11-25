import type { Task, WorktreeBranch } from "../bindings";
import { readRecord } from "../hooks/useChatAssociation";
import type { useChatStore } from "../stores/chatStore";
import { worktreePrKey } from "../stores/worktreePrStore";
import { isTaskDone } from "./runState";

export interface ChatPrTarget extends WorktreeBranch {
  entityId: string;
}

type SessionsState = Pick<ReturnType<typeof useChatStore.getState>, "sessions">;

/**
 * The worktree branches chats are associated with, one per branch, in a
 * stable order. The creation default is not an association yet.
 */
export function chatPrTargets(state: SessionsState): ChatPrTarget[] {
  const byKey = new Map<string, ChatPrTarget>();
  for (const session of Object.values(state.sessions)) {
    if (session.discussion) continue;
    const record = readRecord(session.association);
    if (record.defaultWorktree || !record.ticketId) continue;
    if (!record.worktreePath || !record.branch) continue;
    const key = worktreePrKey(record.worktreePath, record.branch);
    if (!byKey.has(key))
      byKey.set(key, {
        worktreePath: record.worktreePath,
        branch: record.branch,
        entityId: record.ticketId,
      });
  }
  return [...byKey.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, target]) => target);
}

/**
 * Finished and archived work stops polling. An entity still loading waits;
 * one that cannot be read (another project, deleted) keeps its PR watched.
 */
export function isWatchedEntity(
  task: Task | undefined,
  loading = false
): boolean {
  if (!task) return !loading;
  if (task.archived) return false;
  return !isTaskDone(task, task.run_controls?.active_run ?? null);
}

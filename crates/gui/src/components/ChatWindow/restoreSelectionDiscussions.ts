import { commands, type ReviewThread } from "../../bindings";
import { unwrapCommand } from "../../query/commandResult";
import type { ChatSession } from "../../stores/chatStore";
import { discussionBinding } from "../../utils/localChatDiscussion";
import { canonicalPath } from "../thread/toolChange/diffLineMapper";
import type { WorktreeSnapshot } from "../thread/toolChange/diffComments";
import type { SelectionThread } from "./selectionDiscussions";

interface SavedDiscussion {
  thread: ReviewThread;
  sessionId: string;
  code: string;
}

export async function loadWorktreeDiscussions(
  worktreePath: string,
  projectPath: string,
  parentChatId: string,
  sessions: Iterable<ChatSession>
): Promise<SavedDiscussion[]> {
  const projects = await unwrapCommand(commands.getProjects());
  const project = projects.find(({ path }) => path === projectPath);
  if (!project) return [];

  const sessionsByThread = new Map<string, string>();
  for (const session of sessions) {
    const binding = discussionBinding(session.discussion);
    if (
      binding?.parentChatId === parentChatId &&
      binding.worktreePath === worktreePath &&
      session.projectPath === projectPath
    ) {
      sessionsByThread.set(binding.reviewThreadId, session.id);
    }
  }

  const threads = await unwrapCommand(
    commands.listReviewThreads(project.project_id)
  );
  const restored = await Promise.all(
    threads.map(async (thread) => {
      const { threadId, payload } = thread;
      if (
        payload.parentChatId !== parentChatId ||
        payload.homeKind !== "worktree"
      )
        return null;
      // The discussion sidecar is the source of this checkout's identity.
      const sessionId = sessionsByThread.get(threadId);
      if (!sessionId) return null;
      const result = await commands.readReviewAnchor(worktreePath, threadId, {
        startLine: payload.originalStartLine,
        line: payload.originalLine,
      });
      return result.status === "ok"
        ? { thread, sessionId, code: result.data }
        : null;
    })
  );
  return restored.filter((record) => record !== null);
}

export function placeWorktreeDiscussions(
  records: readonly SavedDiscussion[],
  snapshot: WorktreeSnapshot
): SelectionThread[] {
  return records.flatMap(
    ({ thread: { threadId, payload }, sessionId, code }) => {
      const side = payload.side === "LEFT" ? "old" : "new";
      const file = snapshot.files.find(
        (file) =>
          (side === "old" ? file.oldPath : file.newPath) === payload.path
      );
      if (!file) return [];
      const anchor = {
        path: canonicalPath(file),
        side,
        startLine: payload.originalStartLine,
        endLine: payload.originalLine,
        file,
        code,
        home: {
          kind: "worktree",
          wholeBranch: snapshot.wholeBranch,
          comparisonIdentity: snapshot.comparisonIdentity,
        },
      } as const;
      return [
        {
          id: threadId,
          anchor,
          git: {
            original: anchor,
            capture: {
              originalBlobId: payload.originalBlobId,
              originalCommitId: payload.originalCommitId,
            },
          },
          outdated: payload.status === "outdated",
          outdatedNoted: payload.outdatedNoted,
          sessionId,
        },
      ];
    }
  );
}

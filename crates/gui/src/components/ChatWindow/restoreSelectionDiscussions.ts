import { commands, type ReviewThread } from "../../bindings";
import { errorMessage } from "../../query/commandResult";
import type { ChatSession } from "../../stores/chatStore";
import { canonicalPath, spanRows } from "../thread/toolChange/diffLineMapper";
import type { WorktreeSnapshot } from "../thread/toolChange/diffComments";
import type { FullFileSource, SelectionThread } from "./selectionDiscussions";
import { unwrapAnchor } from "./reviewAnchors";

/** `origin_ref` prefix of a GitHub review thread's private discussion. */
const GITHUB_THREAD_ORIGIN = "github-thread:";

/** The GitHub review thread a saved discussion is about, if any. */
export function githubThreadOf(originRef: string | null): string | null {
  return originRef?.startsWith(GITHUB_THREAD_ORIGIN)
    ? originRef.slice(GITHUB_THREAD_ORIGIN.length) || null
    : null;
}

interface SavedDiscussion {
  thread: ReviewThread;
  home: { kind: "worktree" } | { kind: "tool_call"; toolUseId: string };
  fullFile?: FullFileSource;
  sessionId: string | null;
  code: string | null;
  readError?: Error;
}

export interface DiscussionBindingScope {
  projectPath?: string | null;
  parentChatId: string;
  worktreePath: string;
}

export function matchesDiscussion(
  session: ChatSession,
  scope: DiscussionBindingScope,
  threadId?: string
): session is ChatSession & {
  discussion: NonNullable<ChatSession["discussion"]>;
} {
  const { discussion } = session;
  return (
    !!discussion &&
    (scope.projectPath === undefined ||
      session.projectPath === scope.projectPath) &&
    discussion.parentChatId === scope.parentChatId &&
    discussion.worktreePath === scope.worktreePath &&
    (threadId === undefined || discussion.reviewThreadId === threadId)
  );
}

export function findDiscussionSession(
  sessions: Iterable<ChatSession>,
  scope: DiscussionBindingScope,
  threadId: string
) {
  return [...sessions].find(
    (session) =>
      matchesDiscussion(session, scope, threadId) &&
      (session.backendSessionId || session.providerResumeId)
  );
}

export async function readSavedDiscussion(
  thread: ReviewThread,
  scope: DiscussionBindingScope,
  sessions: readonly ChatSession[],
  snippets: Map<string, Promise<string>>
): Promise<SavedDiscussion | null> {
  const { threadId, payload } = thread;
  if (payload.parentChatId !== scope.parentChatId) return null;
  let fullFile: FullFileSource | undefined;
  const prefix = "full-file:";
  if (payload.homeKind === "worktree" && payload.originRef?.startsWith(prefix)) {
    if (!thread.checkoutPath) return null;
    const identity: unknown = JSON.parse(payload.originRef.slice(prefix.length));
    if (identity === null) {
      fullFile = { checkout: thread.checkoutPath, turn: null };
    } else if (Array.isArray(identity) && identity.length === 2 &&
        identity[0] === scope.parentChatId && typeof identity[1] === "string") {
      fullFile = { checkout: thread.checkoutPath, turn: { sessionId: scope.parentChatId, turnId: identity[1] } };
    } else {
      return null;
    }
    scope = { ...scope, worktreePath: fullFile.checkout };
  }
  if (
    thread.checkoutPath === null
      ? !sessions.some((session) => matchesDiscussion(session, scope, threadId))
      : thread.checkoutPath !== scope.worktreePath
  )
    return null;

  let home: SavedDiscussion["home"] = { kind: "worktree" };
  if (payload.homeKind === "tool_call") {
    if (!payload.toolUseId)
      throw new Error(`Review thread ${threadId} has no tool call ID.`);
    home = { kind: "tool_call", toolUseId: payload.toolUseId };
  }
  const sessionId =
    findDiscussionSession(sessions, scope, threadId)?.id ?? null;
  let read = snippets.get(threadId);
  if (!read) {
    read = unwrapAnchor(
      commands.readReviewAnchor(scope.worktreePath, threadId, {
        startLine: payload.originalStartLine,
        line: payload.originalLine,
      })
    ).then((code) => code.replace(/\n$/, ""));
    snippets.set(threadId, read);
  }
  try {
    return { thread, home, fullFile, sessionId, code: await read };
  } catch (error) {
    if (snippets.get(threadId) === read) snippets.delete(threadId);
    return {
      thread,
      home,
      fullFile,
      sessionId,
      code: null,
      readError: new Error(
        `Could not read the original selection for ${payload.path}. ${errorMessage(error)}`
      ),
    };
  }
}

export function placeWorktreeDiscussions(
  records: readonly SavedDiscussion[],
  snapshot: WorktreeSnapshot | null
): SelectionThread[] {
  return records.map(
    ({
      thread: { threadId, payload },
      home: savedHome,
      fullFile,
      sessionId,
      code,
      readError,
    }) => {
      const side = payload.side === "LEFT" ? "old" : "new";
      const home =
        savedHome.kind === "worktree"
          ? { ...savedHome, wholeBranch: snapshot?.wholeBranch ?? false }
          : savedHome;
      const worktreeFile =
        !fullFile && home.kind === "worktree"
          ? snapshot?.files.find(
              (file) =>
                (side === "old" ? file.oldPath : file.newPath) === payload.path
            )
          : undefined;
      const file = worktreeFile ?? {
        oldPath: side === "old" ? payload.path : null,
        newPath: side === "new" ? payload.path : null,
        hunks: [],
      };
      const original = {
        path: canonicalPath(file),
        side,
        startLine: payload.originalStartLine,
        endLine: payload.originalLine,
        file,
        code: code ?? "",
        home,
        ...(fullFile ? { fullFile } : {}),
      } as const;
      const outdated = payload.status === "outdated";
      const githubThreadId = githubThreadOf(payload.originRef);
      const anchor = {
        ...original,
        startLine: payload.startLine ?? original.startLine,
        endLine: payload.line ?? original.endLine,
      };
      return {
        id: threadId,
        anchor,
        git: {
          original,
          capture: {
            originalBlobId: payload.originalBlobId,
            originalCommitId: payload.originalCommitId,
          },
        },
        status: readError
          ? { kind: "unreadable", message: readError.message }
          : {
              // GitHub places a GitHub thread's discussion, not the catalog.
              kind:
                githubThreadId !== null
                  ? "inline"
                  : outdated
                    ? "outdated"
                    : !fullFile &&
                        home.kind === "worktree" &&
                        (!worktreeFile || !spanRows(worktreeFile, anchor))
                      ? "detached"
                      : "inline",
            },
        outdatedNoted: payload.outdatedNoted,
        sessionId,
        githubThreadId,
      };
    }
  );
}

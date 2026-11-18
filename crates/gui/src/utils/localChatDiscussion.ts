import type { LocalChatDiscussionBinding } from "../bindings";
import type { ChatSession } from "../stores/chatStore";

export type LocalChatDiscussion = LocalChatDiscussionBinding | "unbound";

export function discussionBinding(discussion: LocalChatDiscussion | undefined) {
  return discussion === "unbound" ? undefined : discussion;
}

export function isOpenLocalChatConversation(
  session: ChatSession | undefined
): session is ChatSession & { status: "open"; discussion?: undefined } {
  return session?.status === "open" && !session.discussion;
}

export function normalizeDiscussionBinding(
  value: LocalChatDiscussionBinding | undefined
) {
  if (
    !value?.parentChatId ||
    typeof value.parentChatId !== "string" ||
    !value.reviewThreadId ||
    typeof value.reviewThreadId !== "string"
  )
    return undefined;
  return {
    parentChatId: value.parentChatId,
    reviewThreadId: value.reviewThreadId,
    worktreePath:
      typeof value.worktreePath === "string" && value.worktreePath
        ? value.worktreePath
        : null,
  };
}

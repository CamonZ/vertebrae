import type { ChatSession, LocalChatLifecycle } from "../stores/chatStore";
import { activeBackgroundWorkCount } from "../stores/backgroundWork";

export function isLocalChatLifecycleBusy(
  lifecycle: LocalChatLifecycle
): boolean {
  return [
    "starting",
    "resuming",
    "sending",
    "streaming",
    "compacting",
    "closing",
  ].includes(lifecycle);
}

/** Activity is independent of whether the history entry is open or closed. */
export function localChatActivityStatus(
  session: ChatSession
): "working" | "idle" {
  if (
    session.status === "closed" ||
    session.lifecycle === "closed" ||
    session.lifecycle === "error"
  ) {
    return "idle";
  }

  return session.activeTurn ||
    session.compactionActive ||
    isLocalChatLifecycleBusy(session.lifecycle ?? "idle") ||
    activeBackgroundWorkCount(session.backgroundWork) > 0
    ? "working"
    : "idle";
}

import type { useChatStore } from "../../stores/chatStore";

type DriverState = Pick<
  ReturnType<typeof useChatStore.getState>,
  "sessions" | "activeSessionId" | "paneLayout"
>;

/** Sessions with a live runtime or an open chat window, in a stable order. */
export function associationDriverSessionIds(state: DriverState): string[] {
  const open = new Set(state.paneLayout.panes.map((pane) => pane.sessionId));
  if (state.activeSessionId) open.add(state.activeSessionId);
  return Object.values(state.sessions)
    .filter((session) => session.backendSessionId || open.has(session.id))
    .map((session) => session.id)
    .sort();
}

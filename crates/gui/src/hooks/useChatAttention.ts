import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useChatStore, type ChatSession } from "../stores/chatStore";
import {
  chatAttentionRecord,
  useChatAttentionStore,
} from "../stores/chatAttentionStore";
import { localChatActivityStatus } from "../utils/localChatActivity";
import {
  chatAttentionJumpOrder,
  chatTurnSignals,
  deriveChatAttention,
  type ChatAttention,
  type ChatAttentionRecord,
} from "../utils/chatAttention";

const IDLE: ChatAttention = { state: "idle", reason: null, since: null };

function useAttentionRecord(sessionId: string): ChatAttentionRecord {
  return useChatAttentionStore(
    useShallow((state) => chatAttentionRecord(state, sessionId))
  );
}

/** The attention state of one loaded chat; idle when it is not loaded. */
export function useChatAttention(sessionId: string): ChatAttention {
  const record = useAttentionRecord(sessionId);
  return useChatStore(
    useShallow((state) => {
      const session = state.sessions[sessionId];
      return session ? deriveChatAttention(session, record) : IDLE;
    })
  );
}

/** Chats that count toward "N need you": not discussions or child threads. */
const counted = (session: ChatSession) =>
  !session.discussion && !session.providerChild;

/**
 * Chats needing the user (blocked, error, needs-you) in jump order: blocked
 * first, then oldest. Its length is the "N need you" count.
 */
export function useChatsNeedingYou(): readonly string[] {
  const attention = useChatAttentionStore(
    useShallow((state) => ({
      decisions: state.decisions,
      viewed: state.viewed,
    }))
  );
  return useChatStore(
    useShallow((state) =>
      chatAttentionJumpOrder(
        Object.values(state.sessions)
          .filter(counted)
          .map((session) => ({
            id: session.id,
            attention: deriveChatAttention(
              session,
              chatAttentionRecord(attention, session.id)
            ),
          }))
      ).map((chat) => chat.id)
    )
  );
}

/** Whether any counted chat is working; drives the launcher's running glow. */
export function useAnyChatRunning(): boolean {
  return useChatStore((state) =>
    Object.values(state.sessions).some(
      (session) =>
        counted(session) && localChatActivityStatus(session) === "working"
    )
  );
}

function windowAttended() {
  return document.visibilityState === "visible" && document.hasFocus();
}

/** Whether the app window is visible and focused, kept current. */
function useWindowAttended(): boolean {
  const [attended, setAttended] = useState(windowAttended);
  useEffect(() => {
    const update = () => setAttended(windowAttended());
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", update);
    update();
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  return attended;
}

/**
 * Marks the chat's latest completed turn viewed while the chat is shown in
 * an open panel of the focused app window, which clears your-turn and
 * needs-you for it.
 */
export function useMarkChatTurnViewed(sessionId: string, shown: boolean) {
  const panelOpen = useChatStore((state) => state.panelOpen);
  const turnKey = useChatStore((state) => {
    const session = state.sessions[sessionId];
    return session
      ? (chatTurnSignals(session.messages).completedTurn?.key ?? null)
      : null;
  });
  const attended = useWindowAttended();
  useEffect(() => {
    if (!turnKey || !shown || !panelOpen || !attended) return;
    useChatAttentionStore.getState().markTurnViewed(sessionId, turnKey);
  }, [attended, panelOpen, sessionId, shown, turnKey]);
}

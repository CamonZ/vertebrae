import { useShallow } from "zustand/react/shallow";
import { useChatAttentionDriver } from "../hooks/useChatAttentionDriver";
import { useChatStore } from "../stores/chatStore";

function ChatAttentionDriver({ sessionId }: { sessionId: string }) {
  useChatAttentionDriver(sessionId);
  return null;
}

/**
 * Runs the turn-end attention check once per loaded chat, whether or not its
 * window is mounted, so a chat finishing in the background still shows that
 * it needs the user.
 */
export function ChatAttentionDrivers() {
  const sessionIds = useChatStore(
    useShallow((s) =>
      Object.values(s.sessions)
        .filter((session) => !session.discussion)
        .map((session) => session.id)
        .sort()
    )
  );
  return (
    <>
      {sessionIds.map((sessionId) => (
        <ChatAttentionDriver key={sessionId} sessionId={sessionId} />
      ))}
    </>
  );
}

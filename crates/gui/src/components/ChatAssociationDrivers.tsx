import { useShallow } from "zustand/react/shallow";
import { useChatAssociationDriver } from "../hooks/useChatAssociation";
import { useChatStore } from "../stores/chatStore";
import { associationDriverSessionIds } from "../utils/chatAssociation/driverSessions";

function ChatAssociationDriver({ sessionId }: { sessionId: string }) {
  useChatAssociationDriver(sessionId);
  return null;
}

/**
 * Runs the chat association exactly once per live or open session, whether
 * or not its window is mounted, so a live runtime keeps its recording target.
 */
export function ChatAssociationDrivers() {
  const sessionIds = useChatStore(useShallow(associationDriverSessionIds));
  return (
    <>
      {sessionIds.map((sessionId) => (
        <ChatAssociationDriver key={sessionId} sessionId={sessionId} />
      ))}
    </>
  );
}

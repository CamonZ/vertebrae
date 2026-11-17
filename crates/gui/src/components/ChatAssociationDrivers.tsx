import { useEffect } from "react";
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
  useEffect(() => {
    // Retire the superseded cache; history now follows session annotations.
    try {
      localStorage.removeItem("vertebrae-file-reference-targets-v1");
    } catch (error) {
      console.warn("Could not remove the retired file-reference cache", error);
    }
  }, []);
  const sessionIds = useChatStore(useShallow(associationDriverSessionIds));
  return (
    <>
      {sessionIds.map((sessionId) => (
        <ChatAssociationDriver key={sessionId} sessionId={sessionId} />
      ))}
    </>
  );
}

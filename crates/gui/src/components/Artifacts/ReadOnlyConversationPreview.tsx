import type { ConversationEvent } from "../../types/conversation";
import { conversationEventsToThread, Thread } from "../thread";

interface ReadOnlyConversationPreviewProps {
  events: ConversationEvent[];
}

/**
 * A persisted transcript uses the same Thread surface as local chat. The
 * attachment is historical, so this component supplies no composer, transport,
 * prompt controls, or mutation callbacks.
 */
export function ReadOnlyConversationPreview({
  events,
}: ReadOnlyConversationPreviewProps) {
  const thread = conversationEventsToThread(events);

  return (
    <div data-testid="artifact-conversation-preview">
      <Thread
        thread={thread}
        depth={0}
        mode="bare"
        reveal="shallow"
        showHead={false}
        readOnly
      />
    </div>
  );
}

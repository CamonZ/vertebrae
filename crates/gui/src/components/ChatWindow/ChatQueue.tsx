import { useId, useState } from "react";
import { Button } from "../atoms/Button";
import { flushNextQueuedMessage } from "../../hooks/localChatTurnDelivery";
import { useChatStore, type ChatSession } from "../../stores/chatStore";
import { localChatCapabilities } from "./chatHelpers";

export function ChatQueue({
  session,
  busy,
}: {
  session: ChatSession;
  busy: boolean;
}) {
  const listId = useId();
  const [expanded, setExpanded] = useState(false);
  const clear = useChatStore((state) => state.clearQueuedMessages);
  const messages = session.queuedMessages;
  if (!localChatCapabilities(session.harness).recoverQueue || !messages?.length)
    return null;

  return (
    <div className="flex flex-wrap items-start justify-between gap-2 px-3 py-1 text-xs text-[var(--color-fg-soft)]">
      <div className="min-w-0 flex-1">
        <Button
          size="sm"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => setExpanded(!expanded)}
        >
          {messages.length} queued{session.queuePaused ? " · Paused" : ""}
        </Button>
        <ol
          id={listId}
          hidden={!expanded}
          aria-label="Queued messages"
          className="mt-1 max-h-32 list-decimal overflow-auto pl-5"
        >
          {messages.map((message, index) => (
            <li key={index} className="whitespace-pre-wrap break-words">
              {message}
            </li>
          ))}
        </ol>
      </div>
      {session.queuePaused && !busy && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void flushNextQueuedMessage(session.id, true)}>
            Resume queue
          </Button>
          <Button onClick={() => clear(session.id)}>Discard queue</Button>
        </div>
      )}
    </div>
  );
}

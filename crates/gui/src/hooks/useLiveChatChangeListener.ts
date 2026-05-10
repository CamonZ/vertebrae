import { useCallback, useEffect } from "react";
import {
  events,
  type LiveChatMessageCreatedEvent,
  type LiveChatSessionChangedEvent,
} from "../bindings";
import { useLiveChatStore } from "../stores/liveChatStore";

interface UseLiveChatChangeListenerOptions {
  enabled?: boolean;
}

/**
 * Mount once at the app root (via `GlobalListeners`) — the live chat store is
 * a singleton so any component reading from it will rerender.
 */
export function useLiveChatChangeListener(
  options: UseLiveChatChangeListenerOptions = {}
) {
  const { enabled = true } = options;
  const applyRemoteMessage = useLiveChatStore((s) => s.applyRemoteMessage);
  const upsertSession = useLiveChatStore((s) => s.upsertSession);

  const handleMessageCreated = useCallback(
    (event: { payload: LiveChatMessageCreatedEvent }) => {
      const { chat_session_id, client_message_id, message } = event.payload;

      if (!message) {
        // Payload failed to deserialize on the backend; nothing to apply.
        return;
      }

      // Only apply messages for the active session. The channel is per-project
      // so we may receive messages for other sessions in the same project.
      const currentSession = useLiveChatStore.getState().currentSession;
      if (currentSession && currentSession.id !== chat_session_id) {
        return;
      }

      applyRemoteMessage(message, client_message_id);
    },
    [applyRemoteMessage]
  );

  const handleSessionChanged = useCallback(
    (event: { payload: LiveChatSessionChangedEvent }) => {
      const { session } = event.payload;
      if (!session) return;
      upsertSession(session);
    },
    [upsertSession]
  );

  useEffect(() => {
    if (!enabled) return;

    const unlistenMessage = events.liveChatMessageCreatedEvent.listen(
      handleMessageCreated
    );
    const unlistenSession = events.liveChatSessionChangedEvent.listen(
      handleSessionChanged
    );

    return () => {
      unlistenMessage.then((unlisten) => unlisten());
      unlistenSession.then((unlisten) => unlisten());
    };
  }, [enabled, handleMessageCreated, handleSessionChanged]);
}

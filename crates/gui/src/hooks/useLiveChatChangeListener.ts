import { useCallback, useEffect } from "react";
import {
  events,
  type LiveChatMessageCreatedEvent,
  type LiveChatSessionChangedEvent,
} from "../bindings";
import { useLiveChatStore } from "../stores/liveChatStore";
import {
  getProjectScopeGeneration,
  useProjectScopeGeneration,
} from "../stores/projectScopedStores";

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
  const projectScopeGeneration = useProjectScopeGeneration();

  const handleMessageCreated = useCallback(
    (event: { payload: LiveChatMessageCreatedEvent }) => {
      if (projectScopeGeneration !== getProjectScopeGeneration()) return;

      const { client_message_id, message } = event.payload;

      if (!message) {
        // Payload failed to deserialize on the backend; nothing to apply.
        return;
      }

      applyRemoteMessage(message, client_message_id);
    },
    [applyRemoteMessage, projectScopeGeneration]
  );

  const handleSessionChanged = useCallback(
    (event: { payload: LiveChatSessionChangedEvent }) => {
      if (projectScopeGeneration !== getProjectScopeGeneration()) return;

      const { session } = event.payload;
      if (!session) return;
      upsertSession(session);
    },
    [upsertSession, projectScopeGeneration]
  );

  useEffect(() => {
    if (!enabled) return;

    const unlistenMessage =
      events.liveChatMessageCreatedEvent.listen(handleMessageCreated);
    const unlistenSession =
      events.liveChatSessionChangedEvent.listen(handleSessionChanged);

    return () => {
      unlistenMessage.then((unlisten) => unlisten());
      unlistenSession.then((unlisten) => unlisten());
    };
  }, [enabled, handleMessageCreated, handleSessionChanged]);
}

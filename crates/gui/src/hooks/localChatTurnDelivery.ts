import { localChatCapabilities } from "../components/ChatWindow/chatHelpers";
import { getLocalChatLifecycle, useChatStore } from "../stores/chatStore";
import {
  getProjectScopeGeneration,
  isCurrentProjectScopeGeneration,
} from "../stores/projectScopedStores";
import {
  currentActiveTurnLocalId,
  currentBackendSessionId,
  pendingLocalChatSteering,
  doSendMessage,
  doStartSession,
} from "./useLocalChat";

const queuedDeliveries = new Set<string>();

export async function flushNextQueuedMessage(
  sessionId: string,
  resume = false
): Promise<boolean> {
  const store = useChatStore.getState();
  const session = store.sessions[sessionId];
  const lifecycle = getLocalChatLifecycle(session);
  if (
    !session ||
    (lifecycle !== "idle" && !(resume && lifecycle === "error")) ||
    (session.queuePaused && !resume) ||
    queuedDeliveries.has(sessionId) ||
    (session.backendSessionId &&
      pendingLocalChatSteering.has(session.backendSessionId))
  )
    return false;

  if (!localChatCapabilities(session.harness).recoverQueue) {
    const content = store.shiftQueuedMessage(sessionId);
    return content ? deliverLocalChatTurn(sessionId, content) : false;
  }

  const content = session.queuedMessages?.[0];
  if (!content) return false;
  store.setQueuePaused(sessionId, false);
  queuedDeliveries.add(sessionId);
  const generation = getProjectScopeGeneration();
  let delivered: boolean;
  try {
    delivered = await deliverLocalChatTurn(sessionId, content);
    const latest = useChatStore.getState().sessions[sessionId];
    if (
      isCurrentProjectScopeGeneration(generation) &&
      latest?.queuedMessages?.[0] === content &&
      latest.queueRevision === session.queueRevision
    ) {
      if (delivered) store.shiftQueuedMessage(sessionId);
      else store.setQueuePaused(sessionId, true);
    }
  } finally {
    queuedDeliveries.delete(sessionId);
  }
  if (delivered && isCurrentProjectScopeGeneration(generation)) {
    // The turn may have already finished while its command reply was in flight.
    void flushNextQueuedMessage(sessionId);
  }
  return delivered;
}

/**
 * Deliver `content` as the next turn of a session whose user message is
 * already in the transcript: into the live process, or by starting one that
 * resumes the provider conversation.
 */
export async function deliverLocalChatTurn(
  sessionId: string,
  content: string
): Promise<boolean> {
  const store = useChatStore.getState();
  const latestSession = store.sessions[sessionId];
  if (!latestSession) return false;

  if (latestSession.backendSessionId) {
    return doSendMessage(
      latestSession.backendSessionId,
      sessionId,
      content,
      {
        addMessage: store.addMessage,
        setSessionLifecycle: store.setSessionLifecycle,
        markStreamingIfSending: store.markStreamingIfSending,
        beginActiveTurn: store.beginActiveTurn,
        settleActiveTurn: store.settleActiveTurn,
        setBackendSessionId: store.setBackendSessionId,
        getActiveTurnLocalId: currentActiveTurnLocalId,
        getBackendSessionId: currentBackendSessionId,
      },
      { addUserMessage: false }
    );
  }

  return doStartSession(
    latestSession,
    sessionId,
    {
      setBackendSessionId: store.setBackendSessionId,
      addMessage: store.addMessage,
      setSessionTitleCandidate: store.setSessionTitleCandidate,
      setSessionLifecycle: store.setSessionLifecycle,
      beginActiveTurn: store.beginActiveTurn,
      settleActiveTurn: store.settleActiveTurn,
      getActiveTurnLocalId: currentActiveTurnLocalId,
      getBackendSessionId: currentBackendSessionId,
    },
    content,
    { addUserMessage: false }
  );
}

import { useEffect } from "react";
import { events } from "../bindings";
import type {
  LocalChatSessionEndEvent,
  LocalChatSessionErrorEvent,
  LocalChatSessionInitEvent,
  LocalChatSessionUsageEvent,
  LocalChatSessionWarningEvent,
  LocalChatTextEvent,
  LocalChatToolCallEvent,
  LocalChatToolResultEvent,
  LocalChatTurnStartedEvent,
  LocalChatFileChangeEvent,
  PermissionRequestEvent,
} from "../bindings";
import {
  findSessionIdByBackendSessionId,
  getLocalChatLifecycle,
  useChatStore,
} from "../stores/chatStore";
import {
  doSendMessage,
  doStartSession,
  handleEndEvent,
  handleErrorEvent,
  handleInitEvent,
  handleSacrumPermissionRequestEvent,
  handleTextEvent,
  handleToolCallEvent,
  handleToolResultEvent,
  handleFileChangeEvent,
  handleUsageEvent,
  handleWarningEvent,
} from "./useLocalChat";

type Unlisten = () => void;

interface RouterSubscription {
  unlisteners: Unlisten[];
  isCancelled: boolean;
  mountCount: number;
}

let activeRouterSubscription: RouterSubscription | null = null;
type RootTurnRoutingState = {
  turnId: string;
  phase: "active" | "settled";
};
const rootTurnByBackendSessionId = new Map<string, RootTurnRoutingState>();

/** Reset module-level turn correlation between isolated test cases. */
export function resetLocalChatTurnRoutingForTests() {
  rootTurnByBackendSessionId.clear();
}

type CorrelatedEvent = {
  turn_id?: string | null;
  is_root?: boolean;
};

function resolveSessionId(backendSessionId: string | null | undefined) {
  const sessionId = findSessionIdByBackendSessionId(
    useChatStore.getState().sessions,
    backendSessionId
  );
  if (!sessionId && backendSessionId) {
    rootTurnByBackendSessionId.delete(backendSessionId);
  }
  return sessionId;
}

function matchesActiveRootTurn(
  sessionId: string,
  payload: CorrelatedEvent
): boolean {
  const activeTurn = useChatStore.getState().sessions[sessionId]?.activeTurn;
  return (
    payload.is_root === true &&
    !!payload.turn_id &&
    activeTurn?.turnId === payload.turn_id
  );
}

function shouldRouteContentEvent(
  backendSessionId: string,
  sessionId: string,
  payload: CorrelatedEvent,
  allowSettled = false
): boolean {
  if (!payload.turn_id) return true;
  if (payload.is_root === false) return true;
  const turn = rootTurnByBackendSessionId.get(backendSessionId);
  if (payload.is_root !== true || turn?.turnId !== payload.turn_id) {
    return false;
  }
  if (turn.phase === "active") return true;
  const session = useChatStore.getState().sessions[sessionId];
  return allowSettled && !!session && getLocalChatLifecycle(session) === "idle";
}

export function routeLocalChatTurnStartedEvent(
  payload: LocalChatTurnStartedEvent
): boolean {
  const sessionId = resolveSessionId(payload.backend_session_id);
  if (!sessionId || !payload.is_root || !payload.turn_id) return false;
  const routedTurn = rootTurnByBackendSessionId.get(payload.backend_session_id);
  if (
    routedTurn?.phase === "settled" &&
    routedTurn.turnId === payload.turn_id
  ) {
    return false;
  }
  if (!useChatStore.getState().bindActiveTurn(sessionId, payload.turn_id)) {
    return false;
  }
  rootTurnByBackendSessionId.set(payload.backend_session_id, {
    turnId: payload.turn_id,
    phase: "active",
  });
  return true;
}

export function routeLocalChatSessionInitEvent(
  payload: LocalChatSessionInitEvent
): boolean {
  const sessionId = resolveSessionId(payload.backend_session_id);
  if (!sessionId) return false;
  const store = useChatStore.getState();
  handleInitEvent(
    payload,
    payload.backend_session_id,
    sessionId,
    store.setProviderResumeId,
    store.setSessionModel
  );
  return true;
}

export function routeLocalChatSessionUsageEvent(
  payload: LocalChatSessionUsageEvent
): boolean {
  const sessionId = resolveSessionId(payload.backend_session_id);
  if (!sessionId) return false;
  if (
    !shouldRouteContentEvent(payload.backend_session_id, sessionId, payload)
  ) {
    return false;
  }
  handleUsageEvent(
    payload,
    payload.backend_session_id,
    sessionId,
    useChatStore.getState().setSessionUsage
  );
  return true;
}

export function routeLocalChatTextEvent(payload: LocalChatTextEvent): boolean {
  const sessionId = resolveSessionId(payload.backend_session_id);
  if (!sessionId) return false;
  if (
    !shouldRouteContentEvent(
      payload.backend_session_id,
      sessionId,
      payload,
      !payload.is_partial
    )
  ) {
    return false;
  }
  const store = useChatStore.getState();
  handleTextEvent(
    payload,
    payload.backend_session_id,
    sessionId,
    store.updateLastAssistantMessage,
    store.finalizeLastAssistantMessage,
    store.addMessage
  );
  return true;
}

export function routeLocalChatToolCallEvent(
  payload: LocalChatToolCallEvent
): boolean {
  const sessionId = resolveSessionId(payload.backend_session_id);
  if (!sessionId) return false;
  if (
    !shouldRouteContentEvent(payload.backend_session_id, sessionId, payload)
  ) {
    return false;
  }
  handleToolCallEvent(
    payload,
    payload.backend_session_id,
    sessionId,
    useChatStore.getState().addMessage
  );
  return true;
}

export function routeLocalChatToolResultEvent(
  payload: LocalChatToolResultEvent
): boolean {
  const sessionId = resolveSessionId(payload.backend_session_id);
  if (!sessionId) return false;
  if (
    !shouldRouteContentEvent(payload.backend_session_id, sessionId, payload)
  ) {
    return false;
  }
  handleToolResultEvent(
    payload,
    payload.backend_session_id,
    sessionId,
    useChatStore.getState().addMessage
  );
  return true;
}

export function routeLocalChatFileChangeEvent(
  payload: LocalChatFileChangeEvent
): boolean {
  const sessionId = resolveSessionId(payload.backend_session_id);
  if (!sessionId) return false;
  if (
    !shouldRouteContentEvent(payload.backend_session_id, sessionId, payload)
  ) {
    return false;
  }
  handleFileChangeEvent(
    payload,
    payload.backend_session_id,
    sessionId,
    useChatStore.getState().addMessage
  );
  return true;
}

export function routePermissionRequestEvent(
  payload: PermissionRequestEvent
): boolean {
  const sessionId = resolveSessionId(payload.session_id);
  if (!sessionId) return false;
  if (
    payload.session_id &&
    !shouldRouteContentEvent(payload.session_id, sessionId, payload)
  ) {
    return false;
  }
  handleSacrumPermissionRequestEvent(
    payload,
    payload.session_id,
    sessionId,
    useChatStore.getState().addMessage
  );
  return true;
}

export function routeLocalChatSessionEndEvent(
  payload: LocalChatSessionEndEvent
): boolean {
  const sessionId = resolveSessionId(payload.backend_session_id);
  if (!sessionId) return false;
  if (!matchesActiveRootTurn(sessionId, payload)) {
    return false;
  }
  const wasStopping =
    useChatStore.getState().sessions[sessionId]?.activeTurn?.phase ===
    "stopping";
  rootTurnByBackendSessionId.set(payload.backend_session_id, {
    turnId: payload.turn_id,
    phase: "settled",
  });
  const store = useChatStore.getState();
  if (!store.settleActiveTurn(sessionId, payload.turn_id)) return false;
  store.markPendingUserQuestionsUnavailable(sessionId);
  handleEndEvent(
    payload,
    payload.backend_session_id,
    sessionId,
    store.setSessionLifecycle,
    store.clearStreamingAssistant
  );
  if (!wasStopping) void flushNextQueuedMessage(sessionId);
  return true;
}

export function routeLocalChatSessionErrorEvent(
  payload: LocalChatSessionErrorEvent
): boolean {
  const sessionId = resolveSessionId(payload.backend_session_id);
  if (!sessionId) return false;
  const store = useChatStore.getState();
  if (payload.is_root === false) {
    store.addMessage(sessionId, {
      kind: "error",
      message: payload.error,
      timestamp: new Date().toISOString(),
    });
    return true;
  }
  if (payload.turn_id && !matchesActiveRootTurn(sessionId, payload)) {
    return false;
  }
  if (payload.turn_id) {
    rootTurnByBackendSessionId.set(payload.backend_session_id, {
      turnId: payload.turn_id,
      phase: "settled",
    });
  } else {
    rootTurnByBackendSessionId.delete(payload.backend_session_id);
  }
  if (
    store.sessions[sessionId]?.activeTurn &&
    !store.settleActiveTurn(sessionId, payload.turn_id ?? null)
  ) {
    return false;
  }
  store.markPendingUserQuestionsUnavailable(sessionId);
  handleErrorEvent(
    payload,
    payload.backend_session_id,
    sessionId,
    store.addMessage,
    store.setSessionLifecycle,
    store.clearStreamingAssistant,
    store.setBackendSessionId
  );
  store.clearQueuedMessages(sessionId);
  return true;
}

export function routeLocalChatSessionWarningEvent(
  payload: LocalChatSessionWarningEvent
): boolean {
  const sessionId = resolveSessionId(payload.backend_session_id);
  if (!sessionId) return false;
  if (
    !shouldRouteContentEvent(payload.backend_session_id, sessionId, payload)
  ) {
    return false;
  }
  handleWarningEvent(
    payload,
    payload.backend_session_id,
    sessionId,
    useChatStore.getState().addMessage
  );
  return true;
}

export async function flushNextQueuedMessage(
  sessionId: string
): Promise<boolean> {
  const initial = useChatStore.getState();
  const session = initial.sessions[sessionId];
  if (!session || getLocalChatLifecycle(session) !== "idle") return false;

  const content = initial.shiftQueuedMessage(sessionId);
  if (!content) return false;

  const store = useChatStore.getState();
  const latestSession = store.sessions[sessionId];
  if (!latestSession) return false;

  if (latestSession.backendSessionId) {
    await doSendMessage(
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
      },
      { addUserMessage: false }
    );
    return true;
  }

  await doStartSession(
    latestSession,
    sessionId,
    {
      setBackendSessionId: store.setBackendSessionId,
      addMessage: store.addMessage,
      setSessionTitleCandidate: store.setSessionTitleCandidate,
      setSessionLifecycle: store.setSessionLifecycle,
      beginActiveTurn: store.beginActiveTurn,
      settleActiveTurn: store.settleActiveTurn,
    },
    content,
    { addUserMessage: false }
  );
  return true;
}

function releaseRouterSubscription(subscription: RouterSubscription) {
  subscription.mountCount -= 1;
  if (subscription.mountCount > 0) return;

  if (activeRouterSubscription === subscription) {
    activeRouterSubscription = null;
  }
  subscription.isCancelled = true;
  subscription.unlisteners.forEach((unlisten) => unlisten());
  subscription.unlisteners = [];
}

function subscribeLocalChatEvents(): Unlisten {
  if (activeRouterSubscription) {
    const subscription = activeRouterSubscription;
    subscription.mountCount += 1;
    return () => releaseRouterSubscription(subscription);
  }

  const subscription: RouterSubscription = {
    unlisteners: [],
    isCancelled: false,
    mountCount: 1,
  };
  activeRouterSubscription = subscription;

  const register = async (promise: Promise<Unlisten>) => {
    const unlisten = await promise;
    if (subscription.isCancelled) {
      unlisten();
      return;
    }
    subscription.unlisteners.push(unlisten);
  };

  void register(
    events.localChatSessionInitEvent.listen((event) => {
      routeLocalChatSessionInitEvent(event.payload);
    })
  );
  void register(
    events.localChatTurnStartedEvent.listen((event) => {
      routeLocalChatTurnStartedEvent(event.payload);
    })
  );
  void register(
    events.localChatSessionUsageEvent.listen((event) => {
      routeLocalChatSessionUsageEvent(event.payload);
    })
  );
  void register(
    events.localChatTextEvent.listen((event) => {
      routeLocalChatTextEvent(event.payload);
    })
  );
  void register(
    events.localChatToolCallEvent.listen((event) => {
      routeLocalChatToolCallEvent(event.payload);
    })
  );
  void register(
    events.localChatToolResultEvent.listen((event) => {
      routeLocalChatToolResultEvent(event.payload);
    })
  );
  if (events.localChatFileChangeEvent) {
    void register(
      events.localChatFileChangeEvent.listen((event) => {
        routeLocalChatFileChangeEvent(event.payload);
      })
    );
  }
  if (events.permissionRequestEvent) {
    void register(
      events.permissionRequestEvent.listen((event) => {
        routePermissionRequestEvent(event.payload);
      })
    );
  }
  void register(
    events.localChatSessionEndEvent.listen((event) => {
      routeLocalChatSessionEndEvent(event.payload);
    })
  );
  void register(
    events.localChatSessionErrorEvent.listen((event) => {
      routeLocalChatSessionErrorEvent(event.payload);
    })
  );
  void register(
    events.localChatSessionWarningEvent.listen((event) => {
      routeLocalChatSessionWarningEvent(event.payload);
    })
  );

  return () => releaseRouterSubscription(subscription);
}

/**
 * Always-mounted local-chat router. Each webview has its own zustand store and
 * gets one router instance via GlobalListeners; events for sessions unknown to
 * this webview are dropped by the backend-session reverse lookup.
 */
export function useLocalChatEventRouter() {
  useEffect(() => {
    return subscribeLocalChatEvents();
  }, []);
}

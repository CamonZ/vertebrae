import { useEffect } from "react";
import { events } from "../bindings";
import type {
  LocalChatSessionEndEvent,
  LocalChatSessionErrorEvent,
  LocalChatSessionInitEvent,
  LocalChatSessionUsageEvent,
  LocalChatSessionWarningEvent,
  LocalChatCompactionEvent,
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
  isLocalChatLifecycleBusy,
  useChatStore,
} from "../stores/chatStore";
import {
  currentActiveTurnLocalId,
  currentBackendSessionId,
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
  handleCompactionEvent,
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
  backendSessionId: string,
  payload: CorrelatedEvent
): boolean {
  if (payload.is_root !== true || !payload.turn_id) return false;
  const activeTurn = useChatStore.getState().sessions[sessionId]?.activeTurn;
  if (activeTurn) return activeTurn.turnId === payload.turn_id;
  // No locally tracked turn: the store never began one, or an earlier failure
  // settled it while the provider kept running. Fall back to routing state so
  // a real terminal event still returns the session to idle instead of
  // stranding it mid-turn.
  const routed = rootTurnByBackendSessionId.get(backendSessionId);
  return routed?.phase === "active" && routed.turnId === payload.turn_id;
}

function shouldRouteContentEvent(
  backendSessionId: string,
  sessionId: string,
  payload: CorrelatedEvent,
  allowSettled = false
): boolean {
  if (!payload.turn_id) {
    if (payload.is_root !== true) return true;
    const routed = rootTurnByBackendSessionId.get(backendSessionId);
    const session = useChatStore.getState().sessions[sessionId];
    // Root content without a turn id cannot be correlated to the settled
    // turn. It is safe to accept only while a known root turn is busy; once
    // idle, accepting it would resurrect streaming and strand queued input.
    return (
      routed?.phase === "active" &&
      !!session &&
      isLocalChatLifecycleBusy(getLocalChatLifecycle(session))
    );
  }
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
  if (!sessionId || !payload.is_root || !payload.turn_id) {
    return false;
  }
  const routedTurn = rootTurnByBackendSessionId.get(payload.backend_session_id);
  if (
    routedTurn?.phase === "settled" &&
    routedTurn.turnId === payload.turn_id
  ) {
    return false;
  }
  // Content routing must follow the provider even when the store declines the
  // bind (no local turn, or a duplicate start). Dropping the routing update
  // would silently discard every event of this turn.
  rootTurnByBackendSessionId.set(payload.backend_session_id, {
    turnId: payload.turn_id,
    phase: "active",
  });
  const bound = useChatStore.getState().bindActiveTurn(sessionId, payload.turn_id);
  return bound;
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
  if (!sessionId) {
    return false;
  }
  if (!matchesActiveRootTurn(sessionId, payload.backend_session_id, payload)) {
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
  store.settleActiveTurn(sessionId, payload.turn_id);
  store.setSessionCompaction(sessionId, false);
  store.markPendingUserQuestionsUnavailable(sessionId);
  handleEndEvent(
    payload,
    payload.backend_session_id,
    sessionId,
    wasStopping ? () => {} : store.setSessionLifecycle,
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
  if (
    payload.turn_id &&
    !matchesActiveRootTurn(sessionId, payload.backend_session_id, payload)
  ) {
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
  // A root error with no turn id is session-fatal: clear whatever turn is
  // tracked. A correlated one only clears the turn it matched above.
  store.settleActiveTurn(sessionId, payload.turn_id ?? null);
  store.setSessionCompaction(sessionId, false);
  store.setCompactionSummary(sessionId, null);
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

export function routeLocalChatCompactionEvent(
  payload: LocalChatCompactionEvent
): boolean {
  const sessionId = resolveSessionId(payload.backend_session_id);
  if (!sessionId) return false;
  if (
    payload.turn_id &&
    !shouldRouteContentEvent(
      payload.backend_session_id,
      sessionId,
      payload,
      true
    )
  ) {
    return false;
  }
  handleCompactionEvent(
    payload,
    payload.backend_session_id,
    sessionId,
    useChatStore.getState().setSessionCompaction,
    useChatStore.getState().setCompactionSummary
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
        getActiveTurnLocalId: currentActiveTurnLocalId,
        getBackendSessionId: currentBackendSessionId,
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
      getActiveTurnLocalId: currentActiveTurnLocalId,
      getBackendSessionId: currentBackendSessionId,
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
  void register(
    events.localChatCompactionEvent.listen((event) => {
      routeLocalChatCompactionEvent(event.payload);
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

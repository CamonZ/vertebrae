import { useCallback } from "react";
import { commands, type LocalChatGateBinding } from "../bindings";
import {
  getLocalChatLifecycle,
  isLocalChatLifecycleBusy,
  useChatStore,
} from "../stores/chatStore";
import {
  GATE_CHAT_KICKOFF,
  GATE_CHAT_RECOVERY_KICKOFF,
  gateChatBinding,
  hiddenTurn,
} from "../utils/gateChat";
import {
  getProjectScopeGeneration,
  isCurrentProjectScopeGeneration,
} from "../stores/projectScopedStores";
import { readGateDraft } from "./useHumanInputDraft";
import type { HumanInputGateContext } from "../utils/humanInputGate";
import {
  currentActiveTurnLocalId,
  currentBackendSessionId,
  doSendMessage,
  doStartSession,
} from "./useLocalChat";

/**
 * Latest execution each chat is being rebound to: repeats merge, and a
 * refresh superseded while waiting for the chat to go idle is dropped.
 */
const pendingGateRefreshes = new Map<string, string>();

function showGateEvaluationCard(
  sessionId: string,
  gate: LocalChatGateBinding
): void {
  if (!gate.revision) return;
  const store = useChatStore.getState();
  const alreadyShown = store.sessions[sessionId]?.messages.some(
    (message) =>
      message.kind === "gate_evaluation" &&
      message.attempt === gate.revision?.attempt
  );
  if (alreadyShown) return;
  store.addMessage(sessionId, {
    kind: "gate_evaluation",
    attempt: gate.revision.attempt,
    verdict: gate.revision.verdict ?? null,
    timestamp: new Date().toISOString(),
  });
}

/** Resolve once the chat is not mid-turn; false when it is gone. */
export function whenSessionIdle(sessionId: string): Promise<boolean> {
  const settled = (): boolean | null => {
    const session = useChatStore.getState().sessions[sessionId];
    if (!session) return false;
    return isLocalChatLifecycleBusy(getLocalChatLifecycle(session))
      ? null
      : true;
  };
  const now = settled();
  if (now !== null) return Promise.resolve(now);
  return new Promise((resolve) => {
    const unsubscribe = useChatStore.subscribe(() => {
      const next = settled();
      if (next === null) return;
      unsubscribe();
      resolve(next);
    });
  });
}

/**
 * Rebind a gate chat to the execution now waiting at its gate. A live chat
 * receives the hidden refresh turn (the review's verdict on a revision) as
 * its own turn once it is idle; a chat with no running session is rebound in
 * place and gets the refreshed protocol when it resumes.
 */
export async function refreshGateChat(
  sessionId: string,
  gate: LocalChatGateBinding
): Promise<void> {
  if (pendingGateRefreshes.get(sessionId) === gate.execution_id) return;
  pendingGateRefreshes.set(sessionId, gate.execution_id);
  try {
    if (!(await whenSessionIdle(sessionId))) return;
    if (pendingGateRefreshes.get(sessionId) !== gate.execution_id) return;
    const store = useChatStore.getState();
    const backendSessionId = store.sessions[sessionId]?.backendSessionId;
    if (!backendSessionId) {
      store.setGateChatBinding(sessionId, gate);
      return;
    }
    await doSendMessage(
      backendSessionId,
      sessionId,
      "",
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
      {
        addUserMessage: false,
        deliver: async () => {
          const result = await commands.refreshLocalChatSessionGate(
            backendSessionId,
            gate
          );
          if (result.status === "ok") {
            useChatStore.getState().setGateChatBinding(sessionId, gate);
            if (result.data !== false) showGateEvaluationCard(sessionId, gate);
          }
          return result;
        },
      }
    );
  } finally {
    if (pendingGateRefreshes.get(sessionId) === gate.execution_id) {
      pendingGateRefreshes.delete(sessionId);
    }
  }
}

function turnDeps() {
  const store = useChatStore.getState();
  return {
    addMessage: store.addMessage,
    setSessionLifecycle: store.setSessionLifecycle,
    markStreamingIfSending: store.markStreamingIfSending,
    beginActiveTurn: store.beginActiveTurn,
    settleActiveTurn: store.settleActiveTurn,
    setBackendSessionId: store.setBackendSessionId,
    getActiveTurnLocalId: currentActiveTurnLocalId,
    getBackendSessionId: currentBackendSessionId,
  };
}

/**
 * Send `text` to a live gate chat as a hidden Vertebrae turn once it is
 * idle: the agent reads it, the thread never shows it. Resolves whether a
 * turn was sent; a chat without a running session receives nothing.
 */
export async function sendGateHiddenTurn(
  sessionId: string,
  text: string
): Promise<boolean> {
  if (!(await whenSessionIdle(sessionId))) return false;
  const backendSessionId =
    useChatStore.getState().sessions[sessionId]?.backendSessionId;
  if (!backendSessionId) return false;
  await doSendMessage(
    backendSessionId,
    sessionId,
    hiddenTurn(text),
    turnDeps(),
    {
      addUserMessage: false,
    }
  );
  return true;
}

async function currentProjectPath(): Promise<string | null> {
  try {
    const result = await commands.getCurrentProjectPath();
    return result.status === "ok" && result.data ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * Open the local chat bound to a waiting human_input gate. A new chat starts
 * on the selected harness with the gate protocol in its hidden developer
 * instructions and a hidden opening turn, so the agent addresses the
 * question first; an existing chat for the same run and step is reopened.
 */
export async function resolveGateInChat(
  context: HumanInputGateContext
): Promise<string | null> {
  const binding = gateChatBinding(context);
  if (!binding) return null;
  // Sacrum decides whether the gate is draftable; its draft carries the
  // answers a new chat starts from.
  const generation = getProjectScopeGeneration();
  const projectPath = await currentProjectPath();
  if (!isCurrentProjectScopeGeneration(generation)) return null;
  const draft = await readGateDraft(binding.execution_id);
  if (!isCurrentProjectScopeGeneration(generation)) return null;
  const gate = { ...binding, draftable: draft !== null, draft };
  let { sessionId, gateChanged } = useChatStore
    .getState()
    .openGateSession(gate, projectPath);

  let session = useChatStore.getState().sessions[sessionId];
  if (!session) {
    return sessionId;
  }

  // The bound chat's session ended: a draftable gate continues in a new
  // chat that starts from the durable draft, so nothing is asked twice.
  const recovering =
    draft !== null &&
    !session.backendSessionId &&
    (session.messages.length > 0 ||
      (session.messageCount ?? 0) > 0 ||
      !!session.providerResumeId) &&
    !isLocalChatLifecycleBusy(getLocalChatLifecycle(session));
  if (recovering) {
    useChatStore.getState().detachGateChat(sessionId);
    ({ sessionId, gateChanged } = useChatStore
      .getState()
      .openGateSession(gate, projectPath));
    session = useChatStore.getState().sessions[sessionId];
    if (!session) return sessionId;
  }

  const store = useChatStore.getState();

  if (session.backendSessionId) {
    // Delivered once the chat is idle; Resolve itself returns at once.
    if (gateChanged) void refreshGateChat(sessionId, gate);
    return sessionId;
  }

  if (
    session.providerResumeId ||
    isLocalChatLifecycleBusy(getLocalChatLifecycle(session))
  ) {
    return sessionId;
  }

  await doStartSession(
    session,
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
    recovering ? GATE_CHAT_RECOVERY_KICKOFF : GATE_CHAT_KICKOFF,
    { addUserMessage: false }
  );
  if (!isCurrentProjectScopeGeneration(generation)) return null;
  const settledSession = useChatStore.getState().sessions[sessionId];
  if (
    settledSession?.backendSessionId &&
    getLocalChatLifecycle(settledSession) !== "error"
  ) {
    showGateEvaluationCard(sessionId, gate);
  }
  return sessionId;
}

export function useResolveGateInChat() {
  return useCallback(
    (context: HumanInputGateContext) => resolveGateInChat(context),
    []
  );
}

import { useCallback } from "react";
import { commands } from "../bindings";
import {
  getLocalChatLifecycle,
  isLocalChatLifecycleBusy,
  useChatStore,
} from "../stores/chatStore";
import { GATE_CHAT_KICKOFF, gateChatBinding } from "../utils/gateChat";
import type { HumanInputGateContext } from "../utils/humanInputGate";
import {
  currentActiveTurnLocalId,
  currentBackendSessionId,
  doStartSession,
} from "./useLocalChat";

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
  const gate = gateChatBinding(context);
  if (!gate) return null;
  const projectPath = await currentProjectPath();
  const { sessionId, gateChanged } = useChatStore
    .getState()
    .openGateSession(gate, projectPath);

  const store = useChatStore.getState();
  const session = store.sessions[sessionId];
  if (!session) {
    return sessionId;
  }

  if (session.backendSessionId) {
    if (gateChanged) {
      try {
        const result = await commands.refreshLocalChatSessionGate(
          session.backendSessionId,
          gate
        );
        if (result.status === "error") throw new Error(String(result.error));
      } catch (error) {
        store.addMessage(sessionId, {
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString(),
        });
      }
    }
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
    GATE_CHAT_KICKOFF,
    { addUserMessage: false }
  );
  return sessionId;
}

export function useResolveGateInChat() {
  return useCallback(
    (context: HumanInputGateContext) => resolveGateInChat(context),
    []
  );
}

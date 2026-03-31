import { useCallback, useEffect, useRef } from "react";
import { commands, events } from "../bindings";
import type {
  ClaudeSessionInitEvent,
  ClaudeTextEvent,
  ClaudeToolCallEvent,
  ClaudeToolResultEvent,
  ClaudePermissionRequestEvent,
  ClaudeSessionEndEvent,
  ClaudeSessionErrorEvent,
} from "../bindings";
import { useChatStore } from "../stores/chatStore";
import type { ChatScope, ChatSession } from "../stores/chatStore";
import type { ChatMessage } from "./useClaudeChat";
import { buildContextSummary, buildInitialPrompt } from "../utils/chatContext";

// --- Extracted event handlers (pure functions, testable without hooks) ---

export function handleInitEvent(
  payload: ClaudeSessionInitEvent,
  claudeSessionId: string | null,
  sessionId: string,
  setClaudeConversationId: (sessionId: string, convId: string) => void
) {
  if (payload.session_id !== claudeSessionId) return;
  if (payload.claude_conversation_id) {
    setClaudeConversationId(sessionId, payload.claude_conversation_id);
  }
}

export function handleTextEvent(
  payload: ClaudeTextEvent,
  claudeSessionId: string | null,
  sessionId: string,
  updateLastAssistantMessage: (sessionId: string, text: string) => void,
  finalizeLastAssistantMessage: (sessionId: string, text: string) => void
) {
  if (payload.session_id !== claudeSessionId) return;
  if (payload.is_partial) {
    updateLastAssistantMessage(sessionId, payload.text);
  } else {
    finalizeLastAssistantMessage(sessionId, payload.text);
  }
}

export function handleToolCallEvent(
  payload: ClaudeToolCallEvent,
  claudeSessionId: string | null,
  sessionId: string,
  addMessage: (sessionId: string, msg: ChatMessage) => void
) {
  if (payload.session_id !== claudeSessionId) return;
  addMessage(sessionId, {
    kind: "tool_call",
    toolName: payload.tool_name,
    toolId: payload.tool_id,
    input: payload.input,
    timestamp: new Date().toISOString(),
  });
}

export function handleToolResultEvent(
  payload: ClaudeToolResultEvent,
  claudeSessionId: string | null,
  sessionId: string,
  addMessage: (sessionId: string, msg: ChatMessage) => void
) {
  if (payload.session_id !== claudeSessionId) return;
  addMessage(sessionId, {
    kind: "tool_result",
    toolId: payload.tool_id,
    result: payload.result,
    isError: payload.is_error,
    timestamp: new Date().toISOString(),
  });
}

export function handlePermissionRequestEvent(
  payload: ClaudePermissionRequestEvent,
  claudeSessionId: string | null,
  sessionId: string,
  addMessage: (sessionId: string, msg: ChatMessage) => void
) {
  if (payload.session_id !== claudeSessionId) return;
  addMessage(sessionId, {
    kind: "permission_request",
    toolName: payload.tool_name,
    message: payload.permission_message,
    timestamp: new Date().toISOString(),
  });
}

export function handleEndEvent(
  payload: ClaudeSessionEndEvent,
  claudeSessionId: string | null,
  sessionId: string,
  markSessionClosed: (sessionId: string) => void
) {
  if (payload.session_id !== claudeSessionId) return;
  markSessionClosed(sessionId);
}

export function handleErrorEvent(
  payload: ClaudeSessionErrorEvent,
  claudeSessionId: string | null,
  sessionId: string,
  addMessage: (sessionId: string, msg: ChatMessage) => void
) {
  if (payload.session_id !== claudeSessionId) return;
  addMessage(sessionId, {
    kind: "error",
    message: payload.error,
    timestamp: new Date().toISOString(),
  });
}

// --- Extracted session lifecycle functions ---

export async function doStartSession(
  session: ChatSession,
  sessionId: string,
  deps: {
    setClaudeSessionId: (id: string, backendId: string) => void;
    setClaudeSessionIdRef: (backendId: string) => void;
    setContextSummary: (id: string, summary: string) => void;
    addMessage: (id: string, msg: ChatMessage) => void;
  },
  userMessage?: string
) {
  const backendSessionId = `scoped-${sessionId}-${Date.now()}`;
  deps.setClaudeSessionId(sessionId, backendSessionId);
  deps.setClaudeSessionIdRef(backendSessionId);

  let context = session.contextSummary;
  if (!context) {
    context = await buildContextSummary(session.scope, session.entityId);
    if (context) {
      deps.setContextSummary(sessionId, context);
    }
  }

  const initialPrompt = userMessage
    ? buildInitialPrompt(context, userMessage)
    : undefined;

  if (userMessage) {
    deps.addMessage(sessionId, {
      kind: "user",
      text: userMessage,
      timestamp: new Date().toISOString(),
    });
  }

  let workingDir: string | null = null;
  const pathResult = await commands.getCurrentProjectPath();
  if (pathResult.status === "ok" && pathResult.data) {
    workingDir = pathResult.data;
  }

  const resumeId = session.claudeConversationId;

  await commands.createClaudeSession(
    backendSessionId,
    workingDir,
    initialPrompt ?? null,
    resumeId
  );
}

export async function doSendMessage(
  claudeSessionId: string,
  sessionId: string,
  content: string,
  addMessage: (id: string, msg: ChatMessage) => void
) {
  addMessage(sessionId, {
    kind: "user",
    text: content,
    timestamp: new Date().toISOString(),
  });

  await commands.sendClaudeMessage(claudeSessionId, content);
}

export async function doCloseSession(
  claudeSessionId: string,
  sessionId: string | null,
  markSessionClosed: (id: string) => void
) {
  await commands.closeClaudeSession(claudeSessionId);
  if (sessionId) {
    markSessionClosed(sessionId);
  }
}

/**
 * Hook to manage a scoped Claude chat session.
 *
 * Wraps the chatStore with Claude CLI session lifecycle:
 * - Creates/resumes Claude CLI sessions
 * - Listens for Claude events and routes them to the correct store session
 * - Handles context injection on session start
 */
export function useScopedChat(sessionId: string | null) {
  const session = useChatStore((s) =>
    sessionId ? s.sessions[sessionId] ?? null : null
  );

  const addMessage = useChatStore((s) => s.addMessage);
  const updateLastAssistantMessage = useChatStore(
    (s) => s.updateLastAssistantMessage
  );
  const finalizeLastAssistantMessage = useChatStore(
    (s) => s.finalizeLastAssistantMessage
  );
  const setClaudeSessionId = useChatStore((s) => s.setClaudeSessionId);
  const setClaudeConversationId = useChatStore(
    (s) => s.setClaudeConversationId
  );
  const setContextSummary = useChatStore((s) => s.setContextSummary);
  const markSessionClosed = useChatStore((s) => s.markSessionClosed);

  // Track the Claude backend session ID for event filtering
  const claudeSessionIdRef = useRef<string | null>(null);

  // Keep ref in sync
  useEffect(() => {
    claudeSessionIdRef.current = session?.claudeSessionId ?? null;
  }, [session?.claudeSessionId]);

  // Subscribe to Claude events - filter by our backend session ID
  useEffect(() => {
    if (!sessionId) return;

    const unlisteners: Array<() => void> = [];
    let isCancelled = false;

    const setup = async () => {
      const initUn = await events.claudeSessionInitEvent.listen((event) => {
        handleInitEvent(
          event.payload,
          claudeSessionIdRef.current,
          sessionId,
          setClaudeConversationId
        );
      });
      if (isCancelled) {
        initUn();
        return;
      }
      unlisteners.push(initUn);

      const textUn = await events.claudeTextEvent.listen((event) => {
        handleTextEvent(
          event.payload,
          claudeSessionIdRef.current,
          sessionId,
          updateLastAssistantMessage,
          finalizeLastAssistantMessage
        );
      });
      if (isCancelled) {
        textUn();
        return;
      }
      unlisteners.push(textUn);

      const toolCallUn = await events.claudeToolCallEvent.listen((event) => {
        handleToolCallEvent(
          event.payload,
          claudeSessionIdRef.current,
          sessionId,
          addMessage
        );
      });
      if (isCancelled) {
        toolCallUn();
        return;
      }
      unlisteners.push(toolCallUn);

      const toolResultUn = await events.claudeToolResultEvent.listen(
        (event) => {
          handleToolResultEvent(
            event.payload,
            claudeSessionIdRef.current,
            sessionId,
            addMessage
          );
        }
      );
      if (isCancelled) {
        toolResultUn();
        return;
      }
      unlisteners.push(toolResultUn);

      const permissionUn = await events.claudePermissionRequestEvent.listen(
        (event) => {
          handlePermissionRequestEvent(
            event.payload,
            claudeSessionIdRef.current,
            sessionId,
            addMessage
          );
        }
      );
      if (isCancelled) {
        permissionUn();
        return;
      }
      unlisteners.push(permissionUn);

      const endUn = await events.claudeSessionEndEvent.listen((event) => {
        handleEndEvent(
          event.payload,
          claudeSessionIdRef.current,
          sessionId,
          markSessionClosed
        );
      });
      if (isCancelled) {
        endUn();
        return;
      }
      unlisteners.push(endUn);

      const errorUn = await events.claudeSessionErrorEvent.listen((event) => {
        handleErrorEvent(
          event.payload,
          claudeSessionIdRef.current,
          sessionId,
          addMessage
        );
      });
      if (isCancelled) {
        errorUn();
        return;
      }
      unlisteners.push(errorUn);
    };

    setup();

    return () => {
      isCancelled = true;
      unlisteners.forEach((fn) => fn());
    };
  }, [
    sessionId,
    addMessage,
    updateLastAssistantMessage,
    finalizeLastAssistantMessage,
    setClaudeConversationId,
    markSessionClosed,
  ]);

  /**
   * Start the Claude CLI session with context injection.
   */
  const startSession = useCallback(
    async (userMessage?: string) => {
      if (!session || !sessionId) return;

      await doStartSession(
        session,
        sessionId,
        {
          setClaudeSessionId,
          setClaudeSessionIdRef: (id) => {
            claudeSessionIdRef.current = id;
          },
          setContextSummary,
          addMessage,
        },
        userMessage
      );
    },
    [session, sessionId, addMessage, setClaudeSessionId, setContextSummary]
  );

  /**
   * Send a message to the active Claude session.
   */
  const sendMessage = useCallback(
    async (content: string) => {
      if (!session?.claudeSessionId || !sessionId) return;

      await doSendMessage(
        session.claudeSessionId,
        sessionId,
        content,
        addMessage
      );
    },
    [session?.claudeSessionId, sessionId, addMessage]
  );

  /**
   * Close the Claude CLI session.
   */
  const closeClaudeSession = useCallback(async () => {
    if (!session?.claudeSessionId) return;
    await doCloseSession(
      session.claudeSessionId,
      sessionId,
      markSessionClosed
    );
  }, [session?.claudeSessionId, sessionId, markSessionClosed]);

  const isActive =
    session?.status === "open" && session?.claudeSessionId !== null;

  return {
    session,
    isActive,
    startSession,
    sendMessage,
    closeClaudeSession,
  };
}

/**
 * Helper hook to open a scoped chat session from any component.
 */
export function useOpenChat() {
  const openSession = useChatStore((s) => s.openSession);

  return useCallback(
    (scope: ChatScope, entityId: string | null, label: string) => {
      return openSession(scope, entityId, label);
    },
    [openSession]
  );
}

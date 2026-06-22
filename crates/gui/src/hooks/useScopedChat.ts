import { useCallback, useEffect, useRef } from "react";
import { commands, events } from "../bindings";
import type {
  ClaudeSessionInitEvent,
  ClaudeSessionUsageEvent,
  ClaudeTextEvent,
  ClaudeToolCallEvent,
  ClaudeToolResultEvent,
  ClaudePermissionRequestEvent,
  PermissionRequestEvent,
  ClaudeSessionEndEvent,
  ClaudeSessionErrorEvent,
  ClaudeSessionWarningEvent,
} from "../bindings";
import {
  getLocalChatLifecycle,
  isLocalChatLifecycleBusy,
  useChatStore,
} from "../stores/chatStore";
import type {
  ChatScope,
  ChatSession,
  ChatMessage,
  LocalChatLifecycle,
} from "../stores/chatStore";
import { resolveContextWindow } from "../utils/modelContextWindow";

// --- Extracted event handlers (pure functions, testable without hooks) ---

function commandErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    if ("message" in error && typeof error.message === "string") {
      return error.message;
    }
    const [key, value] = Object.entries(error)[0] ?? [];
    if (typeof value === "string") return value;
    if (key) return key;
  }
  return "Claude session failed";
}

function commandErrorKind(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  return Object.keys(error)[0] ?? null;
}

function isSessionNotFoundError(error: unknown): boolean {
  return commandErrorKind(error) === "SessionNotFound";
}

export function handleInitEvent(
  payload: ClaudeSessionInitEvent,
  claudeSessionId: string | null,
  sessionId: string,
  setClaudeConversationId: (sessionId: string, convId: string) => void,
  setSessionModel: (sessionId: string, model: string) => void
) {
  if (payload.session_id !== claudeSessionId) return;
  if (payload.claude_conversation_id) {
    setClaudeConversationId(sessionId, payload.claude_conversation_id);
  }
  if (payload.model) {
    setSessionModel(sessionId, payload.model);
  }
}

// Usage events carry current request input-context tokens (input + cache read
// + cache creation). Frontend lookup table wins for per-model maxes; see
// modelContextWindow.ts.
export function handleUsageEvent(
  payload: ClaudeSessionUsageEvent,
  claudeSessionId: string | null,
  sessionId: string,
  setSessionUsage: (
    sessionId: string,
    model: string,
    usage: { used: number; max: number }
  ) => void
) {
  if (payload.session_id !== claudeSessionId) return;
  const max = resolveContextWindow(payload.model, payload.context_window);
  if (max && max > 0) {
    setSessionUsage(sessionId, payload.model, {
      used: payload.context_tokens,
      max,
    });
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

export function handleSacrumPermissionRequestEvent(
  payload: PermissionRequestEvent,
  claudeSessionId: string | null,
  sessionId: string,
  addMessage: (sessionId: string, msg: ChatMessage) => void
) {
  if (payload.session_id !== claudeSessionId) return;
  addMessage(sessionId, {
    kind: "permission_request",
    requestId: payload.request_id,
    toolName: payload.tool_name,
    message: payload.message ?? `${payload.tool_name} needs approval`,
    input: JSON.stringify(payload.input, null, 2),
    timestamp: new Date().toISOString(),
  });
}

export function handleEndEvent(
  payload: ClaudeSessionEndEvent,
  claudeSessionId: string | null,
  sessionId: string,
  setSessionLifecycle: (
    sessionId: string,
    lifecycle: LocalChatLifecycle,
    errorMessage?: string | null
  ) => void,
  clearStreamingAssistant: (
    sessionId: string,
    commitToMessages?: boolean
  ) => void,
  setClaudeSessionId: (sessionId: string, backendId: string | null) => void,
  setClaudeSessionIdRef: (backendId: string | null) => void
) {
  if (payload.session_id !== claudeSessionId) return;
  // Session-end modelUsage is a session summary, not the per-turn request
  // input-context value that drives the badge.
  clearStreamingAssistant(sessionId, true);
  setClaudeSessionId(sessionId, null);
  setClaudeSessionIdRef(null);
  if (payload.is_error) {
    setSessionLifecycle(
      sessionId,
      "error",
      payload.result || "Claude session ended with an error"
    );
    return;
  }
  setSessionLifecycle(sessionId, "idle");
}

export function handleErrorEvent(
  payload: ClaudeSessionErrorEvent,
  claudeSessionId: string | null,
  sessionId: string,
  addMessage: (sessionId: string, msg: ChatMessage) => void,
  setSessionLifecycle: (
    sessionId: string,
    lifecycle: LocalChatLifecycle,
    errorMessage?: string | null
  ) => void,
  clearStreamingAssistant: (
    sessionId: string,
    commitToMessages?: boolean
  ) => void
) {
  if (payload.session_id !== claudeSessionId) return;
  clearStreamingAssistant(sessionId, true);
  setSessionLifecycle(sessionId, "error", payload.error);
  addMessage(sessionId, {
    kind: "error",
    message: payload.error,
    timestamp: new Date().toISOString(),
  });
}

export function handleWarningEvent(
  payload: ClaudeSessionWarningEvent,
  claudeSessionId: string | null,
  sessionId: string,
  addMessage: (sessionId: string, msg: ChatMessage) => void
) {
  if (payload.session_id !== claudeSessionId) return;
  addMessage(sessionId, {
    kind: "warning",
    message: payload.warning,
    timestamp: new Date().toISOString(),
  });
}

// --- Extracted session lifecycle functions ---

export async function doStartSession(
  session: ChatSession,
  sessionId: string,
  deps: {
    setClaudeSessionId: (id: string, backendId: string | null) => void;
    setClaudeSessionIdRef: (backendId: string | null) => void;
    addMessage: (id: string, msg: ChatMessage) => void;
    setSessionLifecycle: (
      id: string,
      lifecycle: LocalChatLifecycle,
      errorMessage?: string | null
    ) => void;
  },
  userMessage?: string
) {
  deps.setSessionLifecycle(
    sessionId,
    session.claudeConversationId ? "resuming" : "starting"
  );

  const backendSessionId = `scoped-${sessionId}-${Date.now()}`;
  deps.setClaudeSessionId(sessionId, backendSessionId);
  deps.setClaudeSessionIdRef(backendSessionId);

  try {
    const initialPrompt = userMessage || undefined;

    if (userMessage) {
      deps.addMessage(sessionId, {
        kind: "user",
        text: userMessage,
        timestamp: new Date().toISOString(),
      });
    }

    let workingDir: string | null = session.projectPath ?? null;
    if (workingDir === null && session.projectPath === undefined) {
      const pathResult = await commands.getCurrentProjectPath();
      if (pathResult.status === "ok" && pathResult.data) {
        workingDir = pathResult.data;
      }
    }

    const resumeId = session.claudeConversationId;
    const modelId = resumeId ? null : (session.selectedModelId ?? null);

    const result = await commands.createClaudeSession(
      backendSessionId,
      workingDir,
      initialPrompt ?? null,
      resumeId,
      modelId
    );
    if (result.status === "error") {
      throw new Error(commandErrorMessage(result.error));
    }
    deps.setSessionLifecycle(sessionId, userMessage ? "streaming" : "idle");
  } catch (error) {
    deps.setClaudeSessionId(sessionId, null);
    deps.setClaudeSessionIdRef(null);
    deps.setSessionLifecycle(sessionId, "error", commandErrorMessage(error));
  }
}

export async function doSendMessage(
  claudeSessionId: string,
  sessionId: string,
  content: string,
  deps: {
    addMessage: (id: string, msg: ChatMessage) => void;
    setSessionLifecycle: (
      id: string,
      lifecycle: LocalChatLifecycle,
      errorMessage?: string | null
    ) => void;
    setClaudeSessionId?: (id: string, backendId: string | null) => void;
    setClaudeSessionIdRef?: (backendId: string | null) => void;
  }
) {
  deps.setSessionLifecycle(sessionId, "sending");
  deps.addMessage(sessionId, {
    kind: "user",
    text: content,
    timestamp: new Date().toISOString(),
  });

  try {
    const result = await commands.sendClaudeMessage(claudeSessionId, content);
    if (result.status === "error") {
      const message = commandErrorMessage(result.error);
      if (isSessionNotFoundError(result.error)) {
        deps.setClaudeSessionId?.(sessionId, null);
        deps.setClaudeSessionIdRef?.(null);
      }
      throw new Error(message);
    }
    deps.setSessionLifecycle(sessionId, "streaming");
  } catch (error) {
    const message = commandErrorMessage(error);
    deps.setSessionLifecycle(sessionId, "error", message);
  }
}

export async function doCloseSession(
  claudeSessionId: string,
  sessionId: string | null,
  deps: {
    markSessionClosed: (id: string) => void;
    setSessionLifecycle: (
      id: string,
      lifecycle: LocalChatLifecycle,
      errorMessage?: string | null
    ) => void;
    setClaudeSessionId: (id: string, backendId: string | null) => void;
    setClaudeSessionIdRef: (backendId: string | null) => void;
  }
): Promise<boolean> {
  if (sessionId) {
    deps.setSessionLifecycle(sessionId, "closing");
  }

  try {
    const result = await commands.closeClaudeSession(claudeSessionId);
    if (result.status === "error") {
      if (isSessionNotFoundError(result.error)) {
        if (sessionId) {
          deps.markSessionClosed(sessionId);
          deps.setClaudeSessionId(sessionId, null);
        }
        deps.setClaudeSessionIdRef(null);
        return true;
      }
      throw new Error(commandErrorMessage(result.error));
    }
    if (sessionId) {
      deps.markSessionClosed(sessionId);
      deps.setClaudeSessionId(sessionId, null);
    }
    deps.setClaudeSessionIdRef(null);
    return true;
  } catch (error) {
    if (sessionId) {
      deps.setSessionLifecycle(sessionId, "error", commandErrorMessage(error));
    }
    return false;
  }
}

/**
 * Hook to manage a scoped Claude chat session.
 *
 * Wraps the chatStore with Claude CLI session lifecycle:
 * - Creates/resumes Claude CLI sessions
 * - Listens for Claude events and routes them to the correct store session
 */
export function useScopedChat(sessionId: string | null) {
  const session = useChatStore((s) =>
    sessionId ? (s.sessions[sessionId] ?? null) : null
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
  const setSessionModel = useChatStore((s) => s.setSessionModel);
  const setSessionUsage = useChatStore((s) => s.setSessionUsage);
  const markSessionClosed = useChatStore((s) => s.markSessionClosed);
  const setSessionLifecycle = useChatStore((s) => s.setSessionLifecycle);
  const clearStreamingAssistant = useChatStore(
    (s) => s.clearStreamingAssistant
  );

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
          setClaudeConversationId,
          setSessionModel
        );
      });
      if (isCancelled) {
        initUn();
        return;
      }
      unlisteners.push(initUn);

      const usageUn = await events.claudeSessionUsageEvent.listen((event) => {
        handleUsageEvent(
          event.payload,
          claudeSessionIdRef.current,
          sessionId,
          setSessionUsage
        );
      });
      if (isCancelled) {
        usageUn();
        return;
      }
      unlisteners.push(usageUn);

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

      if (events.permissionRequestEvent) {
        const sacrumPermissionUn = await events.permissionRequestEvent.listen(
          (event) => {
            handleSacrumPermissionRequestEvent(
              event.payload,
              claudeSessionIdRef.current,
              sessionId,
              addMessage
            );
          }
        );
        if (isCancelled) {
          sacrumPermissionUn();
          return;
        }
        unlisteners.push(sacrumPermissionUn);
      }

      const endUn = await events.claudeSessionEndEvent.listen((event) => {
        handleEndEvent(
          event.payload,
          claudeSessionIdRef.current,
          sessionId,
          setSessionLifecycle,
          clearStreamingAssistant,
          setClaudeSessionId,
          (id) => {
            claudeSessionIdRef.current = id;
          }
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
          addMessage,
          setSessionLifecycle,
          clearStreamingAssistant
        );
      });
      if (isCancelled) {
        errorUn();
        return;
      }
      unlisteners.push(errorUn);

      const warningUn = await events.claudeSessionWarningEvent.listen(
        (event) => {
          handleWarningEvent(
            event.payload,
            claudeSessionIdRef.current,
            sessionId,
            addMessage
          );
        }
      );
      if (isCancelled) {
        warningUn();
        return;
      }
      unlisteners.push(warningUn);
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
    setSessionModel,
    setSessionUsage,
    setSessionLifecycle,
    setClaudeSessionId,
    clearStreamingAssistant,
  ]);

  /**
   * Start the Claude CLI session.
   */
  const startSession = useCallback(
    async (userMessage?: string) => {
      if (!session || !sessionId) return;
      const lifecycle = getLocalChatLifecycle(session);
      if (
        isLocalChatLifecycleBusy(lifecycle) ||
        (session.claudeSessionId && lifecycle !== "error")
      ) {
        return;
      }

      await doStartSession(
        session,
        sessionId,
        {
          setClaudeSessionId,
          setClaudeSessionIdRef: (id) => {
            claudeSessionIdRef.current = id;
          },
          addMessage,
          setSessionLifecycle,
        },
        userMessage
      );
    },
    [session, sessionId, addMessage, setClaudeSessionId, setSessionLifecycle]
  );

  /**
   * Send a message to the active Claude session.
   */
  const sendMessage = useCallback(
    async (content: string) => {
      if (!session?.claudeSessionId || !sessionId) return;

      await doSendMessage(session.claudeSessionId, sessionId, content, {
        addMessage,
        setSessionLifecycle,
        setClaudeSessionId,
        setClaudeSessionIdRef: (id) => {
          claudeSessionIdRef.current = id;
        },
      });
    },
    [
      session?.claudeSessionId,
      sessionId,
      addMessage,
      setSessionLifecycle,
      setClaudeSessionId,
    ]
  );

  /**
   * Close the Claude CLI session.
   */
  const closeClaudeSession = useCallback(async () => {
    if (!session?.claudeSessionId) return true;
    return doCloseSession(session.claudeSessionId, sessionId, {
      markSessionClosed,
      setSessionLifecycle,
      setClaudeSessionId,
      setClaudeSessionIdRef: (id) => {
        claudeSessionIdRef.current = id;
      },
    });
  }, [
    session?.claudeSessionId,
    sessionId,
    markSessionClosed,
    setSessionLifecycle,
    setClaudeSessionId,
  ]);

  const isActive =
    session?.status === "open" &&
    session?.claudeSessionId !== null &&
    session.lifecycle !== "closing" &&
    session.lifecycle !== "closed" &&
    session.lifecycle !== "error";

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
    async (scope: ChatScope, entityId: string | null, label: string) => {
      let projectPath: string | null = null;
      try {
        const pathResult = await commands.getCurrentProjectPath();
        if (pathResult.status === "ok" && pathResult.data) {
          projectPath = pathResult.data;
        }
      } catch {
        // Preserve the existing open behavior when the path lookup fails.
      }
      return openSession(scope, entityId, label, projectPath);
    },
    [openSession]
  );
}

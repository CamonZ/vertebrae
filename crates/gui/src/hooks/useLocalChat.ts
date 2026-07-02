import { useCallback, useEffect, useRef } from "react";
import { commands, events } from "../bindings";
import type {
  LocalChatSessionInitEvent,
  LocalChatSessionUsageEvent,
  LocalChatTextEvent,
  LocalChatToolCallEvent,
  LocalChatToolResultEvent,
  PermissionRequestEvent,
  LocalChatSessionEndEvent,
  LocalChatSessionErrorEvent,
  LocalChatSessionWarningEvent,
} from "../bindings";
import {
  getLocalChatLifecycle,
  isLocalChatLifecycleBusy,
  useChatStore,
} from "../stores/chatStore";
import type {
  ChatSession,
  ChatMessage,
  ChatTitleCandidate,
  LocalChatLifecycle,
} from "../stores/chatStore";
import { DEFAULT_LOCAL_CHAT_HARNESS } from "../utils/localChatPersistence";
import { resolveContextWindow } from "../utils/modelContextWindow";

const AUTOMATIC_LOCAL_CHAT_LABELS = new Set(["New Chat", "Project Chat"]);
const MAX_TITLE_USER_MESSAGES = 3;

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
  return "Local chat session failed";
}

function commandErrorKind(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  return Object.keys(error)[0] ?? null;
}

function isSessionNotFoundError(error: unknown): boolean {
  return commandErrorKind(error) === "SessionNotFound";
}

function earlyTitleUserMessages(
  messages: ChatMessage[],
  pendingUserMessage?: string | null
): string[] {
  const userMessages = messages
    .filter(
      (message): message is Extract<ChatMessage, { kind: "user" }> =>
        message.kind === "user"
    )
    .map((message) => message.text.trim())
    .filter(Boolean);
  const pending = pendingUserMessage?.trim();
  if (pending) {
    userMessages.push(pending);
  }
  return userMessages.slice(0, MAX_TITLE_USER_MESSAGES);
}

function shouldInferSessionTitle(session: ChatSession, userMessages: string[]) {
  return (
    userMessages.length > 0 &&
    userMessages.length <= MAX_TITLE_USER_MESSAGES &&
    !session.title?.trim() &&
    session.titleStatus !== "generated" &&
    session.titleStatus !== "manual" &&
    (session.titleUserMessageCount ?? 0) < userMessages.length &&
    AUTOMATIC_LOCAL_CHAT_LABELS.has(session.label)
  );
}

function inferSessionTitleInBackground(
  session: ChatSession,
  sessionId: string,
  userMessages: string[],
  workingDir: string | null,
  setSessionTitleCandidate?: (
    sessionId: string,
    candidate: ChatTitleCandidate
  ) => void
) {
  if (
    !setSessionTitleCandidate ||
    !shouldInferSessionTitle(session, userMessages)
  ) {
    return;
  }

  const userMessageCount = userMessages.length;

  void commands
    .inferLocalChatSessionTitle({
      harness: session.harness ?? DEFAULT_LOCAL_CHAT_HARNESS,
      initial_prompts: userMessages,
      working_dir: workingDir,
    })
    .then((result) => {
      if (result.status === "ok") {
        setSessionTitleCandidate(sessionId, {
          title: result.data.title,
          confidence: result.data.confidence,
          sufficientSignal: result.data.sufficient_signal,
          userMessageCount,
        });
      } else {
        console.warn(
          "Failed to infer local chat session title",
          commandErrorMessage(result.error)
        );
      }
    })
    .catch((error) => {
      console.warn("Failed to infer local chat session title", error);
    });
}

export function handleInitEvent(
  payload: LocalChatSessionInitEvent,
  backendSessionId: string | null,
  sessionId: string,
  setProviderResumeId: (sessionId: string, providerResumeId: string) => void,
  setSessionModel: (sessionId: string, model: string) => void
) {
  if (payload.backend_session_id !== backendSessionId) return;
  if (payload.provider_resume_id) {
    setProviderResumeId(sessionId, payload.provider_resume_id);
  }
  if (payload.model) {
    setSessionModel(sessionId, payload.model);
  }
}

// Usage events carry current request input-context tokens (input + cache read
// + cache creation). Frontend lookup table wins for per-model maxes; see
// modelContextWindow.ts.
export function handleUsageEvent(
  payload: LocalChatSessionUsageEvent,
  backendSessionId: string | null,
  sessionId: string,
  setSessionUsage: (
    sessionId: string,
    model: string,
    usage: { used: number; max: number }
  ) => void
) {
  if (payload.backend_session_id !== backendSessionId) return;
  const max = resolveContextWindow(payload.model, payload.context_window);
  if (max && max > 0) {
    setSessionUsage(sessionId, payload.model, {
      used: payload.context_tokens,
      max,
    });
  }
}

export function handleTextEvent(
  payload: LocalChatTextEvent,
  backendSessionId: string | null,
  sessionId: string,
  updateLastAssistantMessage: (sessionId: string, text: string) => void,
  finalizeLastAssistantMessage: (sessionId: string, text: string) => void,
  addMessage?: (sessionId: string, msg: ChatMessage) => void
) {
  if (payload.backend_session_id !== backendSessionId) return;
  const parentToolUseId = payload.parent_tool_use_id ?? undefined;
  if (parentToolUseId) {
    addMessage?.(sessionId, {
      kind: "assistant",
      text: payload.text,
      timestamp: new Date().toISOString(),
      isPartial: payload.is_partial,
      parentToolUseId,
    });
    return;
  }
  if (payload.is_partial) {
    updateLastAssistantMessage(sessionId, payload.text);
  } else {
    finalizeLastAssistantMessage(sessionId, payload.text);
  }
}

export function handleToolCallEvent(
  payload: LocalChatToolCallEvent,
  backendSessionId: string | null,
  sessionId: string,
  addMessage: (sessionId: string, msg: ChatMessage) => void
) {
  if (payload.backend_session_id !== backendSessionId) return;
  addMessage(sessionId, {
    kind: "tool_call",
    toolName: payload.tool_name,
    toolId: payload.tool_id,
    input: payload.input,
    timestamp: new Date().toISOString(),
    parentToolUseId: payload.parent_tool_use_id ?? undefined,
  });
}

export function handleToolResultEvent(
  payload: LocalChatToolResultEvent,
  backendSessionId: string | null,
  sessionId: string,
  addMessage: (sessionId: string, msg: ChatMessage) => void
) {
  if (payload.backend_session_id !== backendSessionId) return;
  addMessage(sessionId, {
    kind: "tool_result",
    toolId: payload.tool_id,
    result: payload.result,
    isError: payload.is_error,
    timestamp: new Date().toISOString(),
    parentToolUseId: payload.parent_tool_use_id ?? undefined,
  });
}

export function handleSacrumPermissionRequestEvent(
  payload: PermissionRequestEvent,
  backendSessionId: string | null,
  sessionId: string,
  addMessage: (sessionId: string, msg: ChatMessage) => void
) {
  if (payload.session_id !== backendSessionId) return;
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
  payload: LocalChatSessionEndEvent,
  backendSessionId: string | null,
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
  setBackendSessionId: (sessionId: string, backendId: string | null) => void,
  setBackendSessionIdRef: (backendId: string | null) => void
) {
  if (payload.backend_session_id !== backendSessionId) return;
  // Session-end modelUsage is a session summary, not the per-turn request
  // input-context value that drives the badge.
  clearStreamingAssistant(sessionId, true);
  setBackendSessionId(sessionId, null);
  setBackendSessionIdRef(null);
  if (payload.is_error) {
    setSessionLifecycle(
      sessionId,
      "error",
      payload.result || "Local chat session ended with an error"
    );
    return;
  }
  setSessionLifecycle(sessionId, "idle");
}

export function handleErrorEvent(
  payload: LocalChatSessionErrorEvent,
  backendSessionId: string | null,
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
  if (payload.backend_session_id !== backendSessionId) return;
  clearStreamingAssistant(sessionId, true);
  setSessionLifecycle(sessionId, "error", payload.error);
  addMessage(sessionId, {
    kind: "error",
    message: payload.error,
    timestamp: new Date().toISOString(),
  });
}

export function handleWarningEvent(
  payload: LocalChatSessionWarningEvent,
  backendSessionId: string | null,
  sessionId: string,
  addMessage: (sessionId: string, msg: ChatMessage) => void
) {
  if (payload.backend_session_id !== backendSessionId) return;
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
    setBackendSessionId: (id: string, backendId: string | null) => void;
    setBackendSessionIdRef: (backendId: string | null) => void;
    addMessage: (id: string, msg: ChatMessage) => void;
    setSessionTitleCandidate?: (
      id: string,
      candidate: ChatTitleCandidate
    ) => void;
    setSessionLifecycle: (
      id: string,
      lifecycle: LocalChatLifecycle,
      errorMessage?: string | null
    ) => void;
  },
  userMessage?: string,
  options: { addUserMessage?: boolean } = {}
) {
  deps.setSessionLifecycle(
    sessionId,
    session.providerResumeId ? "resuming" : "starting"
  );

  const backendSessionId = `local-${sessionId}-${Date.now()}`;
  deps.setBackendSessionId(sessionId, backendSessionId);
  deps.setBackendSessionIdRef(backendSessionId);

  try {
    const initialPrompt = userMessage || undefined;

    if (userMessage && options.addUserMessage !== false) {
      deps.addMessage(sessionId, {
        kind: "user",
        text: userMessage,
        timestamp: new Date().toISOString(),
      });
    }

    let workingDir: string | null = session.projectPath ?? null;
    if (!workingDir) {
      const pathResult = await commands.getCurrentProjectPath();
      if (pathResult.status === "ok" && pathResult.data) {
        workingDir = pathResult.data;
      }
    }

    const resumeId = session.providerResumeId;
    const modelId = resumeId ? null : (session.selectedModelId ?? null);
    const reasoningEffort = resumeId
      ? null
      : (session.selectedReasoningEffort ?? null);
    const permissionMode = session.permissionMode ?? "default";

    const titleUserMessages = earlyTitleUserMessages(
      session.messages,
      options.addUserMessage === false ? null : initialPrompt
    );
    if (titleUserMessages.length > 0) {
      inferSessionTitleInBackground(
        session,
        sessionId,
        titleUserMessages,
        workingDir,
        deps.setSessionTitleCandidate
      );
    }

    const result = await commands.createLocalChatSession({
      harness: session.harness ?? DEFAULT_LOCAL_CHAT_HARNESS,
      backend_session_id: backendSessionId,
      working_dir: workingDir,
      initial_prompt: initialPrompt ?? null,
      provider_resume_id: resumeId,
      model_id: modelId,
      reasoning_effort: reasoningEffort,
      permission_mode: permissionMode,
    });
    if (result.status === "error") {
      throw new Error(commandErrorMessage(result.error));
    }
    deps.setSessionLifecycle(sessionId, userMessage ? "streaming" : "idle");
  } catch (error) {
    const message = commandErrorMessage(error);
    deps.setBackendSessionId(sessionId, null);
    deps.setBackendSessionIdRef(null);
    deps.addMessage(sessionId, {
      kind: "error",
      message,
      timestamp: new Date().toISOString(),
    });
    deps.setSessionLifecycle(sessionId, "error", message);
  }
}

export async function doSendMessage(
  backendSessionId: string,
  sessionId: string,
  content: string,
  deps: {
    addMessage: (id: string, msg: ChatMessage) => void;
    setSessionLifecycle: (
      id: string,
      lifecycle: LocalChatLifecycle,
      errorMessage?: string | null
    ) => void;
    setBackendSessionId?: (id: string, backendId: string | null) => void;
    setBackendSessionIdRef?: (backendId: string | null) => void;
  },
  options: { addUserMessage?: boolean } = {}
) {
  deps.setSessionLifecycle(sessionId, "sending");
  if (options.addUserMessage !== false) {
    deps.addMessage(sessionId, {
      kind: "user",
      text: content,
      timestamp: new Date().toISOString(),
    });
  }

  try {
    const result = await commands.sendLocalChatMessage(
      backendSessionId,
      content
    );
    if (result.status === "error") {
      const message = commandErrorMessage(result.error);
      if (isSessionNotFoundError(result.error)) {
        deps.setBackendSessionId?.(sessionId, null);
        deps.setBackendSessionIdRef?.(null);
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
  backendSessionId: string,
  sessionId: string | null,
  deps: {
    markSessionClosed: (id: string) => void;
    setSessionLifecycle: (
      id: string,
      lifecycle: LocalChatLifecycle,
      errorMessage?: string | null
    ) => void;
    setBackendSessionId: (id: string, backendId: string | null) => void;
    setBackendSessionIdRef: (backendId: string | null) => void;
  }
): Promise<boolean> {
  if (sessionId) {
    deps.setSessionLifecycle(sessionId, "closing");
  }

  try {
    const result = await commands.closeLocalChatSession(backendSessionId);
    if (result.status === "error") {
      if (isSessionNotFoundError(result.error)) {
        if (sessionId) {
          deps.markSessionClosed(sessionId);
          deps.setBackendSessionId(sessionId, null);
        }
        deps.setBackendSessionIdRef(null);
        return true;
      }
      throw new Error(commandErrorMessage(result.error));
    }
    if (sessionId) {
      deps.markSessionClosed(sessionId);
      deps.setBackendSessionId(sessionId, null);
    }
    deps.setBackendSessionIdRef(null);
    return true;
  } catch (error) {
    if (sessionId) {
      deps.setSessionLifecycle(sessionId, "error", commandErrorMessage(error));
    }
    return false;
  }
}

/**
 * Hook to manage a provider-neutral local chat session.
 *
 * Wraps the chatStore with local harness lifecycle:
 * - Creates/resumes local chat sessions
 * - Listens for local-chat events and routes them to the correct store session
 */
export function useLocalChat(sessionId: string | null) {
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
  const setBackendSessionId = useChatStore((s) => s.setBackendSessionId);
  const setProviderResumeId = useChatStore((s) => s.setProviderResumeId);
  const setSessionModel = useChatStore((s) => s.setSessionModel);
  const setSessionTitleCandidate = useChatStore(
    (s) => s.setSessionTitleCandidate
  );
  const setSessionUsage = useChatStore((s) => s.setSessionUsage);
  const markSessionClosed = useChatStore((s) => s.markSessionClosed);
  const setSessionLifecycle = useChatStore((s) => s.setSessionLifecycle);
  const clearStreamingAssistant = useChatStore(
    (s) => s.clearStreamingAssistant
  );

  // Track the runtime backend session ID for event filtering.
  const backendSessionIdRef = useRef<string | null>(null);
  const queuedMessagesRef = useRef<string[]>([]);

  // Keep ref in sync
  useEffect(() => {
    backendSessionIdRef.current = session?.backendSessionId ?? null;
  }, [session?.backendSessionId]);

  // Subscribe to local-chat events - filter by our backend session ID.
  useEffect(() => {
    if (!sessionId) return;

    const unlisteners: Array<() => void> = [];
    let isCancelled = false;

    const setup = async () => {
      const initUn = await events.localChatSessionInitEvent.listen((event) => {
        handleInitEvent(
          event.payload,
          backendSessionIdRef.current,
          sessionId,
          setProviderResumeId,
          setSessionModel
        );
      });
      if (isCancelled) {
        initUn();
        return;
      }
      unlisteners.push(initUn);

      const usageUn = await events.localChatSessionUsageEvent.listen(
        (event) => {
          handleUsageEvent(
            event.payload,
            backendSessionIdRef.current,
            sessionId,
            setSessionUsage
          );
        }
      );
      if (isCancelled) {
        usageUn();
        return;
      }
      unlisteners.push(usageUn);

      const textUn = await events.localChatTextEvent.listen((event) => {
        handleTextEvent(
          event.payload,
          backendSessionIdRef.current,
          sessionId,
          updateLastAssistantMessage,
          finalizeLastAssistantMessage,
          addMessage
        );
      });
      if (isCancelled) {
        textUn();
        return;
      }
      unlisteners.push(textUn);

      const toolCallUn = await events.localChatToolCallEvent.listen((event) => {
        handleToolCallEvent(
          event.payload,
          backendSessionIdRef.current,
          sessionId,
          addMessage
        );
      });
      if (isCancelled) {
        toolCallUn();
        return;
      }
      unlisteners.push(toolCallUn);

      const toolResultUn = await events.localChatToolResultEvent.listen(
        (event) => {
          handleToolResultEvent(
            event.payload,
            backendSessionIdRef.current,
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

      if (events.permissionRequestEvent) {
        const sacrumPermissionUn = await events.permissionRequestEvent.listen(
          (event) => {
            handleSacrumPermissionRequestEvent(
              event.payload,
              backendSessionIdRef.current,
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

      const endUn = await events.localChatSessionEndEvent.listen((event) => {
        handleEndEvent(
          event.payload,
          backendSessionIdRef.current,
          sessionId,
          setSessionLifecycle,
          clearStreamingAssistant,
          setBackendSessionId,
          (id) => {
            backendSessionIdRef.current = id;
          }
        );
      });
      if (isCancelled) {
        endUn();
        return;
      }
      unlisteners.push(endUn);

      const errorUn = await events.localChatSessionErrorEvent.listen(
        (event) => {
          handleErrorEvent(
            event.payload,
            backendSessionIdRef.current,
            sessionId,
            addMessage,
            setSessionLifecycle,
            clearStreamingAssistant
          );
        }
      );
      if (isCancelled) {
        errorUn();
        return;
      }
      unlisteners.push(errorUn);

      const warningUn = await events.localChatSessionWarningEvent.listen(
        (event) => {
          handleWarningEvent(
            event.payload,
            backendSessionIdRef.current,
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
    setProviderResumeId,
    setSessionModel,
    setSessionUsage,
    setSessionLifecycle,
    setBackendSessionId,
    clearStreamingAssistant,
  ]);

  /**
   * Start the local chat session.
   */
  const startSession = useCallback(
    async (userMessage?: string) => {
      if (!session || !sessionId) return;
      const lifecycle = getLocalChatLifecycle(session);
      if (
        isLocalChatLifecycleBusy(lifecycle) ||
        (session.backendSessionId && lifecycle !== "error")
      ) {
        return;
      }

      await doStartSession(
        session,
        sessionId,
        {
          setBackendSessionId,
          setBackendSessionIdRef: (id) => {
            backendSessionIdRef.current = id;
          },
          addMessage,
          setSessionTitleCandidate,
          setSessionLifecycle,
        },
        userMessage
      );
    },
    [
      session,
      sessionId,
      addMessage,
      setBackendSessionId,
      setSessionLifecycle,
      setSessionTitleCandidate,
    ]
  );

  useEffect(() => {
    if (!session || !sessionId) return;
    if (queuedMessagesRef.current.length === 0) return;

    const lifecycle = getLocalChatLifecycle(session);
    if (lifecycle !== "idle") return;

    const content = queuedMessagesRef.current.shift();
    if (!content) return;

    if (session.backendSessionId) {
      void doSendMessage(
        session.backendSessionId,
        sessionId,
        content,
        {
          addMessage,
          setSessionLifecycle,
          setBackendSessionId,
          setBackendSessionIdRef: (id) => {
            backendSessionIdRef.current = id;
          },
        },
        { addUserMessage: false }
      );
      return;
    }

    void doStartSession(
      session,
      sessionId,
      {
        setBackendSessionId,
        setBackendSessionIdRef: (id) => {
          backendSessionIdRef.current = id;
        },
        addMessage,
        setSessionTitleCandidate,
        setSessionLifecycle,
      },
      content,
      { addUserMessage: false }
    );
  }, [
    session,
    sessionId,
    addMessage,
    setBackendSessionId,
    setSessionLifecycle,
    setSessionTitleCandidate,
  ]);

  /**
   * Send a message to the active local chat session.
   */
  const sendMessage = useCallback(
    async (content: string) => {
      if (!session?.backendSessionId || !sessionId) return;
      const lifecycle = getLocalChatLifecycle(session);
      if (
        lifecycle === "starting" ||
        lifecycle === "resuming" ||
        lifecycle === "sending" ||
        lifecycle === "streaming"
      ) {
        inferSessionTitleInBackground(
          session,
          sessionId,
          earlyTitleUserMessages(session.messages, content),
          session.projectPath ?? null,
          setSessionTitleCandidate
        );
        queuedMessagesRef.current.push(content);
        addMessage(sessionId, {
          kind: "user",
          text: content,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      inferSessionTitleInBackground(
        session,
        sessionId,
        earlyTitleUserMessages(session.messages, content),
        session.projectPath ?? null,
        setSessionTitleCandidate
      );
      await doSendMessage(session.backendSessionId, sessionId, content, {
        addMessage,
        setSessionLifecycle,
        setBackendSessionId,
        setBackendSessionIdRef: (id) => {
          backendSessionIdRef.current = id;
        },
      });
    },
    [
      session,
      sessionId,
      addMessage,
      setSessionLifecycle,
      setBackendSessionId,
      setSessionTitleCandidate,
    ]
  );

  /**
   * Close the local chat session.
   */
  const closeLocalChatSession = useCallback(
    async (options?: { markClosed?: boolean }) => {
      if (!session?.backendSessionId) return true;
      return doCloseSession(session.backendSessionId, sessionId, {
        markSessionClosed:
          options?.markClosed === false
            ? (id) => setSessionLifecycle(id, "idle")
            : markSessionClosed,
        setSessionLifecycle,
        setBackendSessionId,
        setBackendSessionIdRef: (id) => {
          backendSessionIdRef.current = id;
        },
      });
    },
    [
      session?.backendSessionId,
      sessionId,
      markSessionClosed,
      setSessionLifecycle,
      setBackendSessionId,
    ]
  );

  const isActive =
    session?.status === "open" &&
    !!session?.backendSessionId &&
    session.lifecycle !== "closing" &&
    session.lifecycle !== "closed" &&
    session.lifecycle !== "error";

  return {
    session,
    isActive,
    startSession,
    sendMessage,
    closeLocalChatSession,
  };
}

/**
 * Helper hook to open a local chat session from any component.
 */
export function useOpenChat() {
  const openSession = useChatStore((s) => s.openSession);

  return useCallback(
    async (label = "New Chat", projectPathOverride?: string | null) => {
      let projectPath: string | null = projectPathOverride ?? null;
      if (projectPathOverride === undefined) {
        try {
          const pathResult = await commands.getCurrentProjectPath();
          if (pathResult.status === "ok" && pathResult.data) {
            projectPath = pathResult.data;
          }
        } catch {
          // Null is the no-project bucket; it reuses only null-path sessions.
        }
      }
      return openSession(label, projectPath);
    },
    [openSession]
  );
}

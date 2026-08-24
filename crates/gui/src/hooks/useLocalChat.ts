import { useCallback, useState } from "react";
import { commands } from "../bindings";
import type {
  LocalChatSessionInitEvent,
  LocalChatSessionUsageEvent,
  LocalChatTextEvent,
  LocalChatToolCallEvent,
  LocalChatToolResultEvent,
  LocalChatFileChangeEvent,
  PermissionRequestEvent,
  LocalChatSessionEndEvent,
  LocalChatSessionErrorEvent,
  LocalChatSessionWarningEvent,
  LocalChatCompactionEvent,
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
  TitleCandidateOptions,
  ChatCompactionSummary,
  LocalChatLifecycle,
} from "../stores/chatStore";
import {
  DEFAULT_LOCAL_CHAT_HARNESS,
  isAutomaticLocalChatLabel,
} from "../utils/localChatPersistence";
import { resolveContextWindow } from "../utils/modelContextWindow";
import { recordLocalChatTrace } from "../utils/localChatDebug";

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

/**
 * Convert the active, provider-neutral chat transcript into the text entries
 * consumed by the existing title inference command. Role markers keep the
 * shared command aware of the conversation shape without exposing Claude or
 * Codex wire formats to the UI.
 */
function formatTitleInferenceEntry(message: ChatMessage): string {
  switch (message.kind) {
    case "user":
      return `User: ${message.text}`;
    case "assistant":
      return `Assistant${message.isPartial ? " (partial)" : ""}: ${message.text}`;
    case "tool_call":
      return `Tool call (${message.toolName}): ${message.input}`;
    case "tool_result":
      return `Tool result${message.isError ? " (error)" : ""}: ${message.result}`;
    case "file_edit":
      return `File edit (${message.status}): ${JSON.stringify(message.changes)}`;
    case "permission_request":
      return `Permission request (${message.toolName}): ${message.message}${
        message.input ? ` Input: ${message.input}` : ""
      }`;
    case "user_question":
      return `User question: ${JSON.stringify(message.questions)}${
        message.inputError ? ` Error: ${message.inputError}` : ""
      }`;
    case "session_start":
      return `Session started (${message.model})`;
    case "warning":
      return `Warning: ${message.message}`;
    case "task_notification":
      return `Task notification: ${message.message}`;
    case "session_end":
      return `Session ended after ${message.numTurns} turns (${message.durationMs}ms, ${message.costUsd} USD)`;
    case "error":
      return `Error: ${message.message}`;
  }
}

function hasTitleInferenceContent(entry: string): boolean {
  const separator = entry.indexOf(": ");
  return entry.trim().length > separator + 2;
}

export function titleInferenceTranscript(messages: ChatMessage[]): {
  entries: string[];
  userMessageCount: number;
} {
  let userMessageCount = 0;
  const entries = messages.flatMap((message) => {
    if (message.kind === "user") {
      userMessageCount += 1;
    }
    const entry = formatTitleInferenceEntry(message);
    return hasTitleInferenceContent(entry) ? [entry] : [];
  });
  return { entries, userMessageCount };
}

function shouldInferSessionTitle(session: ChatSession, userMessages: string[]) {
  return (
    userMessages.length > 0 &&
    userMessages.length <= MAX_TITLE_USER_MESSAGES &&
    !session.title?.trim() &&
    session.titleStatus !== "generated" &&
    session.titleStatus !== "manual" &&
    (session.titleUserMessageCount ?? 0) < userMessages.length &&
    isAutomaticLocalChatLabel(session.label)
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

export async function doRegenerateSessionTitle(
  session: ChatSession,
  sessionId: string,
  setSessionTitleCandidate: (
    sessionId: string,
    candidate: ChatTitleCandidate,
    options?: TitleCandidateOptions
  ) => void
): Promise<string | null> {
  if (session.titleStatus === "manual") return null;
  if (session.providerMessagesHydrating) {
    return "Chat history is still loading. Try again in a moment.";
  }

  const transcript = titleInferenceTranscript(session.messages);
  if (transcript.entries.length === 0) {
    return "Add a message before regenerating the chat title.";
  }

  try {
    const result = await commands.inferLocalChatSessionTitle({
      harness: session.harness ?? DEFAULT_LOCAL_CHAT_HARNESS,
      initial_prompts: transcript.entries,
      working_dir: session.projectPath ?? null,
    });
    if (result.status === "error") {
      return commandErrorMessage(result.error);
    }

    const candidateOptions: TitleCandidateOptions = {
      replaceGenerated: true,
      expectedMessageCount: session.messages.length,
    };
    if (session.updatedAt) {
      candidateOptions.expectedUpdatedAt = session.updatedAt;
    }
    setSessionTitleCandidate(
      sessionId,
      {
        title: result.data.title,
        confidence: result.data.confidence,
        sufficientSignal: result.data.sufficient_signal,
        userMessageCount: transcript.userMessageCount,
      },
      candidateOptions
    );
    return null;
  } catch (error) {
    return commandErrorMessage(error);
  }
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
    usage: { used: number; max: number },
    threadTotalTokens?: number
  ) => void
) {
  if (payload.backend_session_id !== backendSessionId) return;
  const max = resolveContextWindow(payload.model, payload.context_window);
  if (max && max > 0) {
    const usage = {
      used: payload.context_tokens,
      max,
    };
    if (payload.thread_total_tokens === undefined) {
      setSessionUsage(sessionId, payload.model, usage);
    } else {
      setSessionUsage(
        sessionId,
        payload.model,
        usage,
        payload.thread_total_tokens
      );
    }
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

export function handleFileChangeEvent(
  payload: LocalChatFileChangeEvent,
  backendSessionId: string | null,
  sessionId: string,
  addMessage: (sessionId: string, msg: ChatMessage) => void
) {
  if (payload.backend_session_id !== backendSessionId) return;
  addMessage(sessionId, {
    kind: "file_edit",
    toolId: payload.tool_id,
    status: payload.status,
    changes: payload.changes.map((change) => ({
      path: change.path,
      kind: change.kind,
      ...(change.diff !== null ? { diff: change.diff } : {}),
    })),
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
  if (payload.tool_name === "AskUserQuestion") {
    const originalQuestions =
      payload.input &&
      typeof payload.input === "object" &&
      !Array.isArray(payload.input) &&
      "questions" in payload.input
        ? (payload.input.questions ?? [])
        : [];
    addMessage(sessionId, {
      kind: "user_question",
      requestId: payload.request_id,
      toolUseId: payload.tool_use_id,
      questions: payload.questions ?? [],
      originalQuestions,
      inputError:
        payload.input_error ??
        (payload.questions
          ? undefined
          : "AskUserQuestion payload could not be parsed"),
      status: "pending",
      timestamp: new Date().toISOString(),
    });
    return;
  }
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
  ) => void
) {
  if (payload.backend_session_id !== backendSessionId) return;
  // Session-end modelUsage is a session summary, not the per-turn request
  // input-context value that drives the badge.
  clearStreamingAssistant(sessionId, true);
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
  ) => void,
  setBackendSessionId: (sessionId: string, backendId: string | null) => void,
  setBackendSessionIdRef?: (backendId: string | null) => void
) {
  if (payload.backend_session_id !== backendSessionId) return;
  clearStreamingAssistant(sessionId, true);
  setBackendSessionId(sessionId, null);
  setBackendSessionIdRef?.(null);
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

export function handleCompactionEvent(
  payload: LocalChatCompactionEvent,
  backendSessionId: string | null,
  sessionId: string,
  setSessionCompaction: (sessionId: string, active: boolean) => void,
  setCompactionSummary: (
    sessionId: string,
    summary: ChatCompactionSummary | null
  ) => void
) {
  if (payload.backend_session_id !== backendSessionId) return;
  if (payload.state === "completed") {
    setSessionCompaction(sessionId, false);
    setCompactionSummary(sessionId, {
      trigger: payload.trigger ?? null,
      preTokens: payload.pre_tokens ?? null,
    });
    return;
  }
  setSessionCompaction(sessionId, payload.state === "active");
  if (payload.state === "active") setCompactionSummary(sessionId, null);
  if (payload.state === "cleared") setCompactionSummary(sessionId, null);
}

// --- Extracted session lifecycle functions ---

/**
 * Identity probes for the session a lifecycle call started out owning.
 *
 * Every lifecycle call awaits an IPC round trip, during which a Stop or a
 * replacement turn can take the session somewhere else. Writing the result
 * back unconditionally is how a resolved-too-late call resurrects a lifecycle
 * that no longer exists or tears down a session that already moved on.
 */
export interface TurnOwnershipDeps {
  getActiveTurnLocalId?: (id: string) => string | null;
  getBackendSessionId?: (id: string) => string | null;
}

export function currentBackendSessionId(sessionId: string): string | null {
  return useChatStore.getState().sessions[sessionId]?.backendSessionId ?? null;
}

export function currentActiveTurnLocalId(sessionId: string): string | null {
  return (
    useChatStore.getState().sessions[sessionId]?.activeTurn?.localId ?? null
  );
}

function makeStalenessCheck(
  deps: TurnOwnershipDeps,
  sessionId: string | null,
  backendSessionId: string | null,
  expectedActiveTurnLocalId?: string | null
): () => boolean {
  return () => {
    if (!sessionId) return false;
    if (
      deps.getBackendSessionId &&
      backendSessionId !== null &&
      deps.getBackendSessionId(sessionId) !== backendSessionId
    ) {
      return true;
    }
    if (!expectedActiveTurnLocalId) return false;
    const currentLocalId = deps.getActiveTurnLocalId?.(sessionId) ?? null;
    return (
      currentLocalId !== null && currentLocalId !== expectedActiveTurnLocalId
    );
  };
}

export async function doStartSession(
  session: ChatSession,
  sessionId: string,
  deps: {
    setBackendSessionId: (id: string, backendId: string | null) => void;
    setBackendSessionIdRef?: (backendId: string | null) => void;
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
    beginActiveTurn?: (id: string) => string | null;
    settleActiveTurn?: (id: string, turnId?: string | null) => boolean;
  } & TurnOwnershipDeps,
  userMessage?: string,
  options: { addUserMessage?: boolean } = {}
) {
  const resumeId = session.providerResumeId;
  deps.setSessionLifecycle(sessionId, resumeId ? "resuming" : "starting");
  const activeTurnLocalId = userMessage
    ? (deps.beginActiveTurn?.(sessionId) ?? null)
    : null;

  const backendSessionId = `local-${sessionId}-${Date.now()}`;
  const initialPrompt = userMessage || undefined;
  deps.setBackendSessionId(sessionId, backendSessionId);
  deps.setBackendSessionIdRef?.(backendSessionId);
  recordLocalChatTrace({
    source: "gui",
    kind: "session.start.requested",
    direction: "gui_to_tauri",
    sessionId,
    backendSessionId,
    state: resumeId ? "resuming" : "starting",
    payload: initialPrompt ?? undefined,
  });
  const completionIsStale = makeStalenessCheck(
    deps,
    sessionId,
    backendSessionId,
    activeTurnLocalId
  );

  try {
    if (userMessage && options.addUserMessage !== false) {
      deps.addMessage(sessionId, {
        kind: "user",
        text: userMessage,
        timestamp: new Date().toISOString(),
      });
    }

    let workingDir: string | null = session.projectPath ?? null;
    if (workingDir === null) {
      const pathResult = await commands.getCurrentProjectPath();
      if (pathResult.status === "ok" && pathResult.data) {
        workingDir = pathResult.data;
      }
    }

    const modelId = resumeId ? null : (session.selectedModelId ?? null);
    const reasoningEffort = resumeId
      ? null
      : (session.selectedReasoningEffort ?? null);
    const speedTier = resumeId ? null : (session.selectedSpeedTier ?? null);
    const permissionMode = session.permissionMode ?? "default";
    const personality = session.selectedPersonality ?? null;

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
      ...(speedTier ? { speed_tier: speedTier } : {}),
      permission_mode: permissionMode,
      personality,
    });
    if (result.status === "error") {
      recordLocalChatTrace({
        source: "gui",
        kind: "session.start.rejected",
        direction: "tauri_to_gui",
        sessionId,
        backendSessionId,
        state: "error",
        detail: commandErrorMessage(result.error),
      });
      throw new Error(commandErrorMessage(result.error));
    }
    recordLocalChatTrace({
      source: "gui",
      kind: "session.start.accepted",
      direction: "tauri_to_gui",
      sessionId,
      backendSessionId,
      state: userMessage ? "streaming" : "idle",
    });
    // A Stop (or a replacement start) that landed while this create was in
    // flight already nulled the backend session. Writing "streaming" back here
    // strands the session busy with nothing running and no way to recover.
    if (completionIsStale()) return;
    deps.setSessionLifecycle(sessionId, userMessage ? "streaming" : "idle");
  } catch (error) {
    if (completionIsStale()) return;
    const message = commandErrorMessage(error);
    recordLocalChatTrace({
      source: "gui",
      kind: "session.start.failed",
      direction: "internal",
      sessionId,
      backendSessionId,
      state: "error",
      detail: message,
    });
    deps.setBackendSessionId(sessionId, null);
    deps.setBackendSessionIdRef?.(null);
    deps.addMessage(sessionId, {
      kind: "error",
      message,
      timestamp: new Date().toISOString(),
    });
    if (userMessage) deps.settleActiveTurn?.(sessionId);
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
    markStreamingIfSending: (id: string) => void;
    beginActiveTurn?: (id: string) => string | null;
    settleActiveTurn?: (id: string, turnId?: string | null) => boolean;
    setBackendSessionId?: (id: string, backendId: string | null) => void;
    setBackendSessionIdRef?: (backendId: string | null) => void;
  } & TurnOwnershipDeps,
  options: { addUserMessage?: boolean } = {}
) {
  const activeTurnLocalId = deps.beginActiveTurn?.(sessionId) ?? null;
  const completionIsStale = makeStalenessCheck(
    deps,
    sessionId,
    backendSessionId,
    activeTurnLocalId
  );
  deps.setSessionLifecycle(sessionId, "sending");
  recordLocalChatTrace({
    source: "gui",
    kind: "message.send.requested",
    direction: "gui_to_tauri",
    sessionId,
    backendSessionId,
    state: "sending",
    payload: content,
  });
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
    // Gate before any write: settling or erroring unconditionally here would
    // clear whichever turn is current, including a replacement started after
    // this send was abandoned by a Stop.
    if (completionIsStale()) return;
    if (result.status === "error") {
      recordLocalChatTrace({
        source: "gui",
        kind: "message.send.rejected",
        direction: "tauri_to_gui",
        sessionId,
        backendSessionId,
        state: "error",
        detail: commandErrorMessage(result.error),
      });
      if (isSessionNotFoundError(result.error)) {
        deps.setBackendSessionId?.(sessionId, null);
        deps.setBackendSessionIdRef?.(null);
      }
      deps.settleActiveTurn?.(sessionId);
      deps.setSessionLifecycle(
        sessionId,
        "error",
        commandErrorMessage(result.error)
      );
      return;
    }
    recordLocalChatTrace({
      source: "gui",
      kind: "message.send.accepted",
      direction: "tauri_to_gui",
      sessionId,
      backendSessionId,
      state: "streaming",
    });
    deps.markStreamingIfSending(sessionId);
  } catch (error) {
    if (completionIsStale()) return;
    recordLocalChatTrace({
      source: "gui",
      kind: "message.send.failed",
      direction: "internal",
      sessionId,
      backendSessionId,
      state: "error",
      detail: commandErrorMessage(error),
    });
    deps.settleActiveTurn?.(sessionId);
    deps.setSessionLifecycle(sessionId, "error", commandErrorMessage(error));
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
    setBackendSessionIdRef?: (backendId: string | null) => void;
    clearStreamingAssistant?: (id: string, commitToMessages?: boolean) => void;
    clearQueuedMessages?: (id: string) => void;
    markPendingUserQuestionsUnavailable?: (id: string) => void;
    settleActiveTurn?: (id: string, turnId?: string | null) => boolean;
    restoreActiveTurn?: (id: string, localId: string) => boolean;
  } & TurnOwnershipDeps,
  options: {
    expectedActiveTurnLocalId?: string;
    failureLifecycle?: LocalChatLifecycle;
  } = {}
): Promise<boolean> {
  const completionIsStale = makeStalenessCheck(
    deps,
    sessionId,
    backendSessionId,
    options.expectedActiveTurnLocalId
  );

  if (sessionId) {
    deps.setSessionLifecycle(sessionId, "closing");
  }

  try {
    const result = await commands.closeLocalChatSession(backendSessionId);
    if (result.status === "error") {
      if (isSessionNotFoundError(result.error)) {
        if (completionIsStale()) return true;
        if (sessionId) {
          deps.clearStreamingAssistant?.(sessionId, true);
          deps.markSessionClosed(sessionId);
          deps.setBackendSessionId(sessionId, null);
          deps.clearQueuedMessages?.(sessionId);
          deps.markPendingUserQuestionsUnavailable?.(sessionId);
          deps.settleActiveTurn?.(sessionId);
        }
        deps.setBackendSessionIdRef?.(null);
        return true;
      }
      throw new Error(commandErrorMessage(result.error));
    }
    if (sessionId) {
      if (completionIsStale()) return true;
      deps.clearStreamingAssistant?.(sessionId, true);
      deps.markSessionClosed(sessionId);
      deps.setBackendSessionId(sessionId, null);
      deps.clearQueuedMessages?.(sessionId);
      deps.markPendingUserQuestionsUnavailable?.(sessionId);
      deps.settleActiveTurn?.(sessionId);
    }
    deps.setBackendSessionIdRef?.(null);
    return true;
  } catch (error) {
    if (sessionId) {
      if (completionIsStale()) return false;
      const expectedLocalId = options.expectedActiveTurnLocalId;
      const currentLocalId = deps.getActiveTurnLocalId?.(sessionId) ?? null;
      if (expectedLocalId) {
        if (currentLocalId === expectedLocalId) {
          deps.restoreActiveTurn?.(sessionId, expectedLocalId);
          deps.setSessionLifecycle(
            sessionId,
            options.failureLifecycle ?? "streaming"
          );
        } else if (currentLocalId === null) {
          deps.setSessionLifecycle(sessionId, "idle");
        }
      } else {
        deps.setSessionLifecycle(
          sessionId,
          "error",
          commandErrorMessage(error)
        );
      }
    }
    return false;
  }
}

/**
 * Hook to manage a provider-neutral local chat session.
 *
 * Wraps the chatStore with local harness lifecycle:
 * - Creates/resumes local chat sessions
 * - Sends, queues, and closes local chat messages
 */
export function useLocalChat(sessionId: string | null) {
  const [isTitleRegenerating, setIsTitleRegenerating] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);
  const session = useChatStore((s) =>
    sessionId ? (s.sessions[sessionId] ?? null) : null
  );

  const addMessage = useChatStore((s) => s.addMessage);
  const setBackendSessionId = useChatStore((s) => s.setBackendSessionId);
  const setSessionTitleCandidate = useChatStore(
    (s) => s.setSessionTitleCandidate
  );
  const markSessionClosed = useChatStore((s) => s.markSessionClosed);
  const setSessionLifecycle = useChatStore((s) => s.setSessionLifecycle);
  const markStreamingIfSending = useChatStore((s) => s.markStreamingIfSending);
  const beginActiveTurn = useChatStore((s) => s.beginActiveTurn);
  const settleActiveTurn = useChatStore((s) => s.settleActiveTurn);
  const markActiveTurnStopping = useChatStore((s) => s.markActiveTurnStopping);
  const restoreActiveTurn = useChatStore((s) => s.restoreActiveTurn);
  const enqueueQueuedMessage = useChatStore((s) => s.enqueueQueuedMessage);
  const clearQueuedMessages = useChatStore((s) => s.clearQueuedMessages);
  const clearStreamingAssistant = useChatStore(
    (s) => s.clearStreamingAssistant
  );
  const markPendingUserQuestionsUnavailable = useChatStore(
    (s) => s.markPendingUserQuestionsUnavailable
  );

  const regenerateTitle = useCallback(async () => {
    if (
      !session ||
      !sessionId ||
      isTitleRegenerating ||
      session.providerMessagesHydrating
    ) {
      return;
    }
    setIsTitleRegenerating(true);
    setTitleError(null);
    const error = await doRegenerateSessionTitle(
      session,
      sessionId,
      setSessionTitleCandidate
    );
    if (error) setTitleError(error);
    setIsTitleRegenerating(false);
  }, [
    isTitleRegenerating,
    session,
    sessionId,
    setSessionTitleCandidate,
  ]);

  /**
   * Start the local chat session.
   */
  const startSession = useCallback(
    async (userMessage?: string) => {
      if (!session || !sessionId) return;
      const initialPrompt = userMessage?.trim();
      if (!initialPrompt) return;
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
          addMessage,
          setSessionTitleCandidate,
          setSessionLifecycle,
          beginActiveTurn,
          settleActiveTurn,
          getActiveTurnLocalId: currentActiveTurnLocalId,
          getBackendSessionId: currentBackendSessionId,
        },
        initialPrompt
      );
    },
    [
      session,
      sessionId,
      addMessage,
      setBackendSessionId,
      setSessionLifecycle,
      setSessionTitleCandidate,
      beginActiveTurn,
      settleActiveTurn,
    ]
  );

  /**
   * Send a message to the active local chat session.
   */
  const sendMessage = useCallback(
    async (content: string) => {
      if (!sessionId) return;
      if (!session?.backendSessionId) {
        recordLocalChatTrace({
          source: "gui",
          kind: "message.dropped.no_backend_session",
          direction: "internal",
          sessionId,
          state: session?.lifecycle ?? "unknown",
          payload: content,
        });
        return;
      }
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
        enqueueQueuedMessage(sessionId, content);
        recordLocalChatTrace({
          source: "gui",
          kind: "message.queued",
          direction: "internal",
          sessionId,
          backendSessionId: session.backendSessionId,
          state: lifecycle,
          payload: content,
        });
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
        markStreamingIfSending,
        beginActiveTurn,
        settleActiveTurn,
        setBackendSessionId,
        getActiveTurnLocalId: currentActiveTurnLocalId,
        getBackendSessionId: currentBackendSessionId,
      });
    },
    [
      session,
      sessionId,
      addMessage,
      setSessionLifecycle,
      markStreamingIfSending,
      setBackendSessionId,
      setSessionTitleCandidate,
      enqueueQueuedMessage,
      beginActiveTurn,
      settleActiveTurn,
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
        clearStreamingAssistant,
        clearQueuedMessages,
        markPendingUserQuestionsUnavailable,
        settleActiveTurn,
      });
    },
    [
      session?.backendSessionId,
      sessionId,
      markSessionClosed,
      setSessionLifecycle,
      setBackendSessionId,
      clearStreamingAssistant,
      clearQueuedMessages,
      markPendingUserQuestionsUnavailable,
      settleActiveTurn,
    ]
  );

  const stopActiveTurn = useCallback(async () => {
    if (!session?.backendSessionId || !sessionId) return false;
    const activeTurn = session.activeTurn;
    if (!activeTurn) return false;
    // Restore whatever the turn was actually doing, not an assumed "streaming":
    // a stop during start-up must not report a stream that never began.
    const failureLifecycle: LocalChatLifecycle =
      session.lifecycle === "sending" ||
      session.lifecycle === "starting" ||
      session.lifecycle === "resuming"
        ? session.lifecycle
        : "streaming";
    if (!markActiveTurnStopping(sessionId)) return false;
    return doCloseSession(
      session.backendSessionId,
      sessionId,
      {
        markSessionClosed: (id) => setSessionLifecycle(id, "idle"),
        setSessionLifecycle,
        setBackendSessionId,
        clearStreamingAssistant,
        clearQueuedMessages,
        markPendingUserQuestionsUnavailable,
        settleActiveTurn,
        getActiveTurnLocalId: currentActiveTurnLocalId,
        getBackendSessionId: currentBackendSessionId,
        restoreActiveTurn,
      },
      {
        expectedActiveTurnLocalId: activeTurn.localId,
        failureLifecycle,
      }
    );
  }, [
    session?.backendSessionId,
    session?.activeTurn,
    session?.lifecycle,
    sessionId,
    markActiveTurnStopping,
    restoreActiveTurn,
    setSessionLifecycle,
    setBackendSessionId,
    clearStreamingAssistant,
    clearQueuedMessages,
    markPendingUserQuestionsUnavailable,
    settleActiveTurn,
  ]);

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
    stopActiveTurn,
    regenerateTitle,
    isTitleRegenerating,
    titleError,
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

import { create } from "zustand";
import {
  clearLastUsedLocalChatModelId,
  compareLocalChatSessionRecency,
  DEFAULT_LOCAL_CHAT_HARNESS,
  findPersistedLocalChatSession,
  findLatestResumableLocalChatSession,
  isDisposableClosedLocalChatSession,
  listPersistedLocalChatSessions,
  loadPersistedLocalChatSession,
  markLocalChatSessionCleared,
  persistLastUsedLocalChatModelId,
  persistLocalChatSession,
  projectPathMatches,
  hydrateLocalChatSessionIndex,
  summarizeLocalChatSession,
} from "../utils/localChatPersistence";
import {
  parseSessionLogs,
  type ConversationEvent,
  type FileUpdateChange,
} from "../types/conversation";
import type { LocalChatSessionSummary } from "../utils/localChatPersistence";
import type {
  JsonValue,
  LocalChatHarnessKind,
  PermissionMode,
  UserQuestion,
} from "../bindings";
import { commands } from "../bindings";
import { useLocalChatDefaultsStore } from "../utils/localChatDefaults";
import { recordLocalChatTrace } from "../utils/localChatDebug";

/**
 * Message types for the Claude chat
 */
export type ChatMessage =
  | { kind: "user"; text: string; timestamp: string }
  | {
      kind: "assistant";
      text: string;
      timestamp: string;
      isPartial?: boolean;
      parentToolUseId?: string;
    }
  | {
      kind: "tool_call";
      toolName: string;
      toolId: string;
      input: string;
      timestamp: string;
      /**
       * `tool_use` id of the spawning Task/Agent tool call when this call was
       * made by a sub-agent; absent for main-thread calls. Local chat keeps
       * those child-thread work events out of the parent transcript.
       */
      parentToolUseId?: string;
    }
  | {
      kind: "tool_result";
      toolId: string;
      result: string;
      isError: boolean;
      timestamp: string;
      /** Parent spawn `tool_use` id when this result belongs to a sub-agent. */
      parentToolUseId?: string;
    }
  | {
      kind: "file_edit";
      toolId: string;
      status: string;
      changes: FileUpdateChange[];
      timestamp: string;
      /** Parent spawn `tool_use` id when this edit belongs to a sub-agent. */
      parentToolUseId?: string;
    }
  | {
      kind: "permission_request";
      requestId?: string;
      toolName: string;
      message: string;
      input?: string;
      timestamp: string;
    }
  | {
      kind: "user_question";
      requestId: string;
      toolUseId: string;
      questions: UserQuestion[];
      originalQuestions: JsonValue;
      inputError?: string;
      status: "pending" | "resolved" | "unavailable";
      timestamp: string;
    }
  | { kind: "session_start"; model: string; timestamp: string }
  | { kind: "warning"; message: string; timestamp: string }
  /** Harness-originated notice (e.g. a background subagent finished). */
  | { kind: "task_notification"; message: string; timestamp: string }
  | {
      kind: "session_end";
      durationMs: number;
      costUsd: number;
      numTurns: number;
      timestamp: string;
    }
  | { kind: "error"; message: string; timestamp: string };

function stringArrayValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return typeof value === "string" ? [value] : [];
}

function toolCallReferencesThread(
  message: Extract<ChatMessage, { kind: "tool_call" }>,
  threadId: string
): boolean {
  const input = parseJsonObjectInput(message.input);
  if (!input) return false;
  const directThreadIds = [
    ...stringArrayValue(input.receiver_thread_ids),
    ...stringArrayValue(input.receiverThreadIds),
    ...stringArrayValue(input.thread_id),
    ...stringArrayValue(input.threadId),
    ...stringArrayValue(input.agent_path),
    ...stringArrayValue(input.agentPath),
  ];
  if (directThreadIds.includes(threadId)) return true;

  const receiverAgents =
    Array.isArray(input.receiver_agents) || Array.isArray(input.receiverAgents)
      ? (input.receiver_agents ?? input.receiverAgents)
      : [];
  return Array.isArray(receiverAgents)
    ? receiverAgents.some((agent) => {
        if (!agent || typeof agent !== "object") return false;
        const record = agent as Record<string, unknown>;
        return [
          ...stringArrayValue(record.thread_id),
          ...stringArrayValue(record.threadId),
          ...stringArrayValue(record.agent_path),
          ...stringArrayValue(record.agentPath),
        ].includes(threadId);
      })
    : false;
}

function isAgentSpawnToolName(toolName: string): boolean {
  return ["agent", "task"].includes(toolName.trim().toLowerCase());
}

function isSelfProviderAgentToolCall(
  message: ChatMessage,
  providerResumeId: string | null | undefined
): boolean {
  return (
    !!providerResumeId &&
    message.kind === "tool_call" &&
    !message.parentToolUseId &&
    isAgentSpawnToolName(message.toolName) &&
    toolCallReferencesThread(message, providerResumeId)
  );
}

function sanitizeSessionMessages(
  messages: ChatMessage[],
  providerResumeId: string | null | undefined
): ChatMessage[] {
  const askUserQuestionToolIds = new Set(
    messages
      .filter(
        (message): message is Extract<ChatMessage, { kind: "tool_call" }> =>
          message.kind === "tool_call" && message.toolName === "AskUserQuestion"
      )
      .map((message) => message.toolId)
  );
  const selfAgentToolIds = new Set<string>();
  const filtered = messages.filter((message) => {
    if (
      (message.kind === "tool_call" || message.kind === "tool_result") &&
      askUserQuestionToolIds.has(message.toolId)
    ) {
      return false;
    }
    if (
      providerResumeId &&
      message.kind === "tool_call" &&
      isSelfProviderAgentToolCall(message, providerResumeId)
    ) {
      selfAgentToolIds.add(message.toolId);
      return false;
    }
    if (
      (message.kind === "tool_result" ||
        message.kind === "assistant" ||
        message.kind === "tool_call") &&
      message.parentToolUseId &&
      selfAgentToolIds.has(message.parentToolUseId)
    ) {
      return false;
    }
    if (
      message.kind === "tool_result" &&
      selfAgentToolIds.has(message.toolId)
    ) {
      return false;
    }
    return true;
  });
  return filtered.length === messages.length ? messages : filtered;
}

function parseJsonObjectInput(input: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(input) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Keep non-JSON tool inputs unchanged.
  }
  return null;
}

function mergeToolCallInput(previous: string, next: string): string {
  const previousObject = parseJsonObjectInput(previous);
  const nextObject = parseJsonObjectInput(next);
  if (!previousObject || !nextObject) return next;
  const merged: Record<string, unknown> = { ...previousObject };
  for (const [key, value] of Object.entries(nextObject)) {
    if (value === null || value === "") continue;
    merged[key] = value;
  }
  return JSON.stringify(merged);
}

type AssistantChatMessage = Extract<ChatMessage, { kind: "assistant" }>;

function sameParentToolUseId(
  message: AssistantChatMessage,
  parentToolUseId: string | undefined
): boolean {
  return (message.parentToolUseId ?? undefined) === parentToolUseId;
}

function lastCompleteAssistantHasText(
  messages: readonly ChatMessage[],
  text: string,
  parentToolUseId?: string
): boolean {
  const last = messages[messages.length - 1];
  return (
    last?.kind === "assistant" &&
    last.isPartial !== true &&
    last.text === text &&
    (last.parentToolUseId ?? undefined) === parentToolUseId
  );
}

function mergeAssistantPartialText(current: string, next: string): string {
  if (!current) return next;
  if (!next) return current;
  if (next.startsWith(current)) return next;
  return `${current}${next}`;
}

function coalesceParentAssistantMessage(
  messages: ChatMessage[],
  message: AssistantChatMessage
): ChatMessage[] {
  const parentToolUseId = message.parentToolUseId;
  const last = messages[messages.length - 1];
  if (
    message.isPartial &&
    last?.kind === "assistant" &&
    last.isPartial &&
    sameParentToolUseId(last, parentToolUseId)
  ) {
    messages[messages.length - 1] = {
      ...last,
      text: mergeAssistantPartialText(last.text, message.text),
      timestamp: message.timestamp,
    };
    return messages;
  }

  if (message.isPartial) {
    messages.push(message);
    return messages;
  }

  if (lastCompleteAssistantHasText(messages, message.text, parentToolUseId)) {
    return messages;
  }

  const partialIndexes = messages
    .map((candidate, index) => ({ candidate, index }))
    .filter(
      ({ candidate }) =>
        candidate.kind === "assistant" &&
        candidate.isPartial &&
        sameParentToolUseId(candidate, parentToolUseId)
    );
  const streamedText = partialIndexes
    .map(({ candidate }) =>
      candidate.kind === "assistant" ? candidate.text : ""
    )
    .join("");
  if (partialIndexes.length > 0 && streamedText === message.text) {
    const partialIndexSet = new Set(partialIndexes.map(({ index }) => index));
    return [
      ...messages.filter((_, index) => !partialIndexSet.has(index)),
      { ...message, isPartial: false },
    ];
  }

  const lastPartial = partialIndexes[partialIndexes.length - 1];
  const lastPartialIndex = lastPartial?.index;
  if (lastPartialIndex !== undefined) {
    const lastPartial = messages[lastPartialIndex];
    if (lastPartial.kind === "assistant" && lastPartial.text === message.text) {
      messages[lastPartialIndex] = { ...message, isPartial: false };
      return messages;
    }
  }

  messages.push({ ...message, isPartial: false });
  return messages;
}

export type LocalChatLifecycle =
  | "idle"
  | "starting"
  | "resuming"
  | "sending"
  | "streaming"
  | "closing"
  | "closed"
  | "error";

export type ActiveChatTurnPhase = "starting" | "active" | "stopping";

export interface ActiveChatTurn {
  /** Client identity available before the provider acknowledges the turn. */
  localId: string;
  /** Provider-neutral root turn identity supplied by harness events. */
  turnId: string | null;
  phase: ActiveChatTurnPhase;
}

export interface ChatCompactionSummary {
  trigger: string | null;
  preTokens: number | null;
}

export type ChatTitleStatus =
  | "pending"
  | "low_confidence"
  | "generated"
  | "manual";

export interface ChatTitleCandidate {
  title: string | null;
  confidence: number;
  sufficientSignal: boolean;
  userMessageCount: number;
}

export interface TitleCandidateOptions {
  /** Explicit regeneration may replace a prior generated title. */
  replaceGenerated?: boolean;
  /** Reject a result produced from an older session revision. */
  expectedUpdatedAt?: string;
  /** Reject a result produced before replay or new messages completed. */
  expectedMessageCount?: number;
}

export interface StreamingAssistantMessage {
  text: string;
  timestamp: string;
}

export interface ChatSession {
  /** Unique session identifier */
  id: string;
  /** Human-readable label for the session tab */
  label: string;
  /** Inferred concise display title for history and tab surfaces */
  title?: string | null;
  /** Title inference lifecycle; generated/manual titles are frozen */
  titleStatus?: ChatTitleStatus;
  /** Model-reported confidence for the latest title inference attempt */
  titleConfidence?: number | null;
  /** Number of early user messages used by the latest title inference attempt */
  titleUserMessageCount?: number;
  /** Chat messages in this session */
  messages: ChatMessage[];
  /** Session status */
  status: "open" | "closed";
  /** Local chat harness that owns the runtime session. */
  harness: LocalChatHarnessKind;
  /** Runtime backend session ID for the active local harness process. */
  backendSessionId: string | null;
  /** Provider-specific durable resume ID for this conversation. */
  providerResumeId: string | null;
  /** Project root captured when the local chat session was opened. */
  projectPath?: string | null;
  /** User-selected provider model alias for session startup overrides. */
  selectedModelId?: string | null;
  /** User-selected provider reasoning effort for session startup overrides. */
  selectedReasoningEffort?: string | null;
  /** User-selected Claude Code permission mode for local session startup. */
  permissionMode?: PermissionMode | null;
  /** Model name reported by the Claude CLI (from init or per-turn usage) */
  model?: string;
  /** Latest per-turn current request input-context utilization for the badge */
  tokenUsage?: { used: number; max: number };
  /** Cumulative token total reported for the provider thread. */
  threadTotalTokens?: number;
  /** Runtime-only local chat lifecycle state */
  lifecycle?: LocalChatLifecycle;
  /** Runtime-only error detail for the current lifecycle state */
  lifecycleError?: string | null;
  /** Runtime-only state for the current root turn, separate from the backend. */
  activeTurn?: ActiveChatTurn | null;
  /** Runtime-only indeterminate provider compaction state. */
  compactionActive?: boolean;
  /** Runtime-only metadata from the most recent completed compaction. */
  compactionSummary?: ChatCompactionSummary | null;
  /** Ephemeral assistant text currently streaming; not durable transcript state */
  streamingAssistant?: StreamingAssistantMessage | null;
  /** Runtime-only user messages queued while a local turn is still active */
  queuedMessages?: string[];
  /** Runtime-only guard while a persisted provider transcript is replayed. */
  providerMessagesHydrating?: boolean;
  /** Durable local metadata for session-history ordering */
  createdAt?: string;
  /** Durable local metadata for session-history ordering */
  updatedAt?: string;
  /** Durable local message count without persisting transcript text */
  messageCount?: number;
}

export interface ChatPane {
  /** Stable pane identifier for maximized split-chat layout */
  id: string;
  /** Store session rendered in this pane */
  sessionId: string;
}

export interface ChatPaneLayout {
  /** Visible chat panes in the maximized chat view */
  panes: ChatPane[];
  /** Pane receiving sidebar selections and pane-level controls */
  activePaneId: string | null;
}

interface ChatStoreState {
  /** All open chat sessions, keyed by session ID */
  sessions: Record<string, ChatSession>;
  /** Currently focused session ID */
  activeSessionId: string | null;
  /** Pane-to-session bindings for maximized split chat */
  paneLayout: ChatPaneLayout;
  /** Whether the chat panel is visible */
  panelOpen: boolean;
  /** Persisted metadata index used by history surfaces. */
  localSessionSummaries: Record<string, LocalChatSessionSummary>;
}

interface ChatStoreActions {
  /** Open or reuse a local chat session */
  openSession: (label: string, projectPath?: string | null) => string;
  /** Close a chat session */
  closeSession: (sessionId: string) => void;
  /** Focus a chat session tab */
  focusSession: (sessionId: string) => void;
  /** Focus a maximized chat pane */
  focusPane: (paneId: string) => void;
  /** Bind a pane to a session, focusing an existing pane if already visible */
  bindPaneToSession: (paneId: string, sessionId: string) => boolean;
  /** Create a fresh local chat in a new split pane */
  startFreshSessionInNewPane: (
    label: string,
    projectPath?: string | null
  ) => string;
  /** Close a split pane without closing its underlying chat session */
  closePane: (paneId: string) => void;
  /** Collapse split panes back to a single visible pane */
  unsplitPanes: (paneId?: string) => void;
  /** List persisted local chat sessions, newest first */
  listLocalSessions: (projectPath?: string | null) => LocalChatSessionSummary[];
  /** Find the newest persisted session with durable content in a project. */
  findLatestResumableSession: (
    projectPath?: string | null
  ) => Promise<LocalChatSessionSummary | null>;
  /** Hydrate local chat metadata from the app-managed index file. */
  hydrateLocalSessionIndex: () => Promise<void>;
  /** Hydrate and focus a persisted local chat session */
  selectPersistedSession: (sessionId: string) => Promise<boolean>;
  /** Hydrate and focus a provider child thread as its own local chat session */
  selectProviderThreadSession: (input: {
    harness: LocalChatHarnessKind;
    providerResumeId: string;
    projectPath?: string | null;
    label?: string | null;
    title?: string | null;
    model?: string | null;
  }) => Promise<string | null>;
  /** Start a new local chat without reusing an existing session */
  startFreshSession: (label: string, projectPath?: string | null) => string;
  /** Delete one local persisted session and any in-memory copy */
  deleteLocalSession: (sessionId: string) => void;
  /** Add a message to a session */
  addMessage: (sessionId: string, message: ChatMessage) => void;
  /** Mark a structured user question as answered. */
  resolveUserQuestion: (sessionId: string, requestId: string) => void;
  /** Mark one question unavailable when its permission connection is gone. */
  markUserQuestionUnavailable: (sessionId: string, requestId: string) => void;
  /** Disable unresolved question cards after their backend session exits. */
  markPendingUserQuestionsUnavailable: (sessionId: string) => void;
  /** Update the last assistant message (for streaming) */
  updateLastAssistantMessage: (sessionId: string, text: string) => void;
  /** Finalize the last partial assistant message */
  finalizeLastAssistantMessage: (sessionId: string, text: string) => void;
  /** Set explicit local lifecycle state */
  setSessionLifecycle: (
    sessionId: string,
    lifecycle: LocalChatLifecycle,
    errorMessage?: string | null
  ) => void;
  /** Begin a locally accepted root turn before provider acknowledgement. */
  beginActiveTurn: (sessionId: string) => string | null;
  /**
   * Bind the current root turn to its provider-neutral harness identity,
   * re-pointing a stale binding whose terminal event never arrived.
   */
  bindActiveTurn: (sessionId: string, turnId: string) => boolean;
  /** Move the current root turn into stopping exactly once. */
  markActiveTurnStopping: (sessionId: string) => boolean;
  /** Set or clear the ephemeral provider compaction indicator. */
  setSessionCompaction: (sessionId: string, active: boolean) => void;
  /** Retain or clear the latest compaction completion metadata. */
  setCompactionSummary: (
    sessionId: string,
    summary: ChatCompactionSummary | null
  ) => void;
  /** Restore a failed stop request for the same local turn. */
  restoreActiveTurn: (sessionId: string, localId: string) => boolean;
  /** Settle only the current root turn with the matching harness identity. */
  settleActiveTurn: (sessionId: string, turnId?: string | null) => boolean;
  /** Upgrade a command-send lifecycle only if it is still awaiting first output */
  markStreamingIfSending: (sessionId: string) => void;
  /** Clear any ephemeral assistant stream overlay */
  clearStreamingAssistant: (
    sessionId: string,
    commitToMessages?: boolean
  ) => void;
  /** Queue a user message until the active local turn reaches idle */
  enqueueQueuedMessage: (sessionId: string, content: string) => void;
  /** Shift the next queued user message for a local session */
  shiftQueuedMessage: (sessionId: string) => string | null;
  /** Clear queued user messages for a local session */
  clearQueuedMessages: (sessionId: string) => void;
  /** Set the runtime backend session ID */
  setBackendSessionId: (
    sessionId: string,
    backendSessionId: string | null
  ) => void;
  /** Set the provider-specific durable resume ID */
  setProviderResumeId: (
    sessionId: string,
    providerResumeId: string | null
  ) => void;
  /** Set the inferred display title for a local chat session */
  setSessionTitle: (sessionId: string, title: string | null) => void;
  /** Set a user-authored display title and protect it from inference. */
  setSessionManualTitle: (
    sessionId: string,
    title: string
  ) => Promise<boolean>;
  /** Apply a generated title candidate when it is confident enough */
  setSessionTitleCandidate: (
    sessionId: string,
    candidate: ChatTitleCandidate,
    options?: TitleCandidateOptions
  ) => void;
  /** Set the model reported by the Claude CLI for a session */
  setSessionModel: (sessionId: string, model: string) => void;
  /** Set the local chat harness for this session before it starts */
  setSessionHarness: (sessionId: string, harness: LocalChatHarnessKind) => void;
  /** Set the user-selected provider model for this session */
  setSessionSelectedModel: (sessionId: string, modelId: string | null) => void;
  /** Set the user-selected provider reasoning effort for this session */
  setSessionReasoningEffort: (
    sessionId: string,
    reasoningEffort: string | null
  ) => void;
  /** Set the user-selected Claude Code permission mode for this session */
  setSessionPermissionMode: (
    sessionId: string,
    permissionMode: PermissionMode | null
  ) => void;
  /** Set the latest per-turn current request input-context utilization */
  setSessionTokenUsage: (
    sessionId: string,
    usage: { used: number; max: number }
  ) => void;
  /** Update model and token usage together in a single render */
  setSessionUsage: (
    sessionId: string,
    model: string,
    usage: { used: number; max: number },
    threadTotalTokens?: number
  ) => void;
  /** Mark a session as closed */
  markSessionClosed: (sessionId: string) => void;
  /** Clear messages in a session */
  clearMessages: (sessionId: string) => void;
  /** Toggle the chat panel open/closed */
  togglePanel: () => void;
  /** Set panel open state explicitly */
  setPanelOpen: (open: boolean) => void;
  /** Reset local chat sessions */
  reset: () => void;
}

export type ChatStore = ChatStoreState & ChatStoreActions;

export const MAX_CHAT_PANES = 6;

const emptyPaneLayout: ChatPaneLayout = {
  panes: [],
  activePaneId: null,
};

const emptyState: ChatStoreState = {
  sessions: {},
  activeSessionId: null,
  paneLayout: emptyPaneLayout,
  panelOpen: false,
  localSessionSummaries: {},
};

const GENERATED_TITLE_CONFIDENCE_THRESHOLD = 0.72;

const initialState: ChatStoreState = {
  ...emptyState,
};

function generateSessionId(): string {
  return `chat-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

function generatePaneId(): string {
  return `pane-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

let activeTurnGeneration = 0;

function generateActiveTurnId(): string {
  activeTurnGeneration += 1;
  return `local-turn-${Date.now()}-${activeTurnGeneration}`;
}

function createLocalSession(
  label: string,
  projectPath?: string | null
): ChatSession {
  const now = new Date().toISOString();
  return {
    id: generateSessionId(),
    label,
    title: null,
    titleStatus: "pending",
    titleConfidence: null,
    titleUserMessageCount: 0,
    messages: [],
    status: "open",
    harness:
      useLocalChatDefaultsStore.getState().defaultHarness ??
      DEFAULT_LOCAL_CHAT_HARNESS,
    backendSessionId: null,
    providerResumeId: null,
    projectPath,
    permissionMode: "default",
    lifecycle: "idle",
    lifecycleError: null,
    activeTurn: null,
    streamingAssistant: null,
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
  };
}

function providerThreadSessionId(
  harness: LocalChatHarnessKind,
  providerResumeId: string
): string {
  const safeResumeId =
    providerResumeId
      .trim()
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "thread";
  return `local-chat-${harness}-${safeResumeId}`;
}

function createProviderThreadSession(input: {
  harness: LocalChatHarnessKind;
  providerResumeId: string;
  projectPath?: string | null;
  label?: string | null;
  title?: string | null;
  model?: string | null;
}): ChatSession {
  const label = input.label?.trim() || "Agent";
  const title = input.title?.trim() || label;
  return {
    ...createLocalSession(label, input.projectPath ?? null),
    id: providerThreadSessionId(input.harness, input.providerResumeId),
    title,
    titleStatus: "manual",
    titleConfidence: 1,
    harness: input.harness,
    providerResumeId: input.providerResumeId,
    model: input.model?.trim() || undefined,
  };
}

const CODEX_PERMISSION_MODES = new Set<PermissionMode>([
  "default",
  "auto",
  "bypass_permissions",
]);

function hydrateLocalSession(session: ChatSession): ChatSession {
  const title = session.title?.trim() ? session.title : null;
  const messages = sanitizeSessionMessages(
    session.messages,
    session.providerResumeId
  );
  const harness = session.harness ?? DEFAULT_LOCAL_CHAT_HARNESS;
  const permissionMode =
    harness === "codex" &&
    !CODEX_PERMISSION_MODES.has(session.permissionMode ?? "default")
      ? "default"
      : (session.permissionMode ?? "default");
  return {
    ...session,
    messages,
    title,
    titleStatus: session.titleStatus ?? (title ? "generated" : "pending"),
    titleConfidence: session.titleConfidence ?? (title ? 1 : null),
    titleUserMessageCount: session.titleUserMessageCount ?? 0,
    harness,
    permissionMode,
    backendSessionId: null,
    lifecycle: session.lifecycle ?? "idle",
    lifecycleError: null,
    activeTurn: null,
    streamingAssistant: null,
    messageCount: session.messageCount ?? messages.length,
  };
}

function conversationEventToChatMessage(
  event: ConversationEvent
): ChatMessage | null {
  switch (event.kind) {
    case "user_message":
      return { kind: "user", text: event.text, timestamp: event.timestamp };
    case "assistant_message":
      return {
        kind: "assistant",
        text: event.text,
        timestamp: event.timestamp,
        ...(event.parentToolUseId
          ? { parentToolUseId: event.parentToolUseId }
          : {}),
      };
    case "tool_call":
      return {
        kind: "tool_call",
        toolName: event.toolName,
        toolId: event.toolId,
        input: JSON.stringify(event.input ?? {}),
        timestamp: event.timestamp,
        ...(event.parentToolUseId
          ? { parentToolUseId: event.parentToolUseId }
          : {}),
      };
    case "tool_result":
      return {
        kind: "tool_result",
        toolId: event.toolUseId,
        result: event.result,
        isError: event.isError,
        timestamp: event.timestamp,
        ...(event.parentToolUseId
          ? { parentToolUseId: event.parentToolUseId }
          : {}),
      };
    case "file_edit":
      return {
        kind: "file_edit",
        toolId: event.toolId,
        status: event.status,
        changes: event.changes,
        timestamp: event.timestamp,
        ...(event.parentToolUseId
          ? { parentToolUseId: event.parentToolUseId }
          : {}),
      };
    case "session_start":
      return {
        kind: "session_start",
        model: event.model,
        timestamp: event.timestamp,
      };
    case "session_end":
      return {
        kind: "session_end",
        durationMs: event.durationMs,
        costUsd: event.costUsd,
        numTurns: event.numTurns,
        timestamp: event.timestamp,
      };
    case "task_notification":
      return {
        kind: "task_notification",
        message: event.message,
        timestamp: event.timestamp,
      };
    case "thinking":
      return event.text.startsWith("[error]")
        ? {
            kind: "error",
            message: event.text.replace(/^\[error\]\s*/, ""),
            timestamp: event.timestamp,
          }
        : null;
    default:
      return null;
  }
}

function replayLinesToChatMessages(
  lines: string[],
  session: ChatSession
): ChatMessage[] {
  const logs = lines.map((content, index) => {
    let createdAt = session.createdAt ?? "";
    try {
      const raw = JSON.parse(content) as { timestamp?: unknown };
      if (typeof raw.timestamp === "string") createdAt = raw.timestamp;
    } catch {
      // The backend already validated event JSON; retain the session fallback.
    }
    return {
      id: `local-replay-${session.id}-${index}`,
      step_execution_id: session.id,
      content,
      format: "harness",
      created_at: createdAt,
    };
  });
  return sanitizeSessionMessages(
    parseSessionLogs(logs)
      .map(conversationEventToChatMessage)
      .filter((message): message is ChatMessage => message !== null),
    session.providerResumeId
  );
}

function chatMessageKey(message: ChatMessage): string {
  switch (message.kind) {
    case "user":
      return `${message.kind}:${message.text}`;
    case "assistant":
      return `${message.kind}:${message.text}:${message.parentToolUseId ?? ""}`;
    case "tool_call":
    case "tool_result":
      return `${message.kind}:${message.toolId}`;
    case "file_edit":
      return `${message.kind}:${message.toolId}`;
    case "permission_request":
      return `${message.kind}:${message.requestId ?? ""}:${message.toolName}:${message.message}`;
    case "user_question":
      return `${message.kind}:${message.requestId}:${message.toolUseId}`;
    case "session_start":
      return `${message.kind}:${message.model}`;
    case "session_end":
      return `${message.kind}:${message.durationMs}:${message.numTurns}`;
    case "warning":
    case "error":
    case "task_notification":
      return `${message.kind}:${message.message}`;
  }
}

function mergeHydratedMessages(
  hydrated: ChatMessage[],
  current: ChatMessage[]
): ChatMessage[] {
  if (current.length === 0) return hydrated;
  const currentKeys = new Set(current.map(chatMessageKey));
  const hydratedByKey = new Map(
    hydrated.map((message) => [chatMessageKey(message), message])
  );
  let enriched = false;
  const mergedCurrent = current.map((currentMessage) => {
    const hydratedMessage = hydratedByKey.get(chatMessageKey(currentMessage));
    if (
      currentMessage.kind !== "file_edit" ||
      hydratedMessage?.kind !== "file_edit"
    ) {
      return currentMessage;
    }
    const changes =
      hydratedMessage.changes.length > 0
        ? hydratedMessage.changes
        : currentMessage.changes;
    if (
      hydratedMessage.status !== currentMessage.status ||
      JSON.stringify(changes) !== JSON.stringify(currentMessage.changes)
    ) {
      enriched = true;
      return { ...currentMessage, status: hydratedMessage.status, changes };
    }
    return currentMessage;
  });
  const missing = hydrated.filter(
    (message) => !currentKeys.has(chatMessageKey(message))
  );
  if (missing.length > 0) return [...missing, ...mergedCurrent];
  return enriched ? mergedCurrent : current;
}

function localSessionSummaryFor(
  session: ChatSession
): LocalChatSessionSummary | null {
  if (
    session.status !== "open" ||
    isDisposableClosedLocalChatSession(session)
  ) {
    return null;
  }
  return summarizeLocalChatSession(session);
}

function localSessionSummariesFromSessions(
  sessions: Record<string, ChatSession>
): Record<string, LocalChatSessionSummary> {
  return Object.fromEntries(
    Object.values(sessions)
      .map((session) => [session.id, localSessionSummaryFor(session)] as const)
      .filter(
        (entry): entry is [string, LocalChatSessionSummary] => entry[1] !== null
      )
  );
}

function hasStableLocalChatTitle(
  session: Pick<LocalChatSessionSummary, "title" | "titleStatus">
): boolean {
  return (
    !!session.title?.trim() &&
    (session.titleStatus === "generated" || session.titleStatus === "manual")
  );
}

function upsertLocalSessionSummary(
  summaries: Record<string, LocalChatSessionSummary>,
  session: ChatSession
): Record<string, LocalChatSessionSummary> {
  const summary = localSessionSummaryFor(session);
  if (!summary) {
    return omitLocalSessionSummary(summaries, session.id);
  }
  const existing = summaries[session.id];
  if (
    existing &&
    hasStableLocalChatTitle(existing) &&
    existing.title === summary.title
  ) {
    return summaries;
  }
  return {
    ...summaries,
    [session.id]: summary,
  };
}

function omitLocalSessionSummary(
  summaries: Record<string, LocalChatSessionSummary>,
  sessionId: string
): Record<string, LocalChatSessionSummary> {
  const next = { ...summaries };
  delete next[sessionId];
  return next;
}

export function getLocalChatLifecycle(
  session: ChatSession | null | undefined
): LocalChatLifecycle {
  if (!session) return "idle";
  if (session.lifecycle) return session.lifecycle;
  return "idle";
}

export function isLocalChatLifecycleBusy(
  lifecycle: LocalChatLifecycle
): boolean {
  return (
    lifecycle === "starting" ||
    lifecycle === "resuming" ||
    lifecycle === "sending" ||
    lifecycle === "streaming" ||
    lifecycle === "closing"
  );
}

export function buildBackendSessionIdIndex(
  sessions: Record<string, ChatSession>
): Record<string, string> {
  const index: Record<string, string> = {};
  for (const session of Object.values(sessions)) {
    if (session.backendSessionId) {
      index[session.backendSessionId] = session.id;
    }
  }
  return index;
}

export function findSessionIdByBackendSessionId(
  sessions: Record<string, ChatSession>,
  backendSessionId: string | null | undefined
): string | null {
  if (!backendSessionId) return null;
  return buildBackendSessionIdIndex(sessions)[backendSessionId] ?? null;
}

function findMatchingSession(
  sessions: Record<string, ChatSession>,
  projectPath?: string | null
): string | null {
  return (
    Object.values(sessions)
      .filter(
        (session) =>
          session.status === "open" &&
          projectPathMatches(session.projectPath, projectPath)
      )
      .sort(compareLocalChatSessionRecency)[0]?.id ?? null
  );
}

function latestSessionId(sessions: Record<string, ChatSession>): string | null {
  return (
    Object.values(sessions)
      .filter((session) => session.status === "open")
      .sort(compareLocalChatSessionRecency)[0]?.id ?? null
  );
}

function activeSessionIdFromPaneLayout(
  paneLayout: ChatPaneLayout
): string | null {
  return (
    paneLayout.panes.find((pane) => pane.id === paneLayout.activePaneId)
      ?.sessionId ??
    paneLayout.panes[0]?.sessionId ??
    null
  );
}

export function normalizePaneLayout(
  paneLayout: ChatPaneLayout | undefined,
  sessions: Record<string, ChatSession>
): ChatPaneLayout {
  const seenSessionIds = new Set<string>();
  const panes = (paneLayout?.panes ?? []).filter((pane) => {
    const session = sessions[pane.sessionId];
    if (!session || session.status !== "open") {
      return false;
    }
    if (seenSessionIds.has(pane.sessionId)) return false;
    seenSessionIds.add(pane.sessionId);
    return true;
  });
  const activePaneId =
    paneLayout?.activePaneId &&
    panes.some((pane) => pane.id === paneLayout.activePaneId)
      ? paneLayout.activePaneId
      : (panes[0]?.id ?? null);

  return { panes, activePaneId };
}

function focusSessionInPaneLayout(
  state: Pick<ChatStoreState, "sessions" | "activeSessionId" | "paneLayout">,
  sessionId: string
): Pick<ChatStoreState, "activeSessionId" | "paneLayout"> {
  const session = state.sessions[sessionId];
  if (!session || session.status !== "open") {
    return {
      activeSessionId: state.activeSessionId,
      paneLayout: normalizePaneLayout(state.paneLayout, state.sessions),
    };
  }

  const paneLayout = normalizePaneLayout(state.paneLayout, state.sessions);
  const existingPane = paneLayout.panes.find(
    (pane) => pane.sessionId === sessionId
  );
  if (existingPane) {
    return {
      activeSessionId: sessionId,
      paneLayout: {
        panes: paneLayout.panes,
        activePaneId: existingPane.id,
      },
    };
  }

  const activePaneId = paneLayout.activePaneId ?? paneLayout.panes[0]?.id;
  if (activePaneId) {
    return {
      activeSessionId: sessionId,
      paneLayout: {
        panes: paneLayout.panes.map((pane) =>
          pane.id === activePaneId ? { ...pane, sessionId } : pane
        ),
        activePaneId,
      },
    };
  }

  const pane = { id: generatePaneId(), sessionId };
  return {
    activeSessionId: sessionId,
    paneLayout: {
      panes: [pane],
      activePaneId: pane.id,
    },
  };
}

function addSessionPane(
  state: Pick<ChatStoreState, "sessions" | "activeSessionId" | "paneLayout">,
  sessionId: string
): Pick<ChatStoreState, "activeSessionId" | "paneLayout"> {
  const session = state.sessions[sessionId];
  if (!session || session.status !== "open") {
    return {
      activeSessionId: state.activeSessionId,
      paneLayout: normalizePaneLayout(state.paneLayout, state.sessions),
    };
  }

  const paneLayout = normalizePaneLayout(state.paneLayout, state.sessions);
  const existingPane = paneLayout.panes.find(
    (pane) => pane.sessionId === sessionId
  );
  if (existingPane) {
    return {
      activeSessionId: sessionId,
      paneLayout: {
        panes: paneLayout.panes,
        activePaneId: existingPane.id,
      },
    };
  }

  if (paneLayout.panes.length >= MAX_CHAT_PANES) {
    return focusSessionInPaneLayout(state, sessionId);
  }

  const pane = { id: generatePaneId(), sessionId };
  return {
    activeSessionId: sessionId,
    paneLayout: {
      panes: [...paneLayout.panes, pane],
      activePaneId: pane.id,
    },
  };
}

function removePaneFromLayout(
  state: Pick<ChatStoreState, "sessions" | "activeSessionId" | "paneLayout">,
  paneId: string
): Pick<ChatStoreState, "activeSessionId" | "paneLayout"> {
  const paneLayout = normalizePaneLayout(state.paneLayout, state.sessions);
  if (paneLayout.panes.length <= 1) {
    return {
      activeSessionId: activeSessionIdFromPaneLayout(paneLayout),
      paneLayout,
    };
  }

  const panes = paneLayout.panes.filter((pane) => pane.id !== paneId);
  if (panes.length === paneLayout.panes.length) {
    return {
      activeSessionId: activeSessionIdFromPaneLayout(paneLayout),
      paneLayout,
    };
  }

  const activePaneId =
    paneLayout.activePaneId === paneId
      ? (panes[0]?.id ?? null)
      : paneLayout.activePaneId;
  const nextLayout = { panes, activePaneId };
  return {
    activeSessionId: activeSessionIdFromPaneLayout(nextLayout),
    paneLayout: nextLayout,
  };
}

function removeSessionFromRuntimeState(
  state: ChatStoreState,
  sessionId: string
): Pick<
  ChatStoreState,
  "sessions" | "activeSessionId" | "paneLayout" | "panelOpen"
> {
  const remaining = Object.fromEntries(
    Object.entries(state.sessions).filter(([id]) => id !== sessionId)
  );
  const normalizedPaneLayout = normalizePaneLayout(state.paneLayout, remaining);
  const activePaneSessionId =
    activeSessionIdFromPaneLayout(normalizedPaneLayout);
  const activeSessionStillOpen =
    state.activeSessionId !== null && !!remaining[state.activeSessionId];
  const sessionIds = Object.keys(remaining);

  return {
    sessions: remaining,
    activeSessionId: activeSessionStillOpen
      ? state.activeSessionId
      : (activePaneSessionId ?? latestSessionId(remaining)),
    paneLayout: normalizedPaneLayout,
    panelOpen: sessionIds.length > 0 ? state.panelOpen : false,
  };
}

function collapsePaneLayout(
  state: Pick<ChatStoreState, "sessions" | "activeSessionId" | "paneLayout">,
  paneId?: string
): Pick<ChatStoreState, "activeSessionId" | "paneLayout"> {
  const paneLayout = normalizePaneLayout(state.paneLayout, state.sessions);
  const keepPane =
    (paneId && paneLayout.panes.find((pane) => pane.id === paneId)) ||
    paneLayout.panes.find((pane) => pane.id === paneLayout.activePaneId) ||
    (state.activeSessionId
      ? paneLayout.panes.find(
          (pane) => pane.sessionId === state.activeSessionId
        )
      : undefined) ||
    paneLayout.panes[0];

  if (!keepPane) {
    return { activeSessionId: null, paneLayout: emptyPaneLayout };
  }

  return {
    activeSessionId: keepPane.sessionId,
    paneLayout: {
      panes: [keepPane],
      activePaneId: keepPane.id,
    },
  };
}

export const useChatStore = create<ChatStore>((set, get) => {
  const loadReplayedProviderMessages = async (
    session: ChatSession
  ): Promise<ChatMessage[]> => {
    if (!session.providerResumeId) return [];
    if (typeof commands.loadLocalChatSessionReplay !== "function") return [];
    try {
      const result = await commands.loadLocalChatSessionReplay({
        session_id: session.id,
        harness: session.harness ?? DEFAULT_LOCAL_CHAT_HARNESS,
        provider_resume_id: session.providerResumeId,
        project_path: session.projectPath ?? null,
        created_at: session.createdAt ?? null,
      });
      if (!result || result.status !== "ok") {
        if (result?.status === "error") {
          console.warn(
            "Failed to replay local chat provider transcript",
            result.error
          );
        }
        return [];
      }
      const lines =
        result.data && Array.isArray(result.data.events)
          ? result.data.events.filter(
              (line): line is string => typeof line === "string"
            )
          : [];
      return replayLinesToChatMessages(lines, session);
    } catch (error) {
      console.warn("Failed to replay local chat provider transcript", error);
      return [];
    }
  };

  const hydrateProviderMessagesInPlace = async (
    sessionId: string,
    session: ChatSession
  ): Promise<void> => {
    const expectedProviderResumeId = session.providerResumeId;
    const messages = await loadReplayedProviderMessages(session);
    set((state) => {
      const current = state.sessions[sessionId];
      if (
        !current ||
        current.providerResumeId !== expectedProviderResumeId
      ) {
        return state;
      }
      const merged = mergeHydratedMessages(messages, current.messages);
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...current,
            ...(merged === current.messages
              ? {}
              : {
                  messages: merged,
                  messageCount: Math.max(
                    merged.length,
                    current.messageCount ?? 0
                  ),
                }),
            providerMessagesHydrating: false,
          },
        },
      };
    });
  };

  const updateSession = (
    sessionId: string,
    updater: (session: ChatSession) => ChatSession,
    options: { persist?: boolean } = {}
  ): Promise<boolean> => {
    let updated: ChatSession | null = null;
    set((state) => {
      const session = state.sessions[sessionId];
      if (!session) return state;
      const next = updater(session);
      if (next === session) return state;
      const normalized =
        next.messages !== session.messages
          ? { ...next, messageCount: next.messages.length }
          : next;
      updated = normalized;
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: normalized,
        },
      };
    });
    const updatedSession = updated as ChatSession | null;
    if (updatedSession && options.persist !== false) {
      const persistence = persistLocalChatSession(updatedSession);
      set((state) => ({
        localSessionSummaries: upsertLocalSessionSummary(
          state.localSessionSummaries,
          updatedSession
        ),
      }));
      return persistence;
    }
    return Promise.resolve(true);
  };

  return {
    ...initialState,

    // Actions
    openSession: (label, projectPath) => {
      const existing = findMatchingSession(get().sessions, projectPath);
      if (existing) {
        set((state) => ({
          ...focusSessionInPaneLayout(state, existing),
          panelOpen: true,
        }));
        return existing;
      }

      const persisted = findPersistedLocalChatSession(projectPath);
      if (persisted) {
        const hydrated: ChatSession = hydrateLocalSession({
          ...persisted,
          projectPath: persisted.projectPath ?? projectPath,
          providerMessagesHydrating: !!persisted.providerResumeId,
        });
        if (hydrated.permissionMode !== persisted.permissionMode) {
          persistLocalChatSession(hydrated);
        }
        set((state) => {
          const nextSessions = { ...state.sessions, [hydrated.id]: hydrated };
          return {
            sessions: nextSessions,
            ...focusSessionInPaneLayout(
              {
                ...state,
                sessions: nextSessions,
              },
              hydrated.id
            ),
            panelOpen: true,
          };
        });
        hydrateProviderMessagesInPlace(hydrated.id, hydrated);
        return hydrated.id;
      }

      const session = createLocalSession(label, projectPath);
      const id = session.id;

      persistLocalChatSession(session);

      set((state) => {
        const nextSessions = { ...state.sessions, [id]: session };
        return {
          sessions: nextSessions,
          localSessionSummaries: upsertLocalSessionSummary(
            state.localSessionSummaries,
            session
          ),
          ...focusSessionInPaneLayout({ ...state, sessions: nextSessions }, id),
          panelOpen: true,
        };
      });

      return id;
    },

    closeSession: (sessionId) => {
      set((state) => {
        if (!state.sessions[sessionId]) return state;
        return removeSessionFromRuntimeState(state, sessionId);
      });
    },

    focusSession: (sessionId) => {
      set((state) => focusSessionInPaneLayout(state, sessionId));
    },

    focusPane: (paneId) => {
      set((state) => {
        const paneLayout = normalizePaneLayout(
          state.paneLayout,
          state.sessions
        );
        const pane = paneLayout.panes.find((item) => item.id === paneId);
        if (!pane) return { paneLayout };
        return {
          activeSessionId: pane.sessionId,
          paneLayout: {
            panes: paneLayout.panes,
            activePaneId: pane.id,
          },
        };
      });
    },

    bindPaneToSession: (paneId, sessionId) => {
      let bound = false;
      set((state) => {
        const session = state.sessions[sessionId];
        if (!session || session.status !== "open") {
          return {
            paneLayout: normalizePaneLayout(state.paneLayout, state.sessions),
          };
        }
        const paneLayout = normalizePaneLayout(
          state.paneLayout,
          state.sessions
        );
        const existingPane = paneLayout.panes.find(
          (pane) => pane.sessionId === sessionId
        );
        if (existingPane) {
          bound = true;
          return {
            activeSessionId: sessionId,
            paneLayout: {
              panes: paneLayout.panes,
              activePaneId: existingPane.id,
            },
          };
        }
        if (!paneLayout.panes.some((pane) => pane.id === paneId)) {
          return { paneLayout };
        }
        bound = true;
        return {
          activeSessionId: sessionId,
          paneLayout: {
            panes: paneLayout.panes.map((pane) =>
              pane.id === paneId ? { ...pane, sessionId } : pane
            ),
            activePaneId: paneId,
          },
        };
      });
      return bound;
    },

    startFreshSessionInNewPane: (label, projectPath) => {
      const session = createLocalSession(label, projectPath);
      persistLocalChatSession(session);
      set((state) => {
        const nextSessions = { ...state.sessions, [session.id]: session };
        return {
          sessions: nextSessions,
          localSessionSummaries: upsertLocalSessionSummary(
            state.localSessionSummaries,
            session
          ),
          ...addSessionPane({ ...state, sessions: nextSessions }, session.id),
          panelOpen: true,
        };
      });
      return session.id;
    },

    closePane: (paneId) => {
      set((state) => removePaneFromLayout(state, paneId));
    },

    unsplitPanes: (paneId) => {
      set((state) => collapsePaneLayout(state, paneId));
    },

    listLocalSessions: (projectPath) =>
      [
        ...listPersistedLocalChatSessions(projectPath),
        ...Object.values(get().localSessionSummaries),
      ]
        .filter(
          (session, index, sessions) =>
            sessions.findIndex((candidate) => candidate.id === session.id) ===
            index
        )
        .filter((session) =>
          projectPathMatches(session.projectPath, projectPath)
        )
        .sort(compareLocalChatSessionRecency),

    findLatestResumableSession: async (projectPath) => {
      await get().hydrateLocalSessionIndex();
      return findLatestResumableLocalChatSession(
        get().listLocalSessions(projectPath),
        projectPath
      );
    },

    hydrateLocalSessionIndex: async () => {
      const { sessions } = await hydrateLocalChatSessionIndex();
      set((state) => ({
        localSessionSummaries: localSessionSummariesFromSessions(sessions),
        sessions: {
          ...sessions,
          ...state.sessions,
        },
      }));
    },

    selectPersistedSession: async (sessionId) => {
      const existing = get().sessions[sessionId];
      if (existing) {
        const hydrationSession = existing.providerResumeId
          ? { ...existing, providerMessagesHydrating: true }
          : existing;
        if (hydrationSession !== existing) {
          set((state) => ({
            sessions: {
              ...state.sessions,
              [sessionId]: hydrationSession,
            },
          }));
        }
        void hydrateProviderMessagesInPlace(sessionId, hydrationSession);
        set((state) => {
          const current = state.sessions[sessionId];
          if (!current) return state;
          return {
            sessions: state.sessions,
            ...focusSessionInPaneLayout(
              state,
              sessionId
            ),
            panelOpen: true,
          };
        });
        return true;
      }

      const persisted = loadPersistedLocalChatSession(sessionId);
      if (!persisted || persisted.status !== "open") {
        return false;
      }
      const hydrated = hydrateLocalSession({
        ...persisted,
        providerMessagesHydrating: !!persisted.providerResumeId,
      });
      if (hydrated.permissionMode !== persisted.permissionMode) {
        persistLocalChatSession(hydrated);
      }
      set((state) => {
        const nextSessions = { ...state.sessions, [hydrated.id]: hydrated };
        return {
          sessions: nextSessions,
          ...focusSessionInPaneLayout(
            {
              ...state,
              sessions: nextSessions,
            },
            hydrated.id
          ),
          panelOpen: true,
        };
      });
      void hydrateProviderMessagesInPlace(hydrated.id, hydrated);
      return true;
    },

    selectProviderThreadSession: async (input) => {
      const providerResumeId = input.providerResumeId.trim();
      if (!providerResumeId) return null;
      const projectPath = input.projectPath ?? null;
      const runtimeSessionId = providerThreadSessionId(
        input.harness,
        providerResumeId
      );
      const matchingRuntime = get().sessions[runtimeSessionId];
      if (matchingRuntime) {
        set((state) => ({
          ...focusSessionInPaneLayout(state, matchingRuntime.id),
          panelOpen: true,
        }));
        return matchingRuntime.id;
      }

      const session = createProviderThreadSession({
        ...input,
        providerResumeId,
        projectPath,
      });
      const hydrated = hydrateLocalSession(session);
      set((state) => {
        const nextSessions = { ...state.sessions, [hydrated.id]: hydrated };
        return {
          sessions: nextSessions,
          ...focusSessionInPaneLayout(
            { ...state, sessions: nextSessions },
            hydrated.id
          ),
          panelOpen: true,
        };
      });
      return hydrated.id;
    },

    startFreshSession: (label, projectPath) => {
      const session = createLocalSession(label, projectPath);
      persistLocalChatSession(session);
      set((state) => {
        const nextSessions = { ...state.sessions, [session.id]: session };
        return {
          sessions: nextSessions,
          localSessionSummaries: upsertLocalSessionSummary(
            state.localSessionSummaries,
            session
          ),
          ...focusSessionInPaneLayout(
            {
              ...state,
              sessions: nextSessions,
            },
            session.id
          ),
          panelOpen: true,
        };
      });
      return session.id;
    },

    deleteLocalSession: (sessionId) => {
      markLocalChatSessionCleared(sessionId);
      set((state) => {
        const localSessionSummaries = omitLocalSessionSummary(
          state.localSessionSummaries,
          sessionId
        );
        if (!state.sessions[sessionId]) return { localSessionSummaries };
        return {
          ...removeSessionFromRuntimeState(state, sessionId),
          localSessionSummaries,
        };
      });
    },

    addMessage: (sessionId, message) => {
      if (message.kind === "user") {
        const session = get().sessions[sessionId];
        recordLocalChatTrace({
          source: "gui",
          kind: "message.added",
          direction: "internal",
          sessionId,
          backendSessionId: session?.backendSessionId,
          state: session?.lifecycle,
          payload: message.text,
        });
      }
      updateSession(
        sessionId,
        (session) => {
          if (isSelfProviderAgentToolCall(message, session.providerResumeId)) {
            return session;
          }
          if (
            (message.kind === "tool_call" || message.kind === "tool_result") &&
            session.messages.some(
              (existing) =>
                existing.kind === "user_question" &&
                existing.toolUseId === message.toolId
            )
          ) {
            return session;
          }
          let messages = [...session.messages];
          if (message.kind === "user_question") {
            messages = messages.filter(
              (existing) =>
                !(
                  existing.kind === "tool_call" &&
                  existing.toolId === message.toolUseId &&
                  existing.toolName === "AskUserQuestion"
                )
            );
          }
          if (message.kind === "tool_call") {
            const existingIndex = messages.findIndex(
              (existing) =>
                existing.kind === "tool_call" &&
                existing.toolId === message.toolId
            );
            if (existingIndex !== -1) {
              const existing = messages[existingIndex] as Extract<
                ChatMessage,
                { kind: "tool_call" }
              >;
              messages[existingIndex] = {
                ...existing,
                ...message,
                input: mergeToolCallInput(existing.input, message.input),
                timestamp: existing.timestamp,
              };
              return {
                ...session,
                messages,
                updatedAt: message.timestamp,
              };
            }
          }
          if (message.kind === "file_edit" && message.toolId) {
            const existingIndex = messages.findIndex(
              (existing) =>
                existing.kind === "file_edit" &&
                existing.toolId === message.toolId
            );
            if (existingIndex !== -1) {
              const existing = messages[existingIndex] as Extract<
                ChatMessage,
                { kind: "file_edit" }
              >;
              messages[existingIndex] = {
                ...existing,
                ...message,
                timestamp: existing.timestamp,
              };
              return {
                ...session,
                messages,
                updatedAt: message.timestamp,
              };
            }
          }
          if (message.kind === "assistant" && message.parentToolUseId) {
            return {
              ...session,
              messages: coalesceParentAssistantMessage(messages, message),
              updatedAt: message.timestamp,
            };
          } else {
            messages.push(message);
          }
          return {
            ...session,
            messages,
            updatedAt: message.timestamp,
          };
        },
        { persist: message.kind === "user" }
      );
    },

    resolveUserQuestion: (sessionId, requestId) => {
      updateSession(sessionId, (session) => ({
        ...session,
        messages: session.messages.map((message) =>
          message.kind === "user_question" && message.requestId === requestId
            ? { ...message, status: "resolved" as const }
            : message
        ),
      }));
    },

    markUserQuestionUnavailable: (sessionId, requestId) => {
      updateSession(sessionId, (session) => ({
        ...session,
        messages: session.messages.map((message) =>
          message.kind === "user_question" && message.requestId === requestId
            ? { ...message, status: "unavailable" as const }
            : message
        ),
      }));
    },

    markPendingUserQuestionsUnavailable: (sessionId) => {
      updateSession(sessionId, (session) => ({
        ...session,
        messages: session.messages.map((message) =>
          message.kind === "user_question" && message.status === "pending"
            ? { ...message, status: "unavailable" as const }
            : message
        ),
      }));
    },

    updateLastAssistantMessage: (sessionId, text) => {
      updateSession(
        sessionId,
        (session) => {
          if (!text) return session;
          const current = session.streamingAssistant;
          return {
            ...session,
            lifecycle: "streaming",
            lifecycleError: null,
            streamingAssistant: {
              text: mergeAssistantPartialText(current?.text ?? "", text),
              timestamp: current?.timestamp ?? new Date().toISOString(),
            },
          };
        },
        { persist: false }
      );
    },

    finalizeLastAssistantMessage: (sessionId, text) => {
      updateSession(sessionId, (session) => {
        const messages = [...session.messages];
        const timestamp = new Date().toISOString();
        const last = messages[messages.length - 1];
        if (
          last?.kind === "assistant" &&
          last.isPartial &&
          !last.parentToolUseId
        ) {
          // Only overwrite a trailing MAIN-thread partial. A trailing partial
          // that belongs to a subagent (parentToolUseId set) is a different
          // message — spreading `...last` onto it would stamp the subagent's
          // parentToolUseId onto the main agent's reply, misfiling it as child
          // content (and swallowing it from the main transcript).
          messages[messages.length - 1] = {
            ...last,
            text,
            isPartial: false,
          };
        } else if (lastCompleteAssistantHasText(messages, text)) {
          // Final provider payloads can arrive after an end event has already
          // committed the streamed overlay; keep the durable transcript single.
        } else {
          messages.push({
            kind: "assistant",
            text,
            timestamp,
            isPartial: false,
          });
        }
        return {
          ...session,
          messages,
          updatedAt: timestamp,
          streamingAssistant: null,
        };
      });
    },

    setSessionLifecycle: (sessionId, lifecycle, errorMessage = null) => {
      updateSession(
        sessionId,
        (session) => {
          const normalizedError =
            lifecycle === "error"
              ? (errorMessage ?? "Claude session failed")
              : null;
          const clearsCompaction = [
            "starting",
            "resuming",
            "sending",
            "closing",
            "closed",
            "error",
          ].includes(lifecycle);
          if (
            getLocalChatLifecycle(session) === lifecycle &&
            (session.lifecycleError ?? null) === normalizedError &&
            (!clearsCompaction || !session.compactionActive)
          ) {
            return session;
          }
          return {
            ...session,
            lifecycle,
            lifecycleError: normalizedError,
            ...(clearsCompaction
              ? { compactionActive: false, compactionSummary: null }
              : {}),
          };
        },
        { persist: false }
      );
    },

    beginActiveTurn: (sessionId) => {
      let localId: string | null = null;
      updateSession(
        sessionId,
        (session) => {
          if (session.activeTurn) {
            localId = session.activeTurn.localId;
            return session;
          }
          localId = generateActiveTurnId();
          return {
            ...session,
            activeTurn: {
              localId,
              turnId: null,
              phase: "starting",
            },
          };
        },
        { persist: false }
      );
      return localId;
    },

    bindActiveTurn: (sessionId, turnId) => {
      if (!turnId) return false;
      let bound = false;
      updateSession(
        sessionId,
        (session) => {
          const current = session.activeTurn;
          if (!current || current.turnId === turnId) return session;
          // A root turn starts once per accepted send, so a start for a
          // different turn is proof the bound turn is stale (its terminal
          // event never arrived). Re-point rather than refuse: refusing
          // strands the session on a turn that can never settle.
          bound = true;
          return {
            ...session,
            activeTurn: {
              localId: current.localId,
              turnId,
              phase: current.phase === "stopping" ? "stopping" : "active",
            },
          };
        },
        { persist: false }
      );
      return bound;
    },

    markActiveTurnStopping: (sessionId) => {
      let marked = false;
      updateSession(
        sessionId,
        (session) => {
          const current = session.activeTurn;
          if (!current || current.phase === "stopping") return session;
          marked = true;
          return {
            ...session,
            activeTurn: { ...current, phase: "stopping" },
          };
        },
        { persist: false }
      );
      return marked;
    },

    setSessionCompaction: (sessionId, active) => {
      updateSession(
        sessionId,
        (session) =>
          session.compactionActive === active
            ? session
            : { ...session, compactionActive: active },
        { persist: false }
      );
    },

    setCompactionSummary: (sessionId, summary) => {
      updateSession(
        sessionId,
        (session) =>
          session.compactionSummary === summary
            ? session
            : { ...session, compactionSummary: summary },
        { persist: false }
      );
    },

    restoreActiveTurn: (sessionId, localId) => {
      let restored = false;
      updateSession(
        sessionId,
        (session) => {
          const current = session.activeTurn;
          if (
            !current ||
            current.localId !== localId ||
            current.phase !== "stopping"
          ) {
            return session;
          }
          restored = true;
          return {
            ...session,
            activeTurn: {
              ...current,
              phase: current.turnId === null ? "starting" : "active",
            },
          };
        },
        { persist: false }
      );
      return restored;
    },

    settleActiveTurn: (sessionId, turnId = null) => {
      let settled = false;
      updateSession(
        sessionId,
        (session) => {
          const current = session.activeTurn;
          if (!current) return session;
          if (turnId && current.turnId !== turnId) return session;
          settled = true;
          return { ...session, activeTurn: null };
        },
        { persist: false }
      );
      return settled;
    },

    markStreamingIfSending: (sessionId) => {
      updateSession(
        sessionId,
        (session) => {
          if (getLocalChatLifecycle(session) !== "sending") {
            return session;
          }
          return {
            ...session,
            lifecycle: "streaming",
            lifecycleError: null,
          };
        },
        { persist: false }
      );
    },

    clearStreamingAssistant: (sessionId, commitToMessages = false) => {
      updateSession(
        sessionId,
        (session) => {
          const streaming = session.streamingAssistant;
          if (!streaming) return session;
          const timestamp =
            commitToMessages && streaming.text
              ? new Date().toISOString()
              : streaming.timestamp;
          const messages =
            commitToMessages && streaming.text
              ? lastCompleteAssistantHasText(session.messages, streaming.text)
                ? session.messages
                : [
                    ...session.messages,
                    {
                      kind: "assistant" as const,
                      text: streaming.text,
                      timestamp,
                      isPartial: false,
                    },
                  ]
              : session.messages;
          return {
            ...session,
            messages,
            updatedAt:
              commitToMessages && streaming.text
                ? timestamp
                : session.updatedAt,
            streamingAssistant: null,
          };
        },
        { persist: commitToMessages }
      );
    },

    enqueueQueuedMessage: (sessionId, content) => {
      updateSession(
        sessionId,
        (session) => ({
          ...session,
          queuedMessages: [...(session.queuedMessages ?? []), content],
        }),
        { persist: false }
      );
    },

    shiftQueuedMessage: (sessionId) => {
      let content: string | null = null;
      updateSession(
        sessionId,
        (session) => {
          const [next, ...remaining] = session.queuedMessages ?? [];
          if (!next) return session;
          content = next;
          return {
            ...session,
            queuedMessages: remaining.length > 0 ? remaining : undefined,
          };
        },
        { persist: false }
      );
      return content;
    },

    clearQueuedMessages: (sessionId) => {
      updateSession(
        sessionId,
        (session) =>
          session.queuedMessages?.length
            ? { ...session, queuedMessages: undefined }
            : session,
        { persist: false }
      );
    },

    setBackendSessionId: (sessionId, backendSessionId) => {
      updateSession(
        sessionId,
        (session) => ({ ...session, backendSessionId }),
        {
          persist: false,
        }
      );
    },

    setProviderResumeId: (sessionId, providerResumeId) => {
      updateSession(sessionId, (session) => ({
        ...session,
        providerResumeId,
      }));
    },

    setSessionTitle: (sessionId, title) => {
      const normalized = title?.replace(/\s+/g, " ").trim() || null;
      updateSession(sessionId, (session) => {
        if (!normalized || session.title?.trim()) return session;
        return {
          ...session,
          title: normalized,
          titleStatus: "generated",
          titleConfidence: 1,
        };
      });
    },

    setSessionManualTitle: async (sessionId, title) => {
      const normalized = title.replace(/\s+/g, " ").trim();
      if (!normalized) return false;
      const previous = get().sessions[sessionId];
      if (!previous) return false;
      const saved = await updateSession(sessionId, (session) => ({
        ...session,
        title: normalized,
        titleStatus: "manual",
        titleConfidence: null,
      }));
      if (saved) return true;

      const current = get().sessions[sessionId];
      if (
        current?.title === normalized &&
        current.titleStatus === "manual"
      ) {
        updateSession(
          sessionId,
          (session) => ({
            ...session,
            title: previous.title,
            titleStatus: previous.titleStatus,
            titleConfidence: previous.titleConfidence,
            titleUserMessageCount: previous.titleUserMessageCount,
          }),
          { persist: false }
        );
        const restored = get().sessions[sessionId];
        if (restored) {
          persistLocalChatSession(restored);
          set((state) => ({
            localSessionSummaries: upsertLocalSessionSummary(
              state.localSessionSummaries,
              restored
            ),
          }));
        }
      }
      return false;
    },

    setSessionTitleCandidate: (sessionId, candidate, options) => {
      const normalized = candidate.title?.replace(/\s+/g, " ").trim() || null;
      const confidence = Number.isFinite(candidate.confidence)
        ? Math.max(0, Math.min(1, candidate.confidence))
        : 0;
      const confident =
        !!normalized &&
        candidate.sufficientSignal &&
        confidence >= GENERATED_TITLE_CONFIDENCE_THRESHOLD;
      updateSession(sessionId, (session) => {
        if (
          options?.expectedUpdatedAt !== undefined &&
          session.updatedAt !== options.expectedUpdatedAt
        ) {
          return session;
        }
        if (
          options?.expectedMessageCount !== undefined &&
          session.messages.length !== options.expectedMessageCount
        ) {
          return session;
        }
        if (
          session.titleStatus === "manual" ||
          (session.titleStatus === "generated" &&
            !options?.replaceGenerated) ||
          (session.title?.trim() && session.titleStatus !== "generated")
        ) {
          return session;
        }
        if (
          options?.replaceGenerated &&
          session.titleStatus === "generated" &&
          !confident
        ) {
          return session;
        }
        return {
          ...session,
          title: confident ? normalized : null,
          titleStatus: confident ? "generated" : "low_confidence",
          titleConfidence: confidence,
          titleUserMessageCount: candidate.userMessageCount,
        };
      });
    },

    setSessionModel: (sessionId, model) => {
      updateSession(sessionId, (session) =>
        session.model === model ? session : { ...session, model }
      );
    },

    setSessionHarness: (sessionId, harness) => {
      updateSession(sessionId, (session) => {
        if (session.backendSessionId || session.providerResumeId) {
          return session;
        }
        if (session.harness === harness) return session;
        return {
          ...session,
          harness,
          permissionMode: "default",
          selectedModelId: undefined,
          selectedReasoningEffort: undefined,
          model: undefined,
          tokenUsage: undefined,
        };
      });
      clearLastUsedLocalChatModelId();
    },

    setSessionSelectedModel: (sessionId, modelId) => {
      const normalized = modelId?.trim() || null;
      updateSession(sessionId, (session) =>
        session.selectedModelId === normalized
          ? session
          : { ...session, selectedModelId: normalized }
      );
      if (normalized) {
        persistLastUsedLocalChatModelId(normalized);
      } else {
        clearLastUsedLocalChatModelId();
      }
    },

    setSessionReasoningEffort: (sessionId, reasoningEffort) => {
      const normalized = reasoningEffort?.trim() || null;
      updateSession(sessionId, (session) =>
        session.selectedReasoningEffort === normalized
          ? session
          : { ...session, selectedReasoningEffort: normalized }
      );
    },

    setSessionPermissionMode: (sessionId, permissionMode) => {
      updateSession(sessionId, (session) =>
        session.permissionMode === permissionMode
          ? session
          : { ...session, permissionMode }
      );
    },

    setSessionTokenUsage: (sessionId, usage) => {
      updateSession(sessionId, (session) => {
        if (
          session.tokenUsage?.used === usage.used &&
          session.tokenUsage?.max === usage.max
        ) {
          return session;
        }
        return { ...session, tokenUsage: usage };
      });
    },

    setSessionUsage: (sessionId, model, usage, threadTotalTokens) => {
      updateSession(sessionId, (session) => {
        const nextThreadTotalTokens =
          threadTotalTokens ?? session.threadTotalTokens;
        if (
          session.model === model &&
          session.tokenUsage?.used === usage.used &&
          session.tokenUsage?.max === usage.max &&
          session.threadTotalTokens === nextThreadTotalTokens
        ) {
          return session;
        }
        return {
          ...session,
          model,
          tokenUsage: usage,
          threadTotalTokens: nextThreadTotalTokens,
        };
      });
    },

    markSessionClosed: (sessionId) => {
      const session = get().sessions[sessionId];
      if (!session) return;
      const closedSession = {
        ...session,
        status: "open" as const,
        backendSessionId: null,
        lifecycle: "closed" as const,
        lifecycleError: null,
        compactionActive: false,
        compactionSummary: null,
        activeTurn: null,
        streamingAssistant: null,
        queuedMessages: undefined,
      };
      if (isDisposableClosedLocalChatSession(closedSession)) {
        persistLocalChatSession(closedSession);
        set((state) => {
          const localSessionSummaries = omitLocalSessionSummary(
            state.localSessionSummaries,
            sessionId
          );
          if (!state.sessions[sessionId]) return { localSessionSummaries };
          return {
            ...removeSessionFromRuntimeState(state, sessionId),
            localSessionSummaries,
          };
        });
        return;
      }
      updateSession(sessionId, () => closedSession);
    },

    clearMessages: (sessionId) => {
      if (!get().sessions[sessionId]) return;
      markLocalChatSessionCleared(sessionId);
      const timestamp = new Date().toISOString();
      set((state) => {
        const session = state.sessions[sessionId];
        if (!session) return state;
        const localSessionSummaries = omitLocalSessionSummary(
          state.localSessionSummaries,
          sessionId
        );
        return {
          sessions: {
            ...state.sessions,
            [sessionId]: {
              ...session,
              messages: [],
              title: null,
              titleStatus: "pending",
              titleConfidence: null,
              titleUserMessageCount: 0,
              backendSessionId: null,
              providerResumeId: null,
              selectedModelId: session.selectedModelId ?? null,
              model: undefined,
              tokenUsage: undefined,
              status: "open",
              lifecycle: "idle",
              lifecycleError: null,
              activeTurn: null,
              streamingAssistant: null,
              queuedMessages: undefined,
              providerMessagesHydrating: false,
              updatedAt: timestamp,
              messageCount: 0,
            },
          },
          localSessionSummaries,
        };
      });
    },

    togglePanel: () => {
      set((state) => ({ panelOpen: !state.panelOpen }));
    },

    setPanelOpen: (open) => {
      set({ panelOpen: open });
    },

    reset: () => set(emptyState),
  };
});

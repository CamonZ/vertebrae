import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocalChat } from "../../hooks/useLocalChat";
import { commands } from "../../bindings";
import type {
  JsonValue,
  LocalChatHarnessCatalog,
  LocalChatHarnessInfo,
  LocalChatHarnessKind,
  PermissionMode,
} from "../../bindings";
import {
  useChatStore,
  getLocalChatLifecycle,
  isLocalChatLifecycleBusy,
} from "../../stores/chatStore";
import type { ChatMessage } from "../../stores/chatStore";
import {
  formatTokenCount,
  utilizationLevel,
} from "../../utils/modelContextWindow";
import {
  DEFAULT_LOCAL_CHAT_HARNESS,
  isLocalChatSessionCleared,
  loadLastUsedLocalChatModelId,
} from "../../utils/localChatPersistence";
import { Thread } from "../thread";
import type { ThreadModel } from "../thread";
import { ChatInput } from "../ChatInput";
import { StopIcon } from "../panels";
import { chatMessagesToThread } from "./chatMessagesToThread";

const PERMISSION_MODE_OPTIONS: Array<{
  value: PermissionMode;
  label: string;
}> = [
  { value: "default", label: "Ask before edits" },
  { value: "accept_edits", label: "Edit automatically" },
  { value: "plan", label: "Plan mode" },
  { value: "auto", label: "Auto mode" },
  { value: "dont_ask", label: "Don't ask" },
  { value: "bypass_permissions", label: "Bypass permissions" },
];
const LOCAL_CHAT_SCROLL_TO_SPAWN_EVENT = "local-chat-scroll-to-spawn";

function harnessDisplayName(harness: LocalChatHarnessKind): string {
  switch (harness) {
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
  }
}

function isSessionHarnessLocked(session: {
  backendSessionId: string | null;
  providerResumeId: string | null;
}): boolean {
  return !!session.backendSessionId || !!session.providerResumeId;
}

function isHarnessSelectable(
  info: LocalChatHarnessInfo,
  currentHarness: LocalChatHarnessKind,
  locked: boolean
): boolean {
  if (locked) return info.harness === currentHarness;
  return info.available;
}

/**
 * Thinking indicator shown while waiting for Claude to respond
 */
function ThinkingIndicator() {
  return (
    <div className="flex justify-start">
      <div className="flex items-center gap-2 rounded-lg bg-[var(--color-bg-2)] px-4 py-3">
        <div className="flex gap-1">
          <span className="h-2 w-2 animate-bounce rounded-full bg-[var(--color-accent)] [animation-delay:-0.3s]" />
          <span className="h-2 w-2 animate-bounce rounded-full bg-[var(--color-accent)] [animation-delay:-0.15s]" />
          <span className="h-2 w-2 animate-bounce rounded-full bg-[var(--color-accent)]" />
        </div>
        <span className="text-sm text-[var(--color-fg-mute)]">Thinking...</span>
      </div>
    </div>
  );
}

function lifecycleLabel(
  lifecycle: ReturnType<typeof getLocalChatLifecycle>
): string {
  switch (lifecycle) {
    case "starting":
      return "Starting";
    case "resuming":
      return "Resuming";
    case "sending":
      return "Sending";
    case "streaming":
      return "Streaming";
    case "closing":
      return "Closing";
    case "closed":
      return "Closed";
    case "error":
      return "Failed";
    case "idle":
      return "Ready";
  }
}

// ---------------------------------------------------------------------------
// Turn grouping
// ---------------------------------------------------------------------------
//
// chatStore emits each Claude event as a sibling `ChatMessage`. The pure adapter
// `chatMessagesToThread` groups those siblings into the canonical Thread tree
// (one Turn per user message; tool_call/tool_result merged into nested tools)
// so the chat renders through the SAME recursive <Thread> primitive as Traces.
//
// `permission_request` is the one event the adapter SKIPS: it is interactive,
// not a Message kind, so ChatWindow interleaves PermissionRequestTurn nodes
// between Thread chunks at their original message positions.

function PermissionRequestTurn({
  message,
}: {
  message: Extract<ChatMessage, { kind: "permission_request" }>;
}) {
  const [updatedInput, setUpdatedInput] = useState(message.input ?? "");
  const [status, setStatus] = useState<
    "pending" | "allowing" | "denying" | "resolved" | "error"
  >(message.requestId ? "pending" : "resolved");
  const [error, setError] = useState<string | null>(null);

  const resolve = async (behavior: "allow" | "deny") => {
    if (!message.requestId) return;
    setStatus(behavior === "allow" ? "allowing" : "denying");
    setError(null);

    let parsedInput: JsonValue | null = null;
    if (behavior === "allow") {
      try {
        parsedInput = updatedInput.trim()
          ? (JSON.parse(updatedInput) as JsonValue)
          : {};
      } catch (err) {
        setStatus("error");
        setError(err instanceof Error ? err.message : "Invalid JSON");
        return;
      }
      if (!isJsonRecord(parsedInput)) {
        setStatus("error");
        setError("Updated input must be a JSON object");
        return;
      }
    }

    const result = await commands.resolvePermissionRequest({
      request_id: message.requestId,
      behavior,
      message: behavior === "deny" ? "Denied from Vertebrae GUI" : null,
      updated_input: behavior === "allow" ? parsedInput : null,
    });

    if (result.status === "ok") {
      setStatus("resolved");
    } else {
      setStatus("error");
      setError(result.error.message);
    }
  };

  const disabled =
    status === "allowing" || status === "denying" || status === "resolved";

  return (
    <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-bg-2)] p-3">
      <p className="mb-2 font-mono text-eyebrow uppercase tracking-wider text-[var(--color-fg-mute)]">
        Permission required
      </p>
      <div className="space-y-3">
        <div>
          <p className="font-mono text-xs text-[var(--color-fg)]">
            {message.toolName}
          </p>
          <p className="mt-1 text-sm text-[var(--color-fg-soft)]">
            {message.message}
          </p>
        </div>
        {message.input && (
          <textarea
            value={updatedInput}
            onChange={(event) => setUpdatedInput(event.target.value)}
            disabled={disabled}
            className="h-32 w-full resize-y rounded border border-[var(--color-line)] bg-[var(--color-bg)] p-2 font-mono text-xs text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
            spellCheck={false}
          />
        )}
        {error && <p className="text-xs text-[var(--color-err)]">{error}</p>}
        <div className="flex gap-2">
          <button
            type="button"
            disabled={disabled}
            onClick={() => void resolve("allow")}
            className="rounded border border-[var(--color-ok)]/40 px-3 py-1.5 text-xs font-medium text-[var(--color-ok)] transition-colors hover:bg-[var(--color-ok)]/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {status === "allowing" ? "Approving..." : "Approve"}
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => void resolve("deny")}
            className="rounded border border-[var(--color-err)]/40 px-3 py-1.5 text-xs font-medium text-[var(--color-err)] transition-colors hover:bg-[var(--color-err)]/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {status === "denying" ? "Denying..." : "Deny"}
          </button>
          {status === "resolved" && (
            <span className="self-center text-xs text-[var(--color-fg-mute)]">
              Resolved
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function isJsonRecord(
  value: JsonValue | null
): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ChatRenderItem =
  | { kind: "thread"; key: string; thread: ThreadModel }
  | {
      kind: "permission";
      key: string;
      message: Extract<ChatMessage, { kind: "permission_request" }>;
    };

function buildChatRenderItems(
  messages: readonly ChatMessage[],
  assistantLabel: string
): ChatRenderItem[] {
  const items: ChatRenderItem[] = [];
  let segment: ChatMessage[] = [];
  let segmentSeq = 0;

  // Pull sub-agent (sidechain) tool messages out of the main chronological
  // stream and key them by their spawning Task tool. Otherwise a permission
  // segment boundary that falls between a spawn and its children splits the
  // spawn group, and the children render as orphaned threads dumped at the
  // bottom. The spawn's parent tool_call stays in the main stream, so the
  // sub-agent re-nests at its chronological position (see chatMessagesToThread).
  const childrenByParent = new Map<string, ChatMessage[]>();
  for (const message of messages) {
    const parent =
      (message.kind === "assistant" ||
        message.kind === "tool_call" ||
        message.kind === "tool_result") &&
      message.parentToolUseId
        ? message.parentToolUseId
        : undefined;
    if (!parent) continue;
    const group = childrenByParent.get(parent);
    if (group) group.push(message);
    else childrenByParent.set(parent, [message]);
  }

  const flushSegment = () => {
    if (segment.length === 0) return;
    items.push({
      kind: "thread",
      key: `thread-${segmentSeq++}`,
      thread: chatMessagesToThread(segment, {
        childrenByParent,
        assistantLabel,
      }),
    });
    segment = [];
  };

  messages.forEach((message, index) => {
    if (message.kind === "permission_request") {
      flushSegment();
      items.push({
        kind: "permission",
        key: message.requestId ?? `permission-${index}`,
        message,
      });
      return;
    }

    // Sub-agent messages are re-injected via childrenByParent at their parent
    // spawn's position; keep them out of the main segment stream.
    if (
      (message.kind === "assistant" ||
        message.kind === "tool_call" ||
        message.kind === "tool_result") &&
      message.parentToolUseId
    ) {
      return;
    }

    segment.push(message);
  });

  flushSegment();
  return items;
}

interface ChatWindowProps {
  sessionId: string;
  /** Closes the whole chat panel (the header's ✕). Provided by the manager. */
  onClosePanel?: () => void;
  /** Opens the local-only persisted session history drawer. */
  onToggleHistory?: () => void;
  /** Starts a fresh local chat for the current project. */
  onStartFresh?: () => void;
  /** Expands/collapses the project chat panel session view. */
  onToggleWide?: () => void;
  isWide?: boolean;
  /** Adds another visible chat pane in the maximized view. */
  onSplitPane?: () => void;
  canSplitPane?: boolean;
  /** Collapses the maximized view back to this pane only. */
  onUnsplitPanes?: () => void;
  /** Closes this pane without closing the underlying chat session. */
  onClosePane?: () => void;
  /** Whether this pane should receive composer autofocus. */
  autoFocusComposer?: boolean;
}

/**
 * ChatWindow renders a single chat session: the header band (title + status),
 * the message thread, and the composer footer with its context-utilization bar.
 */
export function ChatWindow({
  sessionId,
  onClosePanel,
  onToggleHistory,
  onStartFresh,
  onToggleWide,
  isWide = false,
  onSplitPane,
  canSplitPane = true,
  onUnsplitPanes,
  onClosePane,
  autoFocusComposer = true,
}: ChatWindowProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messageRefs = useRef(new Map<string, HTMLElement>());
  const [inputValue, setInputValue] = useState("");
  const [harnessCatalog, setHarnessCatalog] =
    useState<LocalChatHarnessCatalog | null>(null);

  const {
    session,
    isActive,
    startSession,
    sendMessage,
    closeLocalChatSession,
  } = useLocalChat(sessionId);

  const clearMessages = useChatStore((s) => s.clearMessages);
  const setSessionSelectedModel = useChatStore(
    (s) => s.setSessionSelectedModel
  );
  const setSessionReasoningEffort = useChatStore(
    (s) => s.setSessionReasoningEffort
  );
  const setSessionHarness = useChatStore((s) => s.setSessionHarness);
  const setSessionPermissionMode = useChatStore(
    (s) => s.setSessionPermissionMode
  );

  useEffect(() => {
    let cancelled = false;
    void commands
      .getSupportedLocalChatHarnesses()
      .then((catalog) => {
        if (!cancelled) setHarnessCatalog(catalog);
      })
      .catch(() => {
        // The chat still works without a picker; backend validation remains.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedHarness = session?.harness ?? DEFAULT_LOCAL_CHAT_HARNESS;
  const lockedHarness = session ? isSessionHarnessLocked(session) : false;
  const visibleHarness = useMemo(() => {
    if (!harnessCatalog) return null;
    return (
      harnessCatalog.harnesses.find(
        (item) => item.harness === selectedHarness
      ) ??
      harnessCatalog.harnesses.find(
        (item) => item.harness === harnessCatalog.default_harness
      ) ??
      null
    );
  }, [harnessCatalog, selectedHarness]);
  const providerOptions = useMemo(() => {
    if (!harnessCatalog) return [];
    return harnessCatalog.harnesses.map((info) => ({
      info,
      disabled: !isHarnessSelectable(info, selectedHarness, lockedHarness),
    }));
  }, [harnessCatalog, lockedHarness, selectedHarness]);

  const supportedModelIds = useMemo(
    () => new Set((visibleHarness?.models ?? []).map((model) => model.id)),
    [visibleHarness]
  );
  const supportedReasoningEffortIds = useMemo(
    () =>
      new Set(
        (visibleHarness?.reasoning_efforts ?? []).map((effort) => effort.id)
      ),
    [visibleHarness]
  );
  const selectedModelId = session?.selectedModelId;
  const selectedReasoningEffort = session?.selectedReasoningEffort;
  const lifecycle = getLocalChatLifecycle(session);
  const isBusy = isLocalChatLifecycleBusy(lifecycle);
  const canQueueMessage =
    !!session?.backendSessionId &&
    (lifecycle === "sending" || lifecycle === "streaming");
  const hasResume = !!session?.providerResumeId;
  const selectedHarnessAvailable = visibleHarness?.available !== false;
  const canUseComposer =
    selectedHarnessAvailable && (!isBusy || canQueueMessage);
  const canSendMessage = (isActive || canQueueMessage) && canUseComposer;
  const shouldStartOrResume = !isActive && canUseComposer;
  const hasSession = !!session;
  const hasConversation = !!session?.providerResumeId;
  const messageCount = session?.messages.length ?? 0;

  useEffect(() => {
    if (!hasSession || !visibleHarness) return;
    if (isLocalChatSessionCleared(sessionId)) return;
    if (selectedModelId !== undefined) return;
    if (hasConversation || messageCount > 0) return;

    const lastUsed = loadLastUsedLocalChatModelId();
    if (lastUsed && supportedModelIds.has(lastUsed)) {
      setSessionSelectedModel(sessionId, lastUsed);
    }
  }, [
    visibleHarness,
    hasConversation,
    hasSession,
    messageCount,
    selectedModelId,
    sessionId,
    setSessionSelectedModel,
    supportedModelIds,
  ]);

  useEffect(() => {
    if (!hasSession || !visibleHarness) return;
    if (lockedHarness || hasConversation) return;
    if (!selectedModelId) return;
    if (visibleHarness.models.length > 0) return;
    setSessionSelectedModel(sessionId, null);
  }, [
    hasConversation,
    hasSession,
    lockedHarness,
    selectedModelId,
    sessionId,
    setSessionSelectedModel,
    visibleHarness,
  ]);

  useEffect(() => {
    if (!hasSession || !visibleHarness) return;
    if (lockedHarness || hasConversation) return;
    if (!selectedReasoningEffort) return;
    if (supportedReasoningEffortIds.has(selectedReasoningEffort)) return;
    setSessionReasoningEffort(sessionId, null);
  }, [
    hasConversation,
    hasSession,
    lockedHarness,
    selectedReasoningEffort,
    sessionId,
    setSessionReasoningEffort,
    supportedReasoningEffortIds,
    visibleHarness,
  ]);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [session?.messages, session?.streamingAssistant]);

  // Focus the composer when this chat window is the foreground pane. The
  // composer is always rendered, so this lands before a Claude session starts.
  useEffect(() => {
    if (!autoFocusComposer) return;
    inputRef.current?.focus();
  }, [autoFocusComposer]);

  useEffect(() => {
    const handleScrollToSpawn = (event: Event) => {
      const detail = (event as CustomEvent<{
        sessionId?: string;
        spawnId?: string;
      }>).detail;
      if (detail?.sessionId !== sessionId || !detail.spawnId) return;
      messageRefs.current
        .get(detail.spawnId)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    };
    window.addEventListener(LOCAL_CHAT_SCROLL_TO_SPAWN_EVENT, handleScrollToSpawn);
    return () =>
      window.removeEventListener(
        LOCAL_CHAT_SCROLL_TO_SPAWN_EVENT,
        handleScrollToSpawn
      );
  }, [sessionId]);

  const handleSend = useCallback(() => {
    const trimmed = inputValue.trim();
    if (!trimmed || !canSendMessage) return;
    void sendMessage(trimmed);
    setInputValue("");
  }, [canSendMessage, inputValue, sendMessage]);

  const handleStartSession = useCallback(() => {
    const initialPrompt = inputValue.trim();
    void startSession(initialPrompt || undefined);
    setInputValue("");
  }, [inputValue, startSession]);

  const handleClearMessages = useCallback(async () => {
    if (session?.backendSessionId) {
      const closed = await closeLocalChatSession({ markClosed: false });
      if (!closed) return;
    }
    clearMessages(sessionId);
  }, [
    clearMessages,
    closeLocalChatSession,
    session?.backendSessionId,
    sessionId,
  ]);

  const handleStopGeneration = useCallback(async () => {
    if (!session?.backendSessionId) return;
    await closeLocalChatSession({ markClosed: false });
  }, [closeLocalChatSession, session?.backendSessionId]);

  const handleModelChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      setSessionSelectedModel(sessionId, event.target.value || null);
    },
    [sessionId, setSessionSelectedModel]
  );
  const handleReasoningEffortChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      setSessionReasoningEffort(sessionId, event.target.value || null);
    },
    [sessionId, setSessionReasoningEffort]
  );
  const handleHarnessChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      setSessionHarness(sessionId, event.target.value as LocalChatHarnessKind);
    },
    [sessionId, setSessionHarness]
  );
  const handlePermissionModeChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      setSessionPermissionMode(
        sessionId,
        (event.target.value || "default") as PermissionMode
      );
    },
    [sessionId, setSessionPermissionMode]
  );

  const canStopGeneration =
    !!session?.backendSessionId &&
    (lifecycle === "starting" ||
      lifecycle === "resuming" ||
      lifecycle === "sending" ||
      lifecycle === "streaming" ||
      isActive);

  useEffect(() => {
    if (!canStopGeneration) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "." || (!event.metaKey && !event.ctrlKey)) return;
      event.preventDefault();
      void handleStopGeneration();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [canStopGeneration, handleStopGeneration]);

  const submitLabel =
    lifecycle === "starting"
      ? "Start session"
      : lifecycle === "resuming"
        ? "Resume session"
        : isActive
          ? "Send message"
          : hasResume || lifecycle === "closed" || lifecycle === "error"
            ? "Resume session"
            : "Start session";
  const composerPlaceholder = canQueueMessage
    ? "Type a message to queue..."
    : isBusy
      ? `${lifecycleLabel(lifecycle)}...`
      : canSendMessage
        ? "Type a message..."
        : hasResume || lifecycle === "closed" || lifecycle === "error"
          ? "Type a message to resume..."
          : "Type a message to start...";

  const sessionMessages = session?.messages;
  const streamingAssistant = session?.streamingAssistant;
  const displayMessages = useMemo(() => {
    if (!sessionMessages) return [];
    if (!streamingAssistant) return sessionMessages;
    return [
      ...sessionMessages,
      {
        kind: "assistant" as const,
        text: streamingAssistant.text,
        timestamp: streamingAssistant.timestamp,
        isPartial: true,
      },
    ];
  }, [sessionMessages, streamingAssistant]);

  const messages = displayMessages;
  const hasStreamingOverlay = !!streamingAssistant;
  const isWaiting =
    (lifecycle === "sending" ||
      lifecycle === "streaming" ||
      (isActive && lifecycle !== "error")) &&
    !hasStreamingOverlay &&
    messages.length > 0 &&
    messages[messages.length - 1].kind === "user";

  // Normalize-on-render: derive canonical Thread chunks from the live store
  // messages, interleaving interactive permission cards at their original
  // message positions so the chat stays chronological.
  const assistantLabel = session
    ? harnessDisplayName(session.harness)
    : "Assistant";
  const renderItems = useMemo(
    () => buildChatRenderItems(messages, assistantLabel),
    [assistantLabel, messages]
  );

  if (!session) return null;

  const selectedModelUnsupported =
    !!session.selectedModelId &&
    !supportedModelIds.has(session.selectedModelId);
  const selectedReasoningEffortUnsupported =
    !!session.selectedReasoningEffort &&
    !supportedReasoningEffortIds.has(session.selectedReasoningEffort);
  const modelPickerDisabled =
    isBusy ||
    isActive ||
    lockedHarness ||
    !visibleHarness?.available ||
    (visibleHarness.models ?? []).length === 0;
  const modelDefaultLabel = session.providerResumeId
    ? "Original model"
    : visibleHarness?.default_model_id
      ? "Default model"
      : "CLI default";
  const effortPickerDisabled =
    isBusy ||
    isActive ||
    lockedHarness ||
    hasResume ||
    !visibleHarness?.available ||
    (visibleHarness.reasoning_efforts ?? []).length === 0;
  const effortDefaultLabel = hasResume
    ? "Original effort"
    : visibleHarness?.default_reasoning_effort
      ? "Default effort"
      : "Provider default";
  const unavailableReason =
    visibleHarness && !visibleHarness.available
      ? (visibleHarness.unavailable_reason ??
        `${visibleHarness.label} is unavailable`)
      : null;

  // Current request input-context utilization for the footer bar + readout.
  // Falls back to an empty bar before the first usage event lands.
  const usage = session.tokenUsage;
  const ctxPct =
    usage && usage.max > 0
      ? Math.min(100, Math.round((usage.used / usage.max) * 100))
      : 0;
  const ctxColor =
    usage && usage.max > 0
      ? utilizationLevel(usage.used, usage.max) === "danger"
        ? "var(--color-err)"
        : utilizationLevel(usage.used, usage.max) === "warn"
          ? "var(--color-warn)"
          : "var(--color-ok)"
      : "var(--color-ok)";

  return (
    <div className="flex h-full flex-col">
      {/* Header — single band: title + status ember and controls. */}
      <div className="hc-head">
        <div className="hc-head-top">
          <span className="hc-title">
            <span className="label">{session.label}</span>
            {lifecycle === "error" ? (
              <span
                data-testid="chat-error-dot"
                className="em"
                style={{
                  background: "var(--color-err)",
                  boxShadow:
                    "0 0 6px color-mix(in oklch, var(--color-err) 60%, transparent)",
                }}
              />
            ) : isActive ? (
              <span data-testid="chat-active-dot" className="em ok" />
            ) : lifecycle === "closed" ? (
              <span data-testid="chat-closed-dot" className="em mute" />
            ) : (
              <span className="em" />
            )}
          </span>
          <div className="hc-ctrls">
            {onToggleHistory && (
              <button
                className="hc-ctrl"
                onClick={onToggleHistory}
                title="Toggle chat history"
                aria-label="Toggle chat history"
              >
                <svg
                  className="h-3.5 w-3.5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 8v4l3 2m6-2a9 9 0 11-3-6.708M21 3v6h-6"
                  />
                </svg>
              </button>
            )}
            {onStartFresh && (
              <button
                className="hc-ctrl"
                onClick={onStartFresh}
                title="Start fresh local chat"
                aria-label="Start fresh local chat"
              >
                <svg
                  className="h-3.5 w-3.5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 5v14m7-7H5"
                  />
                </svg>
              </button>
            )}
            {onToggleWide && (
              <button
                className="hc-ctrl"
                onClick={onToggleWide}
                title={isWide ? "Collapse chat panel" : "Widen chat panel"}
                aria-label={isWide ? "Collapse chat panel" : "Widen chat panel"}
              >
                <svg
                  className="h-3.5 w-3.5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  {isWide ? (
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 9H4V4m0 5 5-5m6 5h5V4m0 5-5-5M9 15H4v5m0-5 5 5m6-5h5v5m0-5-5 5"
                    />
                  ) : (
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 9V4h5M4 4l6 6m10-1V4h-5m5 0-6 6M4 15v5h5m-5 0 6-6m10 1v5h-5m5 0-6-6"
                    />
                  )}
                </svg>
              </button>
            )}
            {onSplitPane && (
              <button
                className="hc-ctrl"
                onClick={onSplitPane}
                disabled={!canSplitPane}
                title={
                  canSplitPane ? "Split chat pane" : "No more chat panes fit"
                }
                aria-label="Split chat pane"
              >
                <svg
                  className="h-3.5 w-3.5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M4 5h7v14H4zM13 5h7v14h-7z"
                  />
                </svg>
              </button>
            )}
            {onUnsplitPanes && (
              <button
                className="hc-ctrl"
                onClick={onUnsplitPanes}
                title="Keep only this pane"
                aria-label="Keep only this pane"
              >
                <svg
                  className="h-3.5 w-3.5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 5h14v14H5zM9 9l3 3m0 0 3-3m-3 3v6"
                  />
                </svg>
              </button>
            )}
            {onClosePane && (
              <button
                className="hc-ctrl"
                onClick={onClosePane}
                title="Close this pane"
                aria-label="Close this pane"
              >
                <svg
                  className="h-3.5 w-3.5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            )}
            <button
              className="hc-ctrl"
              onClick={() => void handleClearMessages()}
              disabled={lifecycle === "closing"}
              title="Clear messages"
              aria-label="Clear messages"
            >
              <svg
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                />
              </svg>
            </button>
            <button
              className="hc-ctrl danger"
              onClick={() => void handleStopGeneration()}
              disabled={!canStopGeneration}
              title="Stop generation (Cmd+.)"
              aria-label="Stop generation"
              data-testid="local-chat-stop-generation"
            >
              <StopIcon />
            </button>
            <button
              className="hc-ctrl"
              onClick={onClosePanel}
              title="Close chat panel"
              aria-label="Close chat panel"
            >
              <svg
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto p-4">
        {session.messages.length === 0 && !isActive && (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-accent)]/10">
              <svg
                className="h-6 w-6 text-[var(--color-accent)]"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                />
              </svg>
            </div>
            <p className="text-sm text-[var(--color-fg-soft)]">
              Create, edit, and delete tasks, steps, and workflows
            </p>
            <p className="mt-1 text-xs text-[var(--color-fg-mute)]">
              Or run a task through a workflow
            </p>
          </div>
        )}

        <div className="flex flex-col gap-3">
          {renderItems.map((item) =>
            item.kind === "thread" ? (
              <Thread
                key={item.key}
                thread={item.thread}
                depth={0}
                mode="bare"
                reveal="shallow"
                showHead={false}
                interactive
                registerRef={(id, element) => {
                  if (element) {
                    messageRefs.current.set(id, element);
                  } else {
                    messageRefs.current.delete(id);
                  }
                }}
              />
            ) : (
              <PermissionRequestTurn key={item.key} message={item.message} />
            )
          )}
          {isWaiting && <ThinkingIndicator />}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Composer footer — context-utilization bar, input, context readout. */}
      <div className="hc-foot">
        <div className="hc-ctx">
          <div
            className="hc-ctx-fill"
            data-testid="chat-context-fill"
            style={{ width: `${ctxPct}%`, background: ctxColor }}
          />
        </div>
        <div className="p-3">
          <ChatInput
            ref={inputRef}
            value={inputValue}
            onChange={setInputValue}
            onSubmit={canSendMessage ? handleSend : handleStartSession}
            disabled={!canUseComposer}
            canSubmit={
              canUseComposer &&
              inputValue.trim().length > 0 &&
              (canSendMessage || shouldStartOrResume)
            }
            placeholder={composerPlaceholder}
            buttonTitle={submitLabel}
            buttonAriaLabel={submitLabel}
            textareaTestId="local-chat-composer"
            footerLeft={
              <div className="hc-chat-controls">
                {harnessCatalog && (
                  <label className="hc-provider-picker">
                    <span>Provider</span>
                    <select
                      aria-label="Local chat provider"
                      data-testid="local-chat-provider-picker"
                      value={session.harness}
                      onChange={handleHarnessChange}
                      disabled={isBusy || isActive || lockedHarness}
                    >
                      {providerOptions.map(({ info, disabled }) => (
                        <option
                          key={info.harness}
                          value={info.harness}
                          disabled={disabled}
                        >
                          {info.available
                            ? info.label
                            : `${info.label}: ${
                                info.unavailable_reason ?? "Unavailable"
                              }`}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="hc-permission-picker">
                  <span>Permission</span>
                  <select
                    aria-label="Local chat permission mode"
                    data-testid="local-chat-permission-mode-picker"
                    value={session.permissionMode ?? "default"}
                    onChange={handlePermissionModeChange}
                    disabled={isBusy || isActive}
                  >
                    {PERMISSION_MODE_OPTIONS.map((mode) => (
                      <option key={mode.value} value={mode.value}>
                        {mode.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            }
            footerRight={
              visibleHarness ? (
                <div className="hc-chat-controls right">
                  <label className="hc-model-picker">
                    <span>Model</span>
                    <select
                      aria-label={`${visibleHarness.label} model`}
                      data-testid="local-chat-model-picker"
                      value={session.selectedModelId ?? ""}
                      onChange={handleModelChange}
                      disabled={modelPickerDisabled}
                    >
                      <option value="">{modelDefaultLabel}</option>
                      {selectedModelUnsupported && (
                        <option value={session.selectedModelId ?? ""}>
                          Unsupported: {session.selectedModelId}
                        </option>
                      )}
                      {(visibleHarness.models ?? []).map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.label}
                          {model.id === visibleHarness.default_model_id
                            ? " (default)"
                            : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  {(visibleHarness.reasoning_efforts ?? []).length > 0 && (
                    <label className="hc-effort-picker">
                      <span>Effort</span>
                      <select
                        aria-label={`${visibleHarness.label} reasoning effort`}
                        data-testid="local-chat-effort-picker"
                        value={session.selectedReasoningEffort ?? ""}
                        onChange={handleReasoningEffortChange}
                        disabled={effortPickerDisabled}
                      >
                        <option value="">{effortDefaultLabel}</option>
                        {selectedReasoningEffortUnsupported && (
                          <option value={session.selectedReasoningEffort ?? ""}>
                            Unsupported: {session.selectedReasoningEffort}
                          </option>
                        )}
                        {(visibleHarness.reasoning_efforts ?? []).map(
                          (effort) => (
                            <option key={effort.id} value={effort.id}>
                              {effort.label}
                              {effort.id ===
                              visibleHarness.default_reasoning_effort
                                ? " (default)"
                                : ""}
                            </option>
                          )
                        )}
                      </select>
                    </label>
                  )}
                  {unavailableReason && (
                    <span
                      className="hc-provider-unavailable"
                      data-testid="local-chat-provider-unavailable"
                    >
                      {harnessDisplayName(visibleHarness.harness)} unavailable:{" "}
                      {unavailableReason}
                    </span>
                  )}
                </div>
              ) : null
            }
          />
        </div>
        <div
          className="hc-foot-meta"
          aria-hidden={usage && usage.max > 0 ? undefined : true}
        >
          {usage && usage.max > 0 ? (
            <span
              className="ctx-lbl"
              title={`${usage.used.toLocaleString()} / ${usage.max.toLocaleString()} current request input context tokens`}
            >
              context <b>{ctxPct}%</b>
              {session.model
                ? ` · ${session.model.replace(/^claude-/i, "")} · ${formatTokenCount(usage.used)}/${formatTokenCount(usage.max)}`
                : ""}
            </span>
          ) : (
            <span className="ctx-lbl">&nbsp;</span>
          )}
        </div>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocalChat } from "./useLocalChat";
import { commands } from "../bindings";
import type {
  LocalChatHarnessCatalog,
  LocalChatHarnessKind,
  PermissionMode,
} from "../bindings";
import {
  useChatStore,
  getLocalChatLifecycle,
  isLocalChatLifecycleBusy,
} from "../stores/chatStore";
import { utilizationLevel } from "../utils/modelContextWindow";
import {
  DEFAULT_LOCAL_CHAT_HARNESS,
  isLocalChatSessionCleared,
  loadLastUsedLocalChatModelId,
} from "../utils/localChatPersistence";
import {
  harnessDisplayName,
  lifecycleLabel,
  isSessionHarnessLocked,
} from "../components/ChatWindow/chatHelpers";

// ---------------------------------------------------------------------------
// useChatSession
// ---------------------------------------------------------------------------

export function useChatSession(sessionId: string) {
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

  // --- Harness catalog fetch ---
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

  // --- Derived harness state ---
  const selectedHarness = session?.harness ?? DEFAULT_LOCAL_CHAT_HARNESS;
  const lockedHarness = session ? isSessionHarnessLocked(session) : false;
  const selectedHarnessInfo = useMemo(
    () =>
      harnessCatalog?.harnesses.find(
        (item) => item.harness === selectedHarness
      ) ?? null,
    [harnessCatalog, selectedHarness]
  );
  const availableHarnesses = useMemo(
    () => harnessCatalog?.harnesses.filter((info) => info.available) ?? [],
    [harnessCatalog]
  );
  const fallbackHarness = useMemo(() => {
    if (!harnessCatalog) return null;
    return (
      harnessCatalog.harnesses.find(
        (item) =>
          item.harness === harnessCatalog.default_harness && item.available
      ) ??
      availableHarnesses[0] ??
      null
    );
  }, [availableHarnesses, harnessCatalog]);
  const visibleHarness = useMemo(() => {
    if (!harnessCatalog) return null;
    if (lockedHarness || selectedHarnessInfo?.available) {
      return selectedHarnessInfo;
    }

    return (
      fallbackHarness ??
      selectedHarnessInfo ??
      harnessCatalog.harnesses.find(
        (item) => item.harness === harnessCatalog.default_harness
      ) ??
      null
    );
  }, [fallbackHarness, harnessCatalog, lockedHarness, selectedHarnessInfo]);

  // A saved/default provider is only a preference until a session is started.
  // Keep locked sessions on their original provider so an unavailable harness
  // cannot be silently replaced during resume.
  useEffect(() => {
    if (!session || !harnessCatalog || lockedHarness) return;
    if (
      selectedHarnessInfo?.available ||
      !fallbackHarness ||
      fallbackHarness.harness === selectedHarness
    ) {
      return;
    }
    setSessionHarness(sessionId, fallbackHarness.harness);
  }, [
    fallbackHarness,
    harnessCatalog,
    lockedHarness,
    selectedHarness,
    selectedHarnessInfo,
    session,
    sessionId,
    setSessionHarness,
  ]);

  const providerOptions = useMemo(() => {
    if (!harnessCatalog) return [];
    return harnessCatalog.harnesses
      .filter((info) => info.available)
      .map((info) => ({ info }));
  }, [harnessCatalog]);

  const supportedModelIds = useMemo(
    () => new Set((visibleHarness?.models ?? []).map((model) => model.id)),
    [visibleHarness]
  );
  const selectedModelId = session?.selectedModelId;
  const selectedReasoningEffort = session?.selectedReasoningEffort;
  const reasoningEfforts = useMemo(() => {
    const efforts = visibleHarness?.reasoning_efforts ?? [];
    const selectedModel = visibleHarness?.models.find(
      (model) => model.id === selectedModelId
    );
    const supportedEffortIds = selectedModel?.supported_reasoning_effort_ids;
    if (!supportedEffortIds) return efforts;

    const supportedEfforts = new Set(supportedEffortIds);
    return efforts.filter((effort) => supportedEfforts.has(effort.id));
  }, [selectedModelId, visibleHarness]);
  const supportedReasoningEffortIds = useMemo(
    () => new Set(reasoningEfforts.map((effort) => effort.id)),
    [reasoningEfforts]
  );

  // --- Lifecycle derived flags ---
  const lifecycle = getLocalChatLifecycle(session);
  const isBusy = isLocalChatLifecycleBusy(lifecycle);
  const canQueueMessage =
    !!session?.backendSessionId &&
    (lifecycle === "sending" || lifecycle === "streaming");
  const hasResume = !!session?.providerResumeId;
  const selectedHarnessAvailable =
    !harnessCatalog || selectedHarnessInfo?.available === true;
  const canUseComposer =
    selectedHarnessAvailable && (!isBusy || canQueueMessage);
  const canSendMessage = (isActive || canQueueMessage) && canUseComposer;
  const shouldStartOrResume = !isActive && canUseComposer;
  const hasSession = !!session;
  const hasConversation = !!session?.providerResumeId;
  const messageCount = session?.messages.length ?? 0;
  const hasAvailableHarness = !harnessCatalog || fallbackHarness !== null;

  // --- Persistence / sync effects ---
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

  // --- Display messages (with streaming overlay) ---
  const sessionMessages = session?.messages;
  const streamingAssistant = session?.streamingAssistant;
  const messages = useMemo(() => {
    if (!sessionMessages) return [];
    if (!streamingAssistant) return sessionMessages;
    const last = sessionMessages[sessionMessages.length - 1];
    if (
      last?.kind === "assistant" &&
      last.isPartial &&
      !last.parentToolUseId &&
      last.text === streamingAssistant.text
    ) {
      return sessionMessages;
    }
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

  const hasStreamingOverlay = !!streamingAssistant;
  const isWaiting =
    (lifecycle === "sending" ||
      lifecycle === "streaming" ||
      (isActive && lifecycle !== "error")) &&
    !hasStreamingOverlay &&
    messages.length > 0 &&
    messages[messages.length - 1].kind === "user";

  const assistantLabel = session
    ? harnessDisplayName(session.harness)
    : "Assistant";

  // --- Stop generation ---
  const canStopGeneration =
    !!session?.backendSessionId &&
    (lifecycle === "starting" ||
      lifecycle === "resuming" ||
      lifecycle === "sending" ||
      lifecycle === "streaming" ||
      isActive);

  const handleStopGeneration = useCallback(async () => {
    if (!session?.backendSessionId) return;
    await closeLocalChatSession({ markClosed: false });
  }, [closeLocalChatSession, session?.backendSessionId]);

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

  // --- Action callbacks ---
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

  // --- Composer labels ---
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

  // --- Context utilization ---
  const usage = session?.tokenUsage ?? null;
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

  return {
    // session
    session,
    isActive,
    lifecycle,
    isBusy,
    canQueueMessage,
    canUseComposer,
    canSendMessage,
    shouldStartOrResume,
    hasResume,
    selectedHarnessAvailable,
    submitLabel,
    composerPlaceholder,
    canStopGeneration,
    hasStreamingOverlay,
    isWaiting,

    // harness catalog
    harnessCatalog,
    visibleHarness,
    providerOptions,
    hasAvailableHarness,
    supportedModelIds,
    reasoningEfforts,
    supportedReasoningEffortIds,
    selectedModelId,
    selectedReasoningEffort,
    lockedHarness,

    // messages
    messages,
    assistantLabel,

    // context utilization
    usage,
    ctxPct,
    ctxColor,

    // input
    inputValue,
    setInputValue,

    // actions
    handleSend,
    handleStartSession,
    handleClearMessages,
    handleStopGeneration,
    handleModelChange,
    handleReasoningEffortChange,
    handleHarnessChange,
    handlePermissionModeChange,

    // passthrough from useLocalChat
    startSession,
    sendMessage,
  };
}

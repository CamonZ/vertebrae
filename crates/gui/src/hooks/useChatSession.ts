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
  hasStaleModelDefault,
  hasStaleReasoningEffort,
  resolvePermissionDefault,
  useLocalChatDefaultsStore,
} from "../utils/localChatDefaults";
import {
  harnessDisplayName,
  lifecycleLabel,
  isSessionHarnessLocked,
} from "../components/ChatWindow/chatHelpers";
import { recordLocalChatTrace } from "../utils/localChatDebug";

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
    stopActiveTurn,
    regenerateTitle,
    isTitleRegenerating,
    titleError,
  } = useLocalChat(sessionId);

  const clearMessages = useChatStore((s) => s.clearMessages);
  const setSessionManualTitle = useChatStore(
    (s) => s.setSessionManualTitle
  );
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
  const localChatDefaults = useLocalChatDefaultsStore((s) => s.defaults);

  // --- Harness catalog fetch ---
  useEffect(() => {
    let cancelled = false;
    void commands
      .getSupportedLocalChatHarnesses()
      .then((result) => {
        if (!cancelled && result.status === "ok") {
          setHarnessCatalog(result.data);
        }
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
  const savedHarnessDefaults = localChatDefaults[selectedHarness];
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
  const hasPendingUserQuestion =
    session?.messages.some(
      (message) =>
        message.kind === "user_question" && message.status === "pending"
    ) ?? false;
  const canQueueMessage =
    !!session?.backendSessionId &&
    (lifecycle === "sending" || lifecycle === "streaming");
  const hasResume = !!session?.providerResumeId;
  const selectedHarnessAvailable =
    !harnessCatalog || selectedHarnessInfo?.available === true;
  const canUseComposer =
    !hasPendingUserQuestion &&
    selectedHarnessAvailable &&
    (!isBusy || canQueueMessage);
  const canSendMessage = (isActive || canQueueMessage) && canUseComposer;
  const shouldStartOrResume = !isActive && canUseComposer;
  const hasSession = !!session;
  const hasConversation = !!session?.providerResumeId;
  const messageCount = session?.messages.length ?? 0;
  const hasAvailableHarness = !harnessCatalog || fallbackHarness !== null;

  // --- Persistence / sync effects ---
  useEffect(() => {
    if (!hasSession || !visibleHarness || lockedHarness || hasConversation) {
      return;
    }
    if (messageCount > 0) return;

    // A saved setting is only an initial value. A user choice already made in
    // this empty session must win over a later settings-page update.
    if (
      selectedModelId === undefined &&
      savedHarnessDefaults?.modelId &&
      !hasStaleModelDefault(visibleHarness, savedHarnessDefaults.modelId)
    ) {
      setSessionSelectedModel(sessionId, savedHarnessDefaults.modelId);
    }

    if (
      session?.permissionMode === "default" &&
      savedHarnessDefaults?.permissionMode
    ) {
      const resolvedPermission = resolvePermissionDefault(
        visibleHarness,
        savedHarnessDefaults.permissionMode
      );
      if (
        resolvedPermission === savedHarnessDefaults.permissionMode &&
        resolvedPermission !== session.permissionMode
      ) {
        setSessionPermissionMode(sessionId, resolvedPermission);
      }
    }

    if (
      selectedReasoningEffort === undefined &&
      savedHarnessDefaults?.reasoningEffort &&
      !hasStaleReasoningEffort(
        visibleHarness,
        savedHarnessDefaults.reasoningEffort,
        selectedModelId
      ) &&
      supportedReasoningEffortIds.has(savedHarnessDefaults.reasoningEffort)
    ) {
      setSessionReasoningEffort(
        sessionId,
        savedHarnessDefaults.reasoningEffort
      );
    }
  }, [
    hasConversation,
    hasSession,
    lockedHarness,
    messageCount,
    savedHarnessDefaults,
    selectedModelId,
    selectedReasoningEffort,
    session?.permissionMode,
    sessionId,
    setSessionPermissionMode,
    setSessionReasoningEffort,
    setSessionSelectedModel,
    supportedReasoningEffortIds,
    visibleHarness,
  ]);

  useEffect(() => {
    if (!hasSession || !visibleHarness) return;
    if (isLocalChatSessionCleared(sessionId)) return;
    if (selectedModelId !== undefined) return;
    if (hasConversation || messageCount > 0) return;

    // Prefer the explicit per-harness setting over the legacy last-used model
    // preference. Invalid stored settings intentionally fall through so the
    // existing behavior remains safe and unchanged.
    if (
      savedHarnessDefaults?.modelId &&
      !hasStaleModelDefault(visibleHarness, savedHarnessDefaults.modelId)
    ) {
      return;
    }

    const lastUsed = loadLastUsedLocalChatModelId();
    if (lastUsed && supportedModelIds.has(lastUsed)) {
      setSessionSelectedModel(sessionId, lastUsed);
    }
  }, [
    visibleHarness,
    hasConversation,
    hasSession,
    messageCount,
    savedHarnessDefaults,
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

  // Durable history and the ephemeral streaming response stay separate so a
  // streaming delta does not change the historical messages array identity.
  const messages = session?.messages ?? [];
  const streamingAssistant = session?.streamingAssistant ?? null;

  const activeTurn = session?.activeTurn ?? null;
  const isWaiting = activeTurn !== null || session?.compactionActive === true;
  const activityLabel = session?.compactionActive
    ? "Compacting conversation…"
    : activeTurn?.phase === "stopping"
      ? "Stopping..."
      : "Thinking...";

  const assistantLabel = session
    ? harnessDisplayName(session.harness)
    : "Assistant";

  // --- Stop generation ---
  // "closing" covers a Clear that is already tearing this backend session
  // down; without it Stop stays live and issues a second concurrent close.
  const canStopGeneration =
    !!session?.backendSessionId &&
    lifecycle !== "closing" &&
    activeTurn !== null &&
    activeTurn.phase !== "stopping";

  const handleStopGeneration = useCallback(async () => {
    await stopActiveTurn();
  }, [stopActiveTurn]);

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
    if (!trimmed) return;
    if (!canSendMessage) {
      recordLocalChatTrace({
        source: "gui",
        kind: "composer.submit.dropped",
        sessionId,
        backendSessionId: session?.backendSessionId,
        state: lifecycle,
        detail: `can_send=false; active=${isActive}; queue=${canQueueMessage}; busy=${isBusy}; pending_question=${hasPendingUserQuestion}`,
        payload: trimmed,
      });
      return;
    }
    void sendMessage(trimmed);
    setInputValue("");
  }, [
    canQueueMessage,
    canSendMessage,
    hasPendingUserQuestion,
    inputValue,
    isActive,
    isBusy,
    lifecycle,
    sendMessage,
    session?.backendSessionId,
    sessionId,
  ]);

  const handleStartSession = useCallback(() => {
    const initialPrompt = inputValue.trim();
    recordLocalChatTrace({
      source: "gui",
      kind: "composer.start.submitted",
      sessionId,
      backendSessionId: session?.backendSessionId,
      state: lifecycle,
      payload: initialPrompt || undefined,
    });
    void startSession(initialPrompt || undefined);
    setInputValue("");
  }, [inputValue, lifecycle, session?.backendSessionId, sessionId, startSession]);

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

  const handleTitleSave = useCallback(
    (title: string) => {
      setSessionManualTitle(sessionId, title);
    },
    [sessionId, setSessionManualTitle]
  );

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
  const composerPlaceholder = hasPendingUserQuestion
    ? "Answer Claude's question above to continue..."
    : canQueueMessage
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
    isWaiting,
    activityLabel,
    compactionSummary: session?.compactionSummary ?? null,
    hasPendingUserQuestion,

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
    streamingAssistant,
    assistantLabel,

    // context utilization
    usage,
    threadTotalTokens: session?.threadTotalTokens,
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
    handleTitleSave,
    handleRegenerateTitle: regenerateTitle,
    isTitleRegenerating,
    titleError,
    handleModelChange,
    handleReasoningEffortChange,
    handleHarnessChange,
    handlePermissionModeChange,

    // passthrough from useLocalChat
    startSession,
    sendMessage,
  };
}

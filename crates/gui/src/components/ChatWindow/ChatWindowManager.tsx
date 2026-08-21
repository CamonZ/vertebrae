import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import { useChatStore } from "../../stores/chatStore";
import type { ChatSession } from "../../stores/chatStore";
import { useGlassPanel } from "../../hooks/useGlassPanel";
import { usePanelExitTransition } from "../../hooks/usePanelExitTransition";
import { doCloseSession } from "../../hooks/useLocalChat";
import { useChatPanelLayout } from "../../hooks/useChatPanelLayout";
import { useChatKeyboardShortcuts } from "../../hooks/useChatKeyboardShortcuts";
import { useLocalChatHistory } from "../../hooks/useLocalChatHistory";
import { useChatPaneManagement } from "../../hooks/useChatPaneManagement";
import { usePanelLayoutStore } from "../../stores/panelLayoutStore";
import { ChatPaneList } from "./ChatPaneList";
import { ChatResizeHandle } from "./ChatResizeHandle";
import { LocalChatMiniPanel } from "./LocalChatMiniPanel";
import { ChatShortcutHints } from "./ChatShortcutHints";
import {
  buildSpawnOutline,
  isAgentSpawnTool,
  scrollToSpawn,
} from "./sessionListUtils";
import type { SpawnOutlineItem } from "./sessionListUtils";

/** Exit-animation duration (ms). Must match `.hc-panel.is-closing` (--t-base). */
const EXIT_MS = 180;

/**
 * ChatWindowManager manages multiple chat session tabs in a floating-glass side
 * panel anchored on the right (design reference `.hc-panel`, opened by the
 * FloatingChatLauncher pill). Renders the active session's ChatWindow, which
 * owns the single header band (title + status) and the composer.
 */
export function ChatWindowManager() {
  const sessions = useChatStore((s) => s.sessions);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const panelOpen = useChatStore((s) => s.panelOpen);
  const togglePanel = useChatStore((s) => s.togglePanel);
  const selectPersistedSession = useChatStore((s) => s.selectPersistedSession);
  const selectProviderThreadSession = useChatStore(
    (s) => s.selectProviderThreadSession
  );
  const deleteLocalSession = useChatStore((s) => s.deleteLocalSession);
  const startFreshSession = useChatStore((s) => s.startFreshSession);
  const startFreshSessionInNewPane = useChatStore(
    (s) => s.startFreshSessionInNewPane
  );
  const focusPane = useChatStore((s) => s.focusPane);
  const closePane = useChatStore((s) => s.closePane);
  const unsplitPanes = useChatStore((s) => s.unsplitPanes);
  const markSessionClosed = useChatStore((s) => s.markSessionClosed);
  const setSessionLifecycle = useChatStore((s) => s.setSessionLifecycle);
  const setBackendSessionId = useChatStore((s) => s.setBackendSessionId);
  const clearQueuedMessages = useChatStore((s) => s.clearQueuedMessages);
  const localSessionSummaries = useChatStore((s) => s.localSessionSummaries);

  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(
    null
  );
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const sessionList = Object.values(sessions);
  const sessionChangeToken = Object.values(localSessionSummaries)
    .map(
      (session) =>
        `${session.id}:${session.projectPath ?? ""}:${session.updatedAt ?? ""}:${
          session.title ?? ""
        }:${session.providerResumeId ?? ""}:${session.lifecycle}`
    )
    .join("\0");
  const activeSession: ChatSession | null = activeSessionId
    ? sessions[activeSessionId]
    : null;
  const spawnOutlineToken = sessionList
    .map((session) =>
      session.messages
        .filter(
          (
            message
          ): message is Extract<
            ChatSession["messages"][number],
            { kind: "tool_call" }
          > =>
            message.kind === "tool_call" &&
            !message.parentToolUseId &&
            isAgentSpawnTool(message.toolName)
        )
        .map((message) => `${session.id}:${message.toolId}:${message.input}`)
        .join("\0")
    )
    .join("\0");
  const spawnOutlineBySessionId = useMemo(() => {
    const outlines = new Map<string, ReturnType<typeof buildSpawnOutline>>();
    for (const session of sessionList) {
      const outline = buildSpawnOutline(session.messages).filter(
        (spawn) => spawn.threadId !== session.providerResumeId
      );
      outlines.set(session.id, outline);
    }
    return outlines;
    // Intentionally keyed by top-level agent tool-call inputs only; assistant
    // streaming text should not re-render the mini-panel outline.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spawnOutlineToken]);
  const childProviderThreadIds = useMemo(() => {
    const threadIds = new Set<string>();
    for (const session of sessionList) {
      const outline = spawnOutlineBySessionId.get(session.id) ?? [];
      for (const spawn of outline) {
        if (spawn.threadId && spawn.threadId !== session.providerResumeId) {
          threadIds.add(spawn.threadId);
        }
      }
    }
    return threadIds;
  }, [sessionList, spawnOutlineBySessionId]);

  const {
    panelRef,
    isMaximized,
    isResizing,
    renderedPanelWidth,
    toggleMaximized,
    resizePanel,
    startResizeDrag,
    collapseMaximized,
  } = useChatPanelLayout({ unsplitPanes });

  const {
    loadCurrentProjectPath,
    commitCurrentProjectPath,
    allLocalSessionGroups,
    localSessionGroups,
    sessionQuery,
    setSessionQuery,
    projectGroupingWarning,
    bumpHistoryRevision,
  } = useLocalChatHistory({ sessionChangeToken });
  const visibleLocalSessionGroups = useMemo(
    () =>
      localSessionGroups
        .map((group) => ({
          ...group,
          sessions: group.sessions.filter(
            (session) =>
              !session.providerResumeId ||
              !childProviderThreadIds.has(session.providerResumeId)
          ),
        }))
        .filter((group) => group.sessions.length > 0),
    [childProviderThreadIds, localSessionGroups]
  );
  const hasLocalChatSessions = useMemo(
    () =>
      allLocalSessionGroups.some((group) =>
        group.sessions.some(
          (session) =>
            !session.providerResumeId ||
            !childProviderThreadIds.has(session.providerResumeId)
        )
      ),
    [allLocalSessionGroups, childProviderThreadIds]
  );

  const {
    visiblePanes,
    activePaneId,
    canAddSplitPane,
    focusPaneByIndex,
    focusPaneByOffset,
    closeActivePane,
    keepOnlyActivePane,
  } = useChatPaneManagement({
    isMaximized,
    renderedPanelWidth,
    activeSession,
  });

  const open = panelOpen && sessionList.length > 0;
  const setChatLayout = usePanelLayoutStore((s) => s.setChatLayout);
  const clearChatLayout = usePanelLayoutStore((s) => s.clearChatLayout);

  useEffect(() => {
    if (!open) setShortcutsOpen(false);
  }, [open]);

  const closeChatPanel = useCallback(() => {
    togglePanel();
  }, [togglePanel]);

  const startFreshActiveSession = useCallback(async () => {
    if (!activeSession) return false;
    const projectPath = await loadCurrentProjectPath();
    commitCurrentProjectPath(projectPath);
    startFreshSession("New Chat", projectPath);
    return true;
  }, [
    activeSession,
    commitCurrentProjectPath,
    loadCurrentProjectPath,
    startFreshSession,
  ]);

  const splitWithFreshSession = useCallback(async () => {
    if (!canAddSplitPane) return false;
    const projectPath = await loadCurrentProjectPath();
    if (!canAddSplitPane) return false;
    commitCurrentProjectPath(projectPath);
    startFreshSessionInNewPane("New Chat", projectPath);
    return true;
  }, [
    canAddSplitPane,
    commitCurrentProjectPath,
    loadCurrentProjectPath,
    startFreshSessionInNewPane,
  ]);

  const toggleHistorySelector = useCallback(() => {
    if (!isMaximized) {
      toggleMaximized();
    }
    // Focus the mini panel after maximize renders it.
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>('[data-testid="local-chat-mini-panel"]')
        ?.focus();
    });
    return true;
  }, [isMaximized, toggleMaximized]);

  const selectHistorySessionForActivePane = useCallback(
    async (sessionId: string) => {
      setDeleteError(null);
      const selected = await selectPersistedSession(sessionId);
      if (!selected) {
        bumpHistoryRevision();
      }
      return selected;
    },
    [bumpHistoryRevision, selectPersistedSession]
  );

  const selectAgentThreadForActivePane = useCallback(
    async (parentSessionId: string, agent: SpawnOutlineItem) => {
      const parent = useChatStore.getState().sessions[parentSessionId];
      if (!parent || !agent.threadId) {
        await selectHistorySessionForActivePane(parentSessionId);
        requestAnimationFrame(() =>
          scrollToSpawn(parentSessionId, agent.spawnId)
        );
        return null;
      }
      setDeleteError(null);
      return selectProviderThreadSession({
        harness: parent.harness,
        providerResumeId: agent.threadId,
        projectPath: parent.projectPath ?? null,
        label: agent.label,
        title: agent.label,
        model: parent.model ?? parent.selectedModelId ?? null,
      });
    },
    [selectHistorySessionForActivePane, selectProviderThreadSession]
  );

  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      setDeleteError(null);
      const target = useChatStore.getState().sessions[sessionId];
      if (target?.backendSessionId) {
        setDeletingSessionId(sessionId);
        const closed = await doCloseSession(
          target.backendSessionId,
          sessionId,
          {
            markSessionClosed,
            setSessionLifecycle,
            setBackendSessionId,
            clearQueuedMessages,
          }
        );
        setDeletingSessionId(null);
        if (!closed) {
          setDeleteError("Could not delete local chat. Try again.");
          return;
        }
      }
      deleteLocalSession(sessionId);
      bumpHistoryRevision();
    },
    [
      bumpHistoryRevision,
      deleteLocalSession,
      markSessionClosed,
      setBackendSessionId,
      clearQueuedMessages,
      setSessionLifecycle,
    ]
  );

  useChatKeyboardShortcuts({
    open,
    dispatch: {
      shortcutsOpen,
      canAddSplitPane,
      hasActiveSession: !!activeSession,
      focusPaneByIndex,
      focusPaneByOffset,
      closeActivePane,
      keepOnlyActivePane,
      splitWithFreshSession,
      startFreshActiveSession,
      toggleHistorySelector,
      toggleMaximized,
    },
    setShortcutsOpen,
  });

  // Join the shared glass-panel focus model so Escape closes whichever panel is
  // focused. The chat is globally mounted; it's "open" only while showing.
  const shouldHandleChatPanelEscape = useCallback(() => {
    const activeElement = document.activeElement;
    if (
      activeElement instanceof HTMLInputElement &&
      activeElement.closest("[data-mini-history-search]") &&
      activeElement.value
    ) {
      return false;
    }
    return true;
  }, []);
  const { isFocused, focusProps } = useGlassPanel({
    id: "chat",
    isOpen: open,
    onClose: closeChatPanel,
    shouldHandleEscape: shouldHandleChatPanelEscape,
  });

  // Defer unmount so the panel can drill back out to the edge on close. Sessions
  // persist in the store through the close, so content stays put while it exits.
  const { mounted, closing, onAnimationEnd } = usePanelExitTransition(
    open,
    EXIT_MS
  );

  // Publish before paint so every page-local FloatingDetailPanel follows the
  // chat width without a visible frame at the old right inset. `mounted` stays
  // true through exit, keeping adjacent panels stable until chat is gone.
  useLayoutEffect(() => {
    setChatLayout({
      isPresent: mounted,
      renderedWidth: mounted ? renderedPanelWidth : 0,
      isMaximized: mounted && isMaximized,
    });
  }, [isMaximized, mounted, renderedPanelWidth, setChatLayout]);

  useEffect(() => () => clearChatLayout(), [clearChatLayout]);

  // Wide state is restored only after the exit surface disappears. Collapsing
  // earlier would shrink the chat and move an adjacent panel during drill-out.
  useEffect(() => {
    if (!mounted) collapseMaximized();
  }, [collapseMaximized, mounted]);

  if (!mounted) {
    return null;
  }

  return (
    <div
      ref={panelRef}
      className={`hc-panel${closing ? " is-closing" : ""}`}
      style={{ width: `${renderedPanelWidth}px` }}
      data-testid="chat-window-manager"
      data-focused={isFocused || undefined}
      data-closing={closing || undefined}
      data-maximized={isMaximized || undefined}
      data-resizing={isResizing || undefined}
      onAnimationEnd={onAnimationEnd}
      {...focusProps}
    >
      <ChatResizeHandle
        renderedPanelWidth={renderedPanelWidth}
        isResizing={isResizing}
        startResizeDrag={startResizeDrag}
        resizePanel={resizePanel}
      />
      {visiblePanes.length > 0 && (
        <div className="hc-panel-main">
          {isMaximized && (
            <LocalChatMiniPanel
              activeSessionId={activeSessionId ?? visiblePanes[0].sessionId}
              activeProviderThreadId={activeSession?.providerResumeId ?? null}
              searchQuery={sessionQuery}
              onSearchQueryChange={setSessionQuery}
              hasLocalChatSessions={hasLocalChatSessions}
              sessionGroups={visibleLocalSessionGroups}
              spawnOutlineBySessionId={spawnOutlineBySessionId}
              projectWarning={projectGroupingWarning}
              onSelect={(sessionId) => {
                selectHistorySessionForActivePane(sessionId);
              }}
              onSelectAgent={(sessionId, agent) => {
                void selectAgentThreadForActivePane(sessionId, agent);
              }}
              deletingSessionId={deletingSessionId}
              deleteError={deleteError}
              onDelete={(sessionId) => void handleDeleteSession(sessionId)}
            />
          )}
          <ChatPaneList
            visiblePanes={visiblePanes}
            sessions={sessions}
            activePaneId={activePaneId}
            isMaximized={isMaximized}
            canAddSplitPane={canAddSplitPane}
            focusPane={focusPane}
            closePane={closePane}
            unsplitPanes={unsplitPanes}
            closeChatPanel={closeChatPanel}
            toggleHistorySelector={toggleHistorySelector}
            toggleMaximized={toggleMaximized}
            startFreshActiveSession={startFreshActiveSession}
            splitWithFreshSession={splitWithFreshSession}
          />
        </div>
      )}
      {shortcutsOpen && (
        <ChatShortcutHints onClose={() => setShortcutsOpen(false)} />
      )}
    </div>
  );
}

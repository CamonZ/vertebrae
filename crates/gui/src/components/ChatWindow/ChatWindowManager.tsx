import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import { useChatStore } from "../../stores/chatStore";
import { useGlassPanel } from "../../hooks/useGlassPanel";
import { usePanelExitTransition } from "../../hooks/usePanelExitTransition";
import { doCloseSession } from "../../hooks/useLocalChat";
import { useChatPanelLayout } from "../../hooks/useChatPanelLayout";
import {
  clampHistoryWidthForLayout,
  maxHistoryWidthForLayout,
  useChatHistoryPanelLayout,
} from "../../hooks/useChatHistoryPanelLayout";
import { useChatKeyboardShortcuts } from "../../hooks/useChatKeyboardShortcuts";
import { useLocalChatHistory } from "../../hooks/useLocalChatHistory";
import { useChatPaneManagement } from "../../hooks/useChatPaneManagement";
import { usePanelLayoutStore } from "../../stores/panelLayoutStore";
import {
  projectLocalChatSessionGroups,
  type LocalChatSessionGroup,
} from "../../utils/localChatSessionGroups";
import { normalizeProjectPath } from "../../utils/localChatPersistence";
import { ChatPaneList } from "./ChatPaneList";
import { ChatResizeHandle } from "./ChatResizeHandle";
import { ChatHistoryResizeHandle } from "./ChatHistoryResizeHandle";
import { LocalChatMiniPanel } from "./LocalChatMiniPanel";
import type { LocalChatSessionActivity } from "./LocalChatMiniPanel";
import { ChatShortcutHints } from "./ChatShortcutHints";
import { buildSpawnOutline, scrollToSpawn } from "./sessionListUtils";
import type { SpawnOutlineItem } from "./sessionListUtils";
import { useUIStore } from "../../stores/uiStore";

/** Exit-animation duration (ms). Must match `.hc-panel.is-closing` (--t-base). */
const EXIT_MS = 180;

/**
 * ChatWindowManager manages multiple chat session tabs in a floating-glass side
 * panel anchored on the right (design reference `.hc-panel`, opened by the
 * FloatingChatLauncher pill). Renders the active session's ChatWindow, which
 * owns the single header band (title + status) and the composer.
 */
export function ChatWindowManager({
  renderObserver,
}: {
  renderObserver?: (paneId: string, part: "transcript" | "composer") => void;
}) {
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const activeProviderThreadId = useChatStore((s) =>
    s.activeSessionId
      ? (s.sessions[s.activeSessionId]?.providerResumeId ?? null)
      : null
  );
  const sessionIdsToken = useChatStore((s) =>
    Object.keys(s.sessions).join("\0")
  );
  const activityRevisions = useChatStore((s) => s.activityRevisions);
  const spawnOutlineRevisions = useChatStore((s) => s.spawnOutlineRevisions);
  const panelOpen = useChatStore((s) => s.panelOpen);
  const togglePanel = useChatStore((s) => s.togglePanel);
  const selectPersistedSession = useChatStore((s) => s.selectPersistedSession);
  const selectProviderThreadSession = useChatStore(
    (s) => s.selectProviderThreadSession
  );
  const deleteLocalSession = useChatStore((s) => s.deleteLocalSession);
  const startFreshSession = useChatStore((s) => s.startFreshSession);
  const bindPaneToSession = useChatStore((s) => s.bindPaneToSession);
  const openProjectSession = useChatStore((s) => s.openProjectSession);
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
  const thinkingIndicatorStyle = useUIStore(
    (state) => state.thinkingIndicatorStyle
  );

  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(
    null
  );
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const sessionList = useMemo(
    () => sessionIdsToken.split("\0").filter(Boolean),
    [sessionIdsToken]
  );
  const sessionActivityToken = sessionList
    .map((sessionId) => `${sessionId}:${activityRevisions[sessionId] ?? 0}`)
    .join("\0");
  const activityBySessionId = useMemo(() => {
    const activity = new Map<string, LocalChatSessionActivity>();
    for (const sessionId of sessionList) {
      const session = useChatStore.getState().sessions[sessionId];
      if (!session) continue;
      if (session.compactionActive) {
        activity.set(session.id, "compacting");
      } else if (session.activeTurn?.phase === "stopping") {
        activity.set(session.id, "stopping");
      } else if (session.activeTurn) {
        activity.set(session.id, "thinking");
      }
    }
    return activity;
    // Streaming text can update `sessions` without changing row activity.
    // Keep the map stable so the history panel does not re-render per delta.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionActivityToken]);
  const sessionChangeToken = Object.values(localSessionSummaries)
    .map(
      (session) =>
        `${session.id}:${session.projectPath ?? ""}:${session.updatedAt ?? ""}:${
          session.title ?? ""
        }:${session.providerResumeId ?? ""}:${session.lifecycle}`
    )
    .join("\0");
  const spawnOutlineToken = sessionList
    .map((sessionId) => `${sessionId}:${spawnOutlineRevisions[sessionId] ?? 0}`)
    .join("\0");
  const spawnOutlineBySessionId = useMemo(() => {
    const outlines = new Map<string, ReturnType<typeof buildSpawnOutline>>();
    for (const sessionId of sessionList) {
      const session = useChatStore.getState().sessions[sessionId];
      if (!session) continue;
      const outline = buildSpawnOutline(session.messages).filter(
        (spawn) => spawn.threadId !== session.providerResumeId
      );
      outlines.set(session.id, outline);
    }
    return outlines;
    // Intentionally keyed by top-level agent tool-call inputs only; assistant
    // streaming text should not re-render the mini-panel outline.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionList, spawnOutlineToken]);
  const childProviderThreadIds = useMemo(() => {
    const threadIds = new Set<string>();
    for (const sessionId of sessionList) {
      const session = useChatStore.getState().sessions[sessionId];
      if (!session) continue;
      const outline = spawnOutlineBySessionId.get(sessionId) ?? [];
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
  const { historyWidth, resizeHistoryWidth } = useChatHistoryPanelLayout();

  const {
    loadCurrentProjectPath,
    commitCurrentProjectPath,
    allLocalSessionGroups,
    localSessionGroups,
    sessionQuery,
    setSessionQuery,
    projectGroupingWarning,
    projectLabelsByPath,
    bumpHistoryRevision,
  } = useLocalChatHistory({ sessionChangeToken });
  const projectLabelBySessionId = useMemo(() => {
    const labels = new Map<string, string>();
    for (const group of allLocalSessionGroups) {
      for (const session of group.allSessions ?? group.sessions) {
        labels.set(session.id, group.label);
      }
    }
    for (const session of Object.values(localSessionSummaries)) {
      if (labels.has(session.id)) continue;
      const path = normalizeProjectPath(session.projectPath);
      const label = path ? projectLabelsByPath.get(path) : undefined;
      if (label) labels.set(session.id, label);
    }
    return labels;
  }, [allLocalSessionGroups, localSessionSummaries, projectLabelsByPath]);
  const visibleLocalSessionGroups = useMemo(() => {
    // Search and child-thread filtering must precede the cap so older
    // matching sessions remain eligible for the visible seven rows.
    const childFilteredGroups = localSessionGroups
      .map((group) => ({
        ...group,
        sessions: group.sessions.filter(
          (session) =>
            !session.providerResumeId ||
            !childProviderThreadIds.has(session.providerResumeId)
        ),
      }))
      .filter((group) => group.sessions.length > 0);
    return projectLocalChatSessionGroups(childFilteredGroups);
  }, [childProviderThreadIds, localSessionGroups]);
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
    normalizedPaneLayout,
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
    activeSessionId,
  });
  const historyMaxWidth = maxHistoryWidthForLayout(
    renderedPanelWidth,
    visiblePanes.length
  );
  const effectiveHistoryWidth = clampHistoryWidthForLayout(
    historyWidth,
    renderedPanelWidth,
    visiblePanes.length
  );
  // The panel can be open briefly before the launcher finishes checking
  // durable history, and it can show a resume choice without any runtime
  // session loaded yet.
  const open = panelOpen;
  const setChatLayout = usePanelLayoutStore((s) => s.setChatLayout);
  const clearChatLayout = usePanelLayoutStore((s) => s.clearChatLayout);

  useEffect(() => {
    if (!open) setShortcutsOpen(false);
  }, [open]);

  const closeChatPanel = useCallback(() => {
    togglePanel();
  }, [togglePanel]);

  const startFreshActiveSession = useCallback(
    async (paneId: string) => {
      const projectPath = await loadCurrentProjectPath();
      const paneStillVisible = useChatStore
        .getState()
        .paneLayout.panes.some((pane) => pane.id === paneId);
      if (!paneStillVisible) return false;
      commitCurrentProjectPath(projectPath);
      const sessionId = startFreshSession("New Chat", projectPath);
      return bindPaneToSession(paneId, sessionId);
    },
    [
      bindPaneToSession,
      commitCurrentProjectPath,
      loadCurrentProjectPath,
      startFreshSession,
    ]
  );

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

  const startProjectChat = useCallback(
    (group: LocalChatSessionGroup) => {
      if (!group.projectId || !group.projectPath) {
        setDeleteError(
          `Cannot start a chat in ${group.label}: project directory unavailable`
        );
        return;
      }
      try {
        openProjectSession("New Chat", group.projectPath);
        setDeleteError(null);
      } catch (error) {
        setDeleteError(
          error instanceof Error
            ? error.message
            : `Could not start a chat in ${group.label}`
        );
      }
    },
    [openProjectSession]
  );

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
    async (sessionId: string, preferredPaneId?: string) => {
      setDeleteError(null);
      const selected = await selectPersistedSession(sessionId, preferredPaneId);
      if (!selected) {
        bumpHistoryRevision();
      }
      return selected;
    },
    [bumpHistoryRevision, selectPersistedSession]
  );

  const focusHistorySearch = useCallback(() => {
    if (!isMaximized) return false;
    const input = document.querySelector<HTMLInputElement>(
      "#local-chat-session-search"
    );
    if (!input) return false;
    input.focus();
    return true;
  }, [isMaximized]);

  const selectHistorySessionByOffset = useCallback(
    async (offset: number) => {
      if (!isMaximized) return false;
      const sessionItems = visibleLocalSessionGroups.flatMap(
        (group) => group.sessions
      );
      if (sessionItems.length === 0) return false;
      const currentIndex = sessionItems.findIndex(
        (session) => session.id === activeSessionId
      );
      const nextIndex =
        currentIndex < 0
          ? offset < 0
            ? sessionItems.length - 1
            : 0
          : (currentIndex + offset + sessionItems.length) % sessionItems.length;
      return selectHistorySessionForActivePane(
        sessionItems[nextIndex].id,
        normalizedPaneLayout.panes.some((pane) => pane.id === activePaneId)
          ? (activePaneId ?? undefined)
          : undefined
      );
    },
    [
      activeSessionId,
      activePaneId,
      isMaximized,
      normalizedPaneLayout,
      selectHistorySessionForActivePane,
      visibleLocalSessionGroups,
    ]
  );

  const selectAgentThreadForActivePane = useCallback(
    async (
      parentSessionId: string,
      agent: SpawnOutlineItem,
      preferredPaneId?: string
    ) => {
      const targetPaneId =
        preferredPaneId ??
        useChatStore.getState().paneLayout.activePaneId ??
        undefined;
      const parent = useChatStore.getState().sessions[parentSessionId];
      if (!parent || !agent.threadId) {
        await selectHistorySessionForActivePane(parentSessionId, targetPaneId);
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
        preferredPaneId: targetPaneId,
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

  const startFreshActiveSessionForKeyboard = useCallback(() => {
    const paneId = activePaneId ?? normalizedPaneLayout.panes[0]?.id;
    return paneId ? startFreshActiveSession(paneId) : Promise.resolve(false);
  }, [activePaneId, normalizedPaneLayout.panes, startFreshActiveSession]);

  useChatKeyboardShortcuts({
    open,
    dispatch: {
      shortcutsOpen,
      canAddSplitPane,
      hasActiveSession: !!activeSessionId,
      focusPaneByIndex,
      focusPaneByOffset,
      historyNavigationEnabled: isMaximized,
      focusHistorySearch,
      selectHistorySessionByOffset,
      closeActivePane,
      keepOnlyActivePane,
      splitWithFreshSession,
      startFreshActiveSession: startFreshActiveSessionForKeyboard,
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
              width={effectiveHistoryWidth}
              activeSessionId={activeSessionId ?? visiblePanes[0].sessionId}
              activeProviderThreadId={activeProviderThreadId}
              searchQuery={sessionQuery}
              onSearchQueryChange={setSessionQuery}
              hasLocalChatSessions={hasLocalChatSessions}
              sessionGroups={visibleLocalSessionGroups}
              spawnOutlineBySessionId={spawnOutlineBySessionId}
              activityBySessionId={activityBySessionId}
              thinkingIndicatorStyle={thinkingIndicatorStyle}
              projectWarning={projectGroupingWarning}
              onSelect={(sessionId) => {
                selectHistorySessionForActivePane(sessionId);
              }}
              onSelectAgent={(sessionId, agent) => {
                void selectAgentThreadForActivePane(sessionId, agent);
              }}
              onStartProjectChat={startProjectChat}
              deletingSessionId={deletingSessionId}
              deleteError={deleteError}
              onDelete={(sessionId) => void handleDeleteSession(sessionId)}
            />
          )}
          {isMaximized && (
            <ChatHistoryResizeHandle
              historyWidth={effectiveHistoryWidth}
              maxWidth={historyMaxWidth}
              onResize={resizeHistoryWidth}
            />
          )}
          <ChatPaneList
            visiblePanes={visiblePanes}
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
            projectLabelBySessionId={projectLabelBySessionId}
            renderObserver={renderObserver}
          />
        </div>
      )}
      {shortcutsOpen && (
        <ChatShortcutHints onClose={() => setShortcutsOpen(false)} />
      )}
    </div>
  );
}

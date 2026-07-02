import { useCallback, useEffect, useState } from "react";
import { useChatStore } from "../../stores/chatStore";
import type { ChatSession } from "../../stores/chatStore";
import { useGlassPanel } from "../../hooks/useGlassPanel";
import { usePanelExitTransition } from "../../hooks/usePanelExitTransition";
import { doCloseSession } from "../../hooks/useLocalChat";
import { useChatPanelLayout } from "../../hooks/useChatPanelLayout";
import { useChatKeyboardShortcuts } from "../../hooks/useChatKeyboardShortcuts";
import { useLocalChatHistory } from "../../hooks/useLocalChatHistory";
import { useChatPaneManagement } from "../../hooks/useChatPaneManagement";
import { ChatPaneList } from "./ChatPaneList";
import { ChatResizeHandle } from "./ChatResizeHandle";
import { LocalChatMiniPanel } from "./LocalChatMiniPanel";
import { ChatShortcutHints } from "./ChatShortcutHints";

/** Exit-animation duration (ms). Must match `.hc-panel.is-closing` (--t-base). */
const EXIT_MS = 180;

/**
 * ChatWindowManager manages multiple chat session tabs in a floating-glass side
 * panel anchored bottom-left (design reference `.hc-panel`, opened by the
 * FloatingChatLauncher pill). Renders the active session's ChatWindow, which
 * owns the single header band (title + status) and the composer.
 */
export function ChatWindowManager() {
  const sessions = useChatStore((s) => s.sessions);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const panelOpen = useChatStore((s) => s.panelOpen);
  const togglePanel = useChatStore((s) => s.togglePanel);
  const reattachSession = useChatStore((s) => s.reattachSession);
  const selectPersistedSession = useChatStore((s) => s.selectPersistedSession);
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

  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(
    null
  );
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const sessionList = Object.values(sessions);
  const sessionChangeToken = sessionList
    .map(
      (session) =>
        `${session.id}:${session.projectPath ?? ""}:${session.updatedAt ?? ""}:${
          session.title ?? ""
        }:${session.messages.length}`
    )
    .join("\0");
  const activeSession: ChatSession | null = activeSessionId
    ? sessions[activeSessionId]
    : null;

  const {
    panelRef,
    isMaximized,
    isResizing,
    renderedPanelWidth,
    toggleMaximized,
    resizePanel,
    startResizeDrag,
    collapseMaximized,
  } = useChatPanelLayout({ unsplitPanes, panelOpen });

  const {
    loadCurrentProjectPath,
    commitCurrentProjectPath,
    localSessionGroups,
    projectGroupingWarning,
    bumpHistoryRevision,
  } = useLocalChatHistory({ sessionChangeToken });

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

  useEffect(() => {
    if (!open) setShortcutsOpen(false);
  }, [open]);

  const closeChatPanel = useCallback(() => {
    collapseMaximized();
    togglePanel();
  }, [collapseMaximized, togglePanel]);

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
    (sessionId: string) => {
      setDeleteError(null);
      const selected = selectPersistedSession(sessionId);
      if (!selected) {
        bumpHistoryRevision();
      }
      return selected;
    },
    [bumpHistoryRevision, selectPersistedSession]
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
            setBackendSessionIdRef: () => {},
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
  const { isFocused, focusProps } = useGlassPanel({
    id: "chat",
    isOpen: open,
    onClose: closeChatPanel,
  });

  // Defer unmount so the panel can drill back out to the edge on close. Sessions
  // persist in the store through the close, so content stays put while it exits.
  const { mounted, closing, onAnimationEnd } = usePanelExitTransition(
    open,
    EXIT_MS
  );

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
              sessionGroups={localSessionGroups}
              projectWarning={projectGroupingWarning}
              onStartFresh={() => {
                void startFreshActiveSession().then((started) => {
                  if (started) {
                    collapseMaximized();
                  }
                });
              }}
              onSelect={(sessionId) => {
                selectHistorySessionForActivePane(sessionId);
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
            reattachSession={reattachSession}
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

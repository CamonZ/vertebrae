import { loadMainChatWorktree } from "../../utils/chatAssociation/defaultWorktree";
import { moveChatArea } from "./chatAreas";
import { getProjectScopeGeneration } from "../../stores/projectScopedStores";
import { commands } from "../../bindings";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { isRunPane, useChatStore } from "../../stores/chatStore";
import { useGlassPanel } from "../../hooks/useGlassPanel";
import { usePanelExitTransition } from "../../hooks/usePanelExitTransition";
import { doCloseSession } from "../../hooks/useLocalChat";
import { useChatPanelLayout } from "../../hooks/useChatPanelLayout";
import {
  clampHistoryWidthForLayout,
  maxHistoryWidthForLayout,
  useChatHistoryPanelLayout,
} from "../../hooks/useChatHistoryPanelLayout";
import {
  useChatKeyboardShortcuts,
  type ShortcutDispatchState,
} from "../../hooks/useChatKeyboardShortcuts";
import {
  WorkspaceCommandsContext,
  type WorkspaceCommands,
} from "./chatPaletteCommands";
import { WorkspaceChromeContext } from "./WorkspaceChromeContext";
import { useChildChatSessions } from "../../hooks/useChildChatSessions";
import { useLocalChatHistory } from "../../hooks/useLocalChatHistory";
import { useChatPaneManagement } from "../../hooks/useChatPaneManagement";
import { usePanelLayoutStore } from "../../stores/panelLayoutStore";
import {
  selectedLocalChatProject,
  type LocalChatSessionGroup,
} from "../../utils/localChatSessionGroups";
import { normalizeProjectPath } from "../../utils/localChatPersistence";
import { ChatPaneList, type SideColumnControls } from "./ChatPaneList";
import { ChatTabStrip } from "./ChatTabStrip";
import { chatsNeedingYou, useChatTabs } from "./useChatTabs";
import { ChatResizeHandle } from "./ChatResizeHandle";
import { ChatHistoryResizeHandle } from "./ChatHistoryResizeHandle";
import { LocalChatMiniPanel } from "./LocalChatMiniPanel";
import type { LocalChatSessionActivity } from "./LocalChatMiniPanel";
import { ChatShortcutHints } from "./ChatShortcutHints";
import { scrollToSpawn } from "./sessionListUtils";
import { useHistorySidebarModel } from "./useHistorySidebarModel";
import type { SpawnOutlineItem } from "./sessionListUtils";
import { useUIStore } from "../../stores/uiStore";
import { useNotificationStore } from "../../stores/notificationStore";

/** Exit-animation duration (ms). Must match `.hc-panel.is-closing` (--t-base). */
const EXIT_MS = 180;

/**
 * The main worktree for a fresh chat in `projectPath`, or null when the
 * project scope changed while it loaded (the chat would land in the wrong
 * project). Shared by every fresh-chat entry point.
 */
async function loadFreshChatWorktree(
  projectPath: string | null,
  generation = getProjectScopeGeneration()
) {
  const mainWorktree = await loadMainChatWorktree(projectPath);
  return generation === getProjectScopeGeneration() ? { mainWorktree } : null;
}

/** Whether workspace entry `paneId` is still open. */
function isOpenEntry(paneId: string) {
  return useChatStore
    .getState()
    .paneLayout.order.some((pane) => pane.id === paneId);
}

/**
 * ChatWindowManager hosts the chat workspace in a floating-glass side panel
 * anchored on the right (design reference `.hc-panel`, opened by the
 * FloatingChatLauncher pill): the tab strip over the open chats with the
 * active one below it, plus the mini history when expanded. Each chat's
 * ChatWindow owns its header band and composer.
 */
export function ChatWindowManager({
  renderObserver,
}: {
  renderObserver?: (paneId: string, part: "transcript" | "composer") => void;
}) {
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const activeProjectPath = useChatStore((s) =>
    s.activeSessionId ? s.sessions[s.activeSessionId]?.projectPath : null
  );
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
  const startFreshSessionInNewTab = useChatStore(
    (s) => s.startFreshSessionInNewTab
  );
  const openSessionInNewTab = useChatStore((s) => s.openSessionInNewTab);
  const focusPane = useChatStore((s) => s.focusPane);
  const openRunPane = useChatStore((s) => s.openRunPane);
  const closePane = useChatStore((s) => s.closePane);
  const moveChatBefore = useChatStore((s) => s.moveChatBefore);
  const markSessionClosed = useChatStore((s) => s.markSessionClosed);
  const setSessionLifecycle = useChatStore((s) => s.setSessionLifecycle);
  const setBackendSessionId = useChatStore((s) => s.setBackendSessionId);
  const clearQueuedMessages = useChatStore((s) => s.clearQueuedMessages);
  const localSessionSummaries = useChatStore((s) => s.localSessionSummaries);
  const thinkingIndicatorStyle = useUIStore(
    (state) => state.thinkingIndicatorStyle
  );

  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [historyVisible, setHistoryVisible] = useState(true);
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
  const discoveredChildOutlines = useChildChatSessions(
    `${sessionIdsToken}\0${sessionActivityToken}\0${sessionList
      .map((id) => {
        const session = useChatStore.getState().sessions[id];
        return `${session?.harness}:${session?.providerResumeId}:${session?.projectPath}`;
      })
      .join("\0")}`,
    panelOpen
  );

  const {
    panelRef,
    isMaximized,
    isResizing,
    isWindowResizing,
    renderedPanelWidth,
    toggleMaximized,
    toggleFromShortcut,
    dismissMaximized,
    resizePanel,
    startResizeDrag,
    collapseMaximized,
  } = useChatPanelLayout();
  const { historyWidth, resizeHistoryWidth } = useChatHistoryPanelLayout();

  const {
    loadCurrentProjectPath,
    commitCurrentProjectPath,
    allLocalSessionGroups,
    projectsReady,
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

  const historyProjectGroups = useMemo(
    () =>
      allLocalSessionGroups.map((group) => ({
        ...group,
        // Search retains child titles until ancestor matching has run.
        // Association corrections regroup immediately even if the index lags.
        sessions: group.sessions.map(
          (session) => localSessionSummaries[session.id] ?? session
        ),
      })),
    [allLocalSessionGroups, localSessionSummaries]
  );
  // Browsing belongs to the manager's mounted lifetime, independent of pane routing.
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null
  );
  const [hasBrowsedProject, setHasBrowsedProject] = useState(false);
  const selectHistoryProject = useCallback((projectId: string) => {
    setHasBrowsedProject(true);
    setSelectedProjectId(projectId);
  }, []);
  const selectedProject = selectedLocalChatProject(
    historyProjectGroups,
    selectedProjectId,
    activeSessionId,
    activeProjectPath
  );

  useEffect(() => {
    if (
      projectsReady &&
      isMaximized &&
      panelOpen &&
      selectedProject &&
      selectedProject.id !== selectedProjectId
    ) {
      setSelectedProjectId(selectedProject.id);
    }
  }, [
    projectsReady,
    isMaximized,
    panelOpen,
    selectedProject,
    selectedProjectId,
  ]);

  const [revealSession, setRevealSession] = useState<{
    sessionId: string;
    revision: number;
  } | null>(null);

  const selectHistoryProjectByOffset = useCallback(
    (offset: number) => {
      if (!isMaximized || !historyProjectGroups.length) return false;

      const index = historyProjectGroups.findIndex(
        (group) => group.id === selectedProject?.id
      );
      const next =
        (Math.max(0, index) + offset + historyProjectGroups.length) %
        historyProjectGroups.length;
      selectHistoryProject(historyProjectGroups[next].id);

      return true;
    },
    [historyProjectGroups, isMaximized, selectedProject, selectHistoryProject]
  );

  const workspaceOrder = useChatStore((s) => s.paneLayout.order);
  const tabs = useChatTabs(workspaceOrder, projectLabelBySessionId);
  const needingYou = useMemo(() => chatsNeedingYou(tabs), [tabs]);
  const {
    shownPane,
    focusPaneByIndex,
    focusPaneByOffset,
    focusNeedingYou,
    activatePane,
    closeActivePane,
    moveActivePane,
  } = useChatPaneManagement({ needingYou });
  const shownPaneId = shownPane?.id ?? null;
  const {
    visibleHistoryGroups,
    spawnOutlineBySessionId,
    childProviderThreadIds,
    nestedHistoryIds,
    matchingHistorySessions,
    completedHistoryIds,
    hiddenCompletedCount,
    showCompletedHistory,
    setShowCompletedHistory,
    historyLoad,
  } = useHistorySidebarModel({
    visible: panelOpen && isMaximized && historyVisible && !!shownPane,
    selectedProject,
    historyProjectGroups,
    sessionList,
    spawnOutlineToken,
    discoveredChildOutlines,
    sessionQuery,
  });

  // Name the chat's project in its header once the open chats span more
  // than one project.
  const openChatsSpanProjects =
    new Set(tabs.flatMap((tab) => (tab.project ? [tab.project] : []))).size > 1;
  const activeRunPane = isRunPane(shownPane) ? shownPane : null;
  const historyMaxWidth = maxHistoryWidthForLayout(renderedPanelWidth);
  const effectiveHistoryWidth = clampHistoryWidthForLayout(
    historyWidth,
    renderedPanelWidth
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
    dismissMaximized();
    togglePanel();
  }, [dismissMaximized, togglePanel]);

  /**
   * The current project and its main worktree for a fresh chat, or null when
   * the project scope changed (or `paneId` closed) while they loaded.
   */
  const loadFreshChatTarget = useCallback(
    async (paneId: string | null) => {
      const generation = getProjectScopeGeneration();
      const projectPath = await loadCurrentProjectPath();
      const loaded = await loadFreshChatWorktree(projectPath, generation);
      if (!loaded) return null;
      if (paneId !== null && !isOpenEntry(paneId)) return null;
      commitCurrentProjectPath(projectPath);
      return { projectPath, mainWorktree: loaded.mainWorktree };
    },
    [commitCurrentProjectPath, loadCurrentProjectPath]
  );

  const startFreshActiveSession = useCallback(
    async (paneId: string) => {
      const target = await loadFreshChatTarget(paneId);
      if (!target) return false;
      const sessionId = startFreshSession(
        "New Chat",
        target.projectPath,
        target.mainWorktree
      );
      return bindPaneToSession(paneId, sessionId);
    },
    [bindPaneToSession, loadFreshChatTarget, startFreshSession]
  );

  /** ⌘⌥\ and the strip's "+": a fresh chat right after the active one. */
  const openFreshChat = useCallback(async () => {
    const target = await loadFreshChatTarget(null);
    if (!target) return false;
    startFreshSessionInNewTab(
      "New Chat",
      target.projectPath,
      target.mainWorktree
    );
    return true;
  }, [loadFreshChatTarget, startFreshSessionInNewTab]);

  const startProjectChat = useCallback(
    async (group: LocalChatSessionGroup) => {
      if (!group.projectId || !group.projectPath) {
        setDeleteError(
          `Cannot start a chat in ${group.label}: project directory unavailable`
        );
        return;
      }
      try {
        const loaded = await loadFreshChatWorktree(group.projectPath);
        if (!loaded) return;
        openProjectSession("New Chat", group.projectPath, loaded.mainWorktree);
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
    setHistoryVisible(true);

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

  const toggleHistoryVisibility = useCallback(() => {
    if (!isMaximized) {
      toggleHistorySelector();

      return;
    }

    if (
      historyVisible &&
      document.activeElement?.closest(
        ".hc-mini-history, .hc-history-resize-handle"
      )
    ) {
      panelRef.current
        ?.querySelector<HTMLElement>('[data-testid="chat-pane"]')
        ?.focus();
    }

    setHistoryVisible((visible) => !visible);
  }, [historyVisible, isMaximized, panelRef, toggleHistorySelector]);

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

    const focusSearch = () => {
      document
        .querySelector<HTMLInputElement>("#local-chat-session-search")
        ?.focus();
    };

    if (!historyVisible) {
      setHistoryVisible(true);
      requestAnimationFrame(focusSearch);
    } else {
      focusSearch();
    }

    return true;
  }, [historyVisible, isMaximized]);

  const selectHistorySessionByOffset = useCallback(
    async (offset: number) => {
      if (!isMaximized) return false;

      const sessionItems = matchingHistorySessions;

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
      const sessionId = sessionItems[nextIndex].id;

      setRevealSession((current) => ({
        sessionId,
        revision: (current?.revision ?? 0) + 1,
      }));

      return selectHistorySessionForActivePane(
        sessionId,
        shownPaneId ?? undefined
      );
    },
    [
      activeSessionId,
      shownPaneId,
      isMaximized,
      selectHistorySessionForActivePane,
      matchingHistorySessions,
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
        useChatStore.getState().paneLayout.activeId ??
        undefined;
      if (agent.sessionId) {
        await selectHistorySessionForActivePane(agent.sessionId, targetPaneId);
        return null;
      }

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
        providerId: parent.providerId ?? null,
        providerResumeId: agent.threadId,
        ownerSessionId: parentSessionId,
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
    (sessionId: string) => {
      setDeleteError(null);

      const reportCloseFailure = () => {
        try {
          useNotificationStore.getState().addNotification({
            message:
              "The chat was deleted, but some session cleanup may have failed.",
            type: "error",
            entity: "application",
            entityId: `local-chat-close-${sessionId}`,
          });
        } catch (error) {
          console.error("Could not report local chat close failure", error);
        }
      };

      void deleteLocalSession(sessionId, async (target) => {
        const closed = await doCloseSession(
          target.backendSessionId!,
          target.id,
          {
            markSessionClosed,
            setSessionLifecycle,
            setBackendSessionId,
            clearQueuedMessages,
          }
        );
        if (!closed) throw new Error("Provider session close failed");
      })
        .catch(reportCloseFailure)
        .finally(bumpHistoryRevision);
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

  const startFreshActiveSessionForKeyboard = useCallback(async () => {
    const paneId = shownPaneId;
    if (!paneId) return false;

    // Capture the browsed project and pane before validating its directory.
    const project =
      isMaximized && hasBrowsedProject && selectedProjectId
        ? historyProjectGroups.find((group) => group.id === selectedProjectId)
        : null;
    if (!project) return startFreshActiveSession(paneId);

    const unavailable = `Cannot start a chat in ${project.label}: project directory unavailable. Restore the directory or update the saved project path.`;
    const generation = getProjectScopeGeneration();
    try {
      const projectPath = normalizeProjectPath(project.projectPath);
      if (!projectPath) throw new Error(unavailable);
      const roots = await commands.getLocalFileRoots(projectPath);
      if (generation !== getProjectScopeGeneration()) return false;
      if (roots.status !== "ok") throw new Error(unavailable);
      const loaded = await loadFreshChatWorktree(projectPath, generation);
      if (!loaded || !isOpenEntry(paneId)) return false;
      const sessionId = openProjectSession(
        "New Chat",
        projectPath,
        loaded.mainWorktree
      );
      setDeleteError(null);
      return bindPaneToSession(paneId, sessionId);
    } catch {
      if (isOpenEntry(paneId)) setDeleteError(unavailable);
      return false;
    }
  }, [
    shownPaneId,
    isMaximized,
    selectedProjectId,
    hasBrowsedProject,
    historyProjectGroups,
    startFreshActiveSession,
    openProjectSession,
    bindPaneToSession,
  ]);

  const sideColumns = useRef(new Map<string, SideColumnControls>());
  const registerSideColumn = useCallback(
    (paneId: string, controls: SideColumnControls | null) => {
      if (controls) sideColumns.current.set(paneId, controls);
      else sideColumns.current.delete(paneId);
    },
    []
  );
  const shownSideColumn = () =>
    shownPaneId ? sideColumns.current.get(shownPaneId) : undefined;

  const paneFinds = useRef(new Map<string, () => boolean>());
  const registerPaneFind = useCallback(
    (paneId: string, openFind: (() => boolean) | null) => {
      if (openFind) paneFinds.current.set(paneId, openFind);
      else paneFinds.current.delete(paneId);
    },
    []
  );

  const dispatch: ShortcutDispatchState = {
    shortcutsOpen,
    hasActiveSession: !!activeSessionId,
    toggleExpanded: toggleFromShortcut,
    focusPaneByIndex,
    focusPaneByOffset,
    focusNeedingYou,
    moveActivePane,
    focusAreaByOffset: (offset) => moveChatArea(document.activeElement, offset),
    openFreshChat,
    closeActivePane,
    historyNavigationEnabled: isMaximized,
    focusHistorySearch,
    openPaneFind: () => {
      const openFind = shownPaneId
        ? paneFinds.current.get(shownPaneId)
        : undefined;
      return openFind ? openFind() : false;
    },
    selectHistorySessionByOffset,
    selectHistoryProjectByOffset,
    startFreshActiveSession: startFreshActiveSessionForKeyboard,
    toggleHistorySelector,
    toggleHistoryVisibility,
    toggleSideColumn: () => shownSideColumn()?.toggle() ?? false,
    toggleSideSection: (section) =>
      shownSideColumn()?.toggleSection(section) ?? false,
  };
  useChatKeyboardShortcuts({ open, dispatch, setShortcutsOpen });
  // ⌘K entries run the same handlers as the keys (decision 49d12c2c §4.1).
  const workspaceCommands = useRef<WorkspaceCommands | null>(null);
  useLayoutEffect(() => {
    workspaceCommands.current = {
      ...dispatch,
      openShortcutSheet: () => setShortcutsOpen(true),
    };
  });
  const getWorkspaceCommands = useCallback(
    () => workspaceCommands.current!,
    []
  );

  const workspaceChrome = useMemo(
    () => ({
      expanded: isMaximized,
      onToggleExpanded: toggleMaximized,
      onToggleHistory: toggleHistoryVisibility,
    }),
    [isMaximized, toggleMaximized, toggleHistoryVisibility]
  );

  // Join the shared glass-panel focus model so Escape closes whichever panel is
  // focused. The chat is globally mounted; it's "open" only while showing.
  const shouldHandleChatPanelEscape = useCallback(() => {
    const activeElement = document.activeElement;
    // Escape in a pane's find bar closes the bar, not the panel.
    if (activeElement?.closest("[data-pane-find]")) return false;
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
  // Only the mounted → unmounted transition collapses: opening the closed
  // panel straight into expanded (a run opened in chat) must stay expanded.
  const wasMountedRef = useRef(mounted);
  useEffect(() => {
    const wasMounted = wasMountedRef.current;
    wasMountedRef.current = mounted;
    if (wasMounted && !mounted) collapseMaximized();
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
      data-resizing={isResizing || isWindowResizing || undefined}
      onAnimationEnd={onAnimationEnd}
      {...focusProps}
    >
      <ChatResizeHandle
        renderedPanelWidth={renderedPanelWidth}
        isResizing={isResizing}
        startResizeDrag={startResizeDrag}
        resizePanel={resizePanel}
      />
      {shownPane && (
        <div className="hc-panel-main">
          {isMaximized && historyVisible && (
            <LocalChatMiniPanel
              width={effectiveHistoryWidth}
              activeSessionId={
                isRunPane(shownPane)
                  ? ""
                  : (activeSessionId ?? shownPane.sessionId)
              }
              activeRunId={activeRunPane?.runId ?? null}
              activeProviderThreadId={activeProviderThreadId}
              searchQuery={sessionQuery}
              onSearchQueryChange={setSessionQuery}
              selectedProjectId={selectedProject?.id ?? null}
              onSelectProject={selectHistoryProject}
              revealSession={revealSession}
              sessionGroups={visibleHistoryGroups}
              excludedProviderThreadIds={childProviderThreadIds}
              nestedSessionIds={nestedHistoryIds}
              completedSessionIds={completedHistoryIds}
              hiddenCompletedCount={hiddenCompletedCount}
              showCompleted={showCompletedHistory}
              onShowCompletedChange={setShowCompletedHistory}
              historyLoad={historyLoad}
              spawnOutlineBySessionId={spawnOutlineBySessionId}
              activityBySessionId={activityBySessionId}
              thinkingIndicatorStyle={thinkingIndicatorStyle}
              projectWarning={projectGroupingWarning}
              onSelect={(sessionId) => {
                selectHistorySessionForActivePane(sessionId);
              }}
              onOpenInNewTab={(sessionId) => {
                setDeleteError(null);
                void openSessionInNewTab(sessionId).then((opened) => {
                  if (!opened) bumpHistoryRevision();
                });
              }}
              onSelectAgent={(sessionId, agent) => {
                void selectAgentThreadForActivePane(sessionId, agent);
              }}
              onSelectRun={(row) => {
                openRunPane({ taskId: row.taskId, runId: row.id });
              }}
              onSelectRunStep={(row, executionId) => {
                openRunPane(
                  { taskId: row.taskId, runId: row.id },
                  { scrollToThreadId: executionId }
                );
              }}
              onStartProjectChat={startProjectChat}
              deleteError={deleteError}
              onDelete={(sessionId) => void handleDeleteSession(sessionId)}
            />
          )}
          {isMaximized && historyVisible && (
            <ChatHistoryResizeHandle
              historyWidth={effectiveHistoryWidth}
              maxWidth={historyMaxWidth}
              onResize={resizeHistoryWidth}
            />
          )}
          <div className="hc-workspace">
            <ChatTabStrip
              tabs={tabs}
              activeId={shownPaneId}
              expanded={isMaximized}
              needingYou={needingYou}
              historyVisible={historyVisible}
              onSelect={focusPane}
              onEnterChat={activatePane}
              onClose={closePane}
              onMoveBefore={moveChatBefore}
              onFreshChat={() => void openFreshChat()}
              onToggleExpanded={toggleMaximized}
              onToggleHistory={toggleHistoryVisibility}
              onNextNeedingYou={() => focusNeedingYou(1)}
            />
            <WorkspaceCommandsContext.Provider value={getWorkspaceCommands}>
              <WorkspaceChromeContext.Provider value={workspaceChrome}>
                <ChatPaneList
                  registerSideColumn={registerSideColumn}
                  registerPaneFind={registerPaneFind}
                  shownPane={shownPane}
                  tabPanels={isMaximized}
                  focusPane={focusPane}
                  closeChatPanel={closeChatPanel}
                  startFreshActiveSession={startFreshActiveSession}
                  showProjectContext={openChatsSpanProjects}
                  projectLabelBySessionId={projectLabelBySessionId}
                  renderObserver={renderObserver}
                />
              </WorkspaceChromeContext.Provider>
            </WorkspaceCommandsContext.Provider>
          </div>
        </div>
      )}
      {shortcutsOpen && (
        <ChatShortcutHints onClose={() => setShortcutsOpen(false)} />
      )}
    </div>
  );
}

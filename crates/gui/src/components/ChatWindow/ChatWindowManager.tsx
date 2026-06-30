import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { commands } from "../../bindings";
import type { SavedProject } from "../../bindings";
import {
  MAX_CHAT_PANES,
  normalizePaneLayout,
  useChatStore,
} from "../../stores/chatStore";
import type { ChatMessage, ChatPane, ChatSession } from "../../stores/chatStore";
import { useProjectScopeGeneration } from "../../stores/projectScopedStores";
import type { LocalChatSessionSummary } from "../../utils/localChatPersistence";
import {
  groupLocalChatSessionsByProject,
  type LocalChatSessionGroup,
} from "../../utils/localChatSessionGroups";
import { useGlassPanel } from "../../hooks/useGlassPanel";
import { usePanelExitTransition } from "../../hooks/usePanelExitTransition";
import { doCloseSession } from "../../hooks/useLocalChat";
import { ChatWindow } from "./ChatWindow";

/** Floating chat-panel width: persistence key and clamp bounds (px). Mirrors
 * the task-detail panel's horizontal resize (TaskDetailPanel.tsx). */
const WIDTH_STORAGE_KEY = "chat-window-manager-width";
const MIN_PANEL_WIDTH = 320;
const MAX_PANEL_WIDTH = 760;
const DEFAULT_PANEL_WIDTH = 384;
const DEFAULT_PANEL_LEFT_INSET = 60;
const MAXIMIZED_RIGHT_INSET = 16;
const MIN_SPLIT_PANE_WIDTH = 360;
const MINI_HISTORY_WIDTH = 272;
/** Keyboard resize step (px) for the drag handle. */
const RESIZE_STEP = 16;
/** Exit-animation duration (ms). Must match `.hc-panel.is-closing` (--t-base). */
const EXIT_MS = 180;
const PROJECT_LOAD_WARNING =
  "Could not load saved projects. Showing current project chats only.";
const LOCAL_CHAT_SCROLL_TO_SPAWN_EVENT = "local-chat-scroll-to-spawn";

type ProjectLoadStatus = "idle" | "loaded" | "error";
const EMPTY_SAVED_PROJECTS: SavedProject[] = [];
type ShortcutDispatchState = {
  shortcutsOpen: boolean;
  canAddSplitPane: boolean;
  hasActiveSession: boolean;
  focusPaneByIndex: (index: number) => boolean;
  focusPaneByOffset: (offset: number) => boolean;
  closeActivePane: () => boolean;
  keepOnlyActivePane: () => boolean;
  splitWithFreshSession: () => Promise<boolean>;
  startFreshActiveSession: () => Promise<boolean>;
  toggleHistorySelector: () => boolean;
  toggleMaximized: () => void;
};
type SpawnOutlineItem = {
  id: string;
  label: string;
  detail: string;
};
const CHAT_SHORTCUT_SECTIONS = [
  {
    title: "Panel",
    shortcuts: [
      { keys: ["⌥", "⌥"], label: "Toggle chat" },
      { keys: ["⌘", "\\"], label: "Maximize or collapse" },
      { keys: ["⌘", "?"], label: "Show keyboard shortcuts" },
      { keys: ["Esc"], label: "Close hints or focused panel" },
    ],
  },
  {
    title: "Panes",
    shortcuts: [
      { keys: ["⌘", "⌥", "\\"], label: "Split pane" },
      { keys: ["⌘", "⇧", "⌥", "\\"], label: "Close active pane" },
      { keys: ["⌘", "⌥", "M"], label: "Keep only active pane" },
      { keys: ["⌘", "⌥", "←/→"], label: "Focus adjacent pane" },
      { keys: ["⌃", "Tab"], label: "Focus next pane" },
      { keys: ["⌘", "⌥", "1-6"], label: "Focus pane by number" },
    ],
  },
  {
    title: "Sessions",
    shortcuts: [
      { keys: ["⌘", "⇧", "⌥", "N"], label: "Fresh chat in active pane" },
      { keys: ["⌘", "⇧", "⌥", "H"], label: "History for active pane" },
      { keys: ["Enter"], label: "Send message" },
      { keys: ["⇧", "Enter"], label: "New line" },
    ],
  },
];

function minSplitLayoutWidth(paneCount: number): number {
  return MINI_HISTORY_WIDTH + MIN_SPLIT_PANE_WIDTH * paneCount;
}

function isShortcutHintsKey(event: KeyboardEvent): boolean {
  return (
    event.metaKey && event.shiftKey && (event.key === "?" || event.key === "/")
  );
}

function isBackslashShortcutKey(event: KeyboardEvent): boolean {
  return event.code === "Backslash" || event.key === "\\" || event.key === "|";
}

function isLetterShortcutKey(event: KeyboardEvent, code: string, key: string) {
  return event.code === code || event.key.toLowerCase() === key;
}

function paneNumberShortcutIndex(event: KeyboardEvent): number | null {
  const codeMatch = /^Digit([1-6])$/.exec(event.code);
  if (codeMatch) return Number(codeMatch[1]) - 1;
  const keyMatch = /^[1-6]$/.exec(event.key);
  return keyMatch ? Number(keyMatch[0]) - 1 : null;
}

/**
 * ChatWindowManager manages multiple chat session tabs in a floating-glass side
 * panel anchored bottom-left (design reference `.hc-panel`, opened by the
 * FloatingChatLauncher pill). Renders the active session's ChatWindow, which
 * owns the single header band (title + status) and the composer.
 */
export function ChatWindowManager() {
  const sessions = useChatStore((s) => s.sessions);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const paneLayout = useChatStore((s) => s.paneLayout);
  const panelOpen = useChatStore((s) => s.panelOpen);
  const togglePanel = useChatStore((s) => s.togglePanel);
  const reattachSession = useChatStore((s) => s.reattachSession);
  const listLocalSessions = useChatStore((s) => s.listLocalSessions);
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
  const projectScopeGeneration = useProjectScopeGeneration();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(
    null
  );
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [projectGroupingState, setProjectGroupingState] = useState<{
    generation: number;
    currentProjectPath: string | null;
    projects: SavedProject[];
    projectsStatus: ProjectLoadStatus;
  }>({
    generation: -1,
    currentProjectPath: null,
    projects: [],
    projectsStatus: "idle",
  });

  // Horizontal resize. The panel is left-anchored, so a drag on its right edge
  // widens it as the cursor moves right. We measure the panel's fixed left edge
  // from the DOM rather than assuming the inset value.
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelWidth, setPanelWidth] = useState<number>(() => {
    if (typeof window === "undefined") return DEFAULT_PANEL_WIDTH;
    const stored = parseInt(localStorage.getItem(WIDTH_STORAGE_KEY) ?? "", 10);
    return Number.isNaN(stored)
      ? DEFAULT_PANEL_WIDTH
      : Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, stored));
  });
  const [restoredPanelWidth, setRestoredPanelWidth] = useState(panelWidth);
  const [isMaximized, setIsMaximized] = useState(false);
  const [maximizedWidth, setMaximizedWidth] = useState(DEFAULT_PANEL_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [historyRevision, setHistoryRevision] = useState(0);
  const shortcutDispatchRef = useRef<ShortcutDispatchState | null>(null);

  useEffect(() => {
    if (typeof window !== "undefined" && !isMaximized) {
      localStorage.setItem(WIDTH_STORAGE_KEY, String(panelWidth));
    }
  }, [isMaximized, panelWidth]);

  useEffect(() => {
    if (panelOpen || !isMaximized) return;
    unsplitPanes();
    setPanelWidth(restoredPanelWidth);
    setIsMaximized(false);
  }, [isMaximized, panelOpen, restoredPanelWidth, unsplitPanes]);

  const computeMaximizedWidth = useCallback(() => {
    if (typeof window === "undefined") return MAX_PANEL_WIDTH;
    const leftEdge =
      panelRef.current?.getBoundingClientRect().left ??
      DEFAULT_PANEL_LEFT_INSET;
    return Math.max(
      MIN_PANEL_WIDTH,
      window.innerWidth - leftEdge - MAXIMIZED_RIGHT_INSET
    );
  }, []);

  const toggleMaximized = useCallback(() => {
    if (isMaximized) {
      unsplitPanes();
      setPanelWidth(restoredPanelWidth);
      setIsMaximized(false);
      return;
    }
    setRestoredPanelWidth(panelWidth);
    setMaximizedWidth(computeMaximizedWidth());
    setIsMaximized(true);
  }, [
    computeMaximizedWidth,
    isMaximized,
    panelWidth,
    restoredPanelWidth,
    unsplitPanes,
  ]);

  const resizePanel = useCallback(
    (nextWidth: number) => {
      const width = Math.min(
        MAX_PANEL_WIDTH,
        Math.max(MIN_PANEL_WIDTH, nextWidth)
      );
      unsplitPanes();
      setIsMaximized(false);
      setRestoredPanelWidth(width);
      setPanelWidth(width);
    },
    [unsplitPanes]
  );

  useEffect(() => {
    if (!isResizing) return;
    const onMove = (event: MouseEvent) => {
      const leftEdge = panelRef.current?.getBoundingClientRect().left ?? 0;
      resizePanel(event.clientX - leftEdge);
    };
    const onUp = () => setIsResizing(false);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "ew-resize";
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [isResizing, resizePanel]);

  useEffect(() => {
    if (!isMaximized) return;
    const updateMaximizedWidth = () =>
      setMaximizedWidth(computeMaximizedWidth());
    updateMaximizedWidth();
    window.addEventListener("resize", updateMaximizedWidth);
    return () => window.removeEventListener("resize", updateMaximizedWidth);
  }, [computeMaximizedWidth, isMaximized]);

  const loadCurrentProjectPath = useCallback(async () => {
    try {
      const result = await commands.getCurrentProjectPath();
      return result.status === "ok" && result.data ? result.data : null;
    } catch {
      return null;
    }
  }, []);

  const loadSavedProjects = useCallback(async () => {
    try {
      const result = await commands.getProjects();
      if (result.status === "ok") {
        return { projects: result.data, status: "loaded" as const };
      }
      console.warn("Failed to load saved projects for chat grouping", result);
    } catch (error) {
      console.warn("Failed to load saved projects for chat grouping", error);
    }
    return { projects: [], status: "error" as const };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([loadCurrentProjectPath(), loadSavedProjects()]).then(
      ([currentProjectPath, projectLoad]) => {
        if (!cancelled) {
          setProjectGroupingState((state) => ({
            generation: projectScopeGeneration,
            currentProjectPath,
            projects:
              projectLoad.status === "loaded"
                ? projectLoad.projects
                : state.projects,
            projectsStatus: projectLoad.status,
          }));
        }
      }
    );
    return () => {
      cancelled = true;
    };
  }, [loadCurrentProjectPath, loadSavedProjects, projectScopeGeneration]);

  const sessionList = Object.values(sessions);
  const sessionChangeToken = sessionList
    .map(
      (session) =>
        `${session.id}:${session.projectPath ?? ""}:${session.updatedAt ?? ""}:${
          session.messages.length
        }`
    )
    .join("\0");
  const activeSession = activeSessionId ? sessions[activeSessionId] : null;
  const normalizedPaneLayout = useMemo(
    () => normalizePaneLayout(paneLayout, sessions),
    [paneLayout, sessions]
  );
  const normalizedPanes = normalizedPaneLayout.panes;
  const fallbackPane = useMemo<ChatPane | null>(
    () =>
      activeSession
        ? {
            id: paneLayout.activePaneId ?? `single-${activeSession.id}`,
            sessionId: activeSession.id,
          }
        : null,
    [activeSession, paneLayout.activePaneId]
  );
  const visiblePanes = useMemo<ChatPane[]>(() => {
    if (isMaximized && normalizedPanes.length > 0) return normalizedPanes;
    return fallbackPane ? [fallbackPane] : [];
  }, [fallbackPane, isMaximized, normalizedPanes]);
  const activePaneId =
    normalizedPaneLayout.activePaneId &&
    visiblePanes.some((pane) => pane.id === normalizedPaneLayout.activePaneId)
      ? normalizedPaneLayout.activePaneId
      : (visiblePanes[0]?.id ?? null);
  const currentProjectPath =
    projectGroupingState.generation === projectScopeGeneration
      ? projectGroupingState.currentProjectPath
      : null;
  const projectsLoadFailed =
    projectGroupingState.generation === projectScopeGeneration &&
    projectGroupingState.projectsStatus === "error";
  const savedProjects =
    projectGroupingState.generation === projectScopeGeneration
      ? projectGroupingState.projects
      : EMPTY_SAVED_PROJECTS;
  const localSessionGroups = useMemo(() => {
    // Local chat history is localStorage-backed, so persisted-only deletes need
    // a React-side invalidation even when the in-memory session map is unchanged.
    void historyRevision;
    const summaries = listLocalSessions(
      projectsLoadFailed ? currentProjectPath : undefined
    );
    if (!sessionChangeToken && summaries.length === 0) return [];
    return groupLocalChatSessionsByProject(
      summaries,
      savedProjects,
      currentProjectPath
    );
  }, [
    currentProjectPath,
    historyRevision,
    listLocalSessions,
    projectsLoadFailed,
    savedProjects,
    sessionChangeToken,
  ]);
  const projectGroupingWarning = projectsLoadFailed
    ? PROJECT_LOAD_WARNING
    : null;

  const open = panelOpen && sessionList.length > 0;
  useEffect(() => {
    if (!open) setShortcutsOpen(false);
  }, [open]);

  const renderedPanelWidth = isMaximized ? maximizedWidth : panelWidth;
  const canAddSplitPane =
    isMaximized &&
    visiblePanes.length < MAX_CHAT_PANES &&
    renderedPanelWidth >= minSplitLayoutWidth(visiblePanes.length + 1);
  const closeChatPanel = useCallback(() => {
    if (isMaximized) {
      unsplitPanes();
      setPanelWidth(restoredPanelWidth);
      setIsMaximized(false);
    }
    togglePanel();
  }, [isMaximized, restoredPanelWidth, togglePanel, unsplitPanes]);
  const startFreshActiveSession = useCallback(async () => {
    if (!shortcutDispatchRef.current?.hasActiveSession) return false;
    const projectPath = await loadCurrentProjectPath();
    setProjectGroupingState((state) => ({
      generation: projectScopeGeneration,
      currentProjectPath: projectPath,
      projects: state.projects,
      projectsStatus: state.projectsStatus,
    }));
    startFreshSession("New Chat", projectPath);
    setHistoryOpen(false);
    return true;
  }, [loadCurrentProjectPath, projectScopeGeneration, startFreshSession]);
  const splitWithFreshSession = useCallback(async () => {
    if (!shortcutDispatchRef.current?.canAddSplitPane) return false;
    const projectPath = await loadCurrentProjectPath();
    if (!shortcutDispatchRef.current?.canAddSplitPane) return false;
    setProjectGroupingState((state) => ({
      generation: projectScopeGeneration,
      currentProjectPath: projectPath,
      projects: state.projects,
      projectsStatus: state.projectsStatus,
    }));
    startFreshSessionInNewPane("New Chat", projectPath);
    setHistoryOpen(false);
    return true;
  }, [
    loadCurrentProjectPath,
    projectScopeGeneration,
    startFreshSessionInNewPane,
  ]);
  const focusPaneByIndex = useCallback(
    (index: number) => {
      const pane = visiblePanes[index];
      if (!pane) return false;
      focusPane(pane.id);
      return true;
    },
    [focusPane, visiblePanes]
  );
  const focusPaneByOffset = useCallback(
    (offset: number) => {
      if (visiblePanes.length <= 1) return false;
      const currentIndex = Math.max(
        0,
        visiblePanes.findIndex((pane) => pane.id === activePaneId)
      );
      const nextIndex =
        (currentIndex + offset + visiblePanes.length) % visiblePanes.length;
      focusPane(visiblePanes[nextIndex].id);
      return true;
    },
    [activePaneId, focusPane, visiblePanes]
  );
  const closeActivePane = useCallback(() => {
    if (!isMaximized || visiblePanes.length <= 1 || !activePaneId) return false;
    closePane(activePaneId);
    return true;
  }, [activePaneId, closePane, isMaximized, visiblePanes.length]);
  const keepOnlyActivePane = useCallback(() => {
    if (!isMaximized || visiblePanes.length <= 1 || !activePaneId) return false;
    unsplitPanes(activePaneId);
    return true;
  }, [activePaneId, isMaximized, unsplitPanes, visiblePanes.length]);
  const toggleHistorySelector = useCallback(() => {
    if (isMaximized) {
      document
        .querySelector<HTMLElement>('[data-testid="local-chat-mini-panel"]')
        ?.focus();
      return true;
    }
    setHistoryOpen((value) => !value);
    return true;
  }, [isMaximized]);
  const selectHistorySessionForActivePane = useCallback(
    (sessionId: string) => {
      setDeleteError(null);
      const selected = selectPersistedSession(sessionId);
      if (!selected) {
        setHistoryRevision((revision) => revision + 1);
      }
      return selected;
    },
    [selectPersistedSession]
  );

  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      setDeleteError(null);
      const target = useChatStore.getState().sessions[sessionId];
      const wasActive = sessionId === useChatStore.getState().activeSessionId;
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
      setHistoryRevision((revision) => revision + 1);
      if (wasActive) {
        setHistoryOpen(false);
      }
    },
    [
      deleteLocalSession,
      markSessionClosed,
      setBackendSessionId,
      setSessionLifecycle,
    ]
  );

  shortcutDispatchRef.current = {
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
  };

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

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const dispatch = shortcutDispatchRef.current;
      if (!dispatch) return;
      const key = event.key.toLowerCase();

      if (isShortcutHintsKey(event)) {
        event.preventDefault();
        setShortcutsOpen((value) => !value);
        return;
      }

      if (key === "escape" && dispatch.shortcutsOpen) {
        event.preventDefault();
        setShortcutsOpen(false);
        return;
      }

      if (dispatch.shortcutsOpen) return;

      if (event.ctrlKey && key === "tab") {
        if (dispatch.focusPaneByOffset(event.shiftKey ? -1 : 1)) {
          event.preventDefault();
        }
        return;
      }

      if (!event.metaKey) return;

      if (isBackslashShortcutKey(event) && event.altKey && event.shiftKey) {
        if (dispatch.closeActivePane()) {
          event.preventDefault();
        }
        return;
      }

      if (isBackslashShortcutKey(event) && event.altKey) {
        if (!dispatch.canAddSplitPane) return;
        event.preventDefault();
        void dispatch.splitWithFreshSession();
        return;
      }

      if (isBackslashShortcutKey(event) && !event.shiftKey) {
        event.preventDefault();
        dispatch.toggleMaximized();
        return;
      }

      if (!event.altKey) return;

      if (key === "arrowright") {
        if (dispatch.focusPaneByOffset(1)) {
          event.preventDefault();
        }
        return;
      }
      if (key === "arrowleft") {
        if (dispatch.focusPaneByOffset(-1)) {
          event.preventDefault();
        }
        return;
      }
      const paneNumberIndex = paneNumberShortcutIndex(event);
      if (paneNumberIndex !== null) {
        if (dispatch.focusPaneByIndex(paneNumberIndex)) {
          event.preventDefault();
        }
        return;
      }
      if (isLetterShortcutKey(event, "KeyM", "m")) {
        if (dispatch.keepOnlyActivePane()) {
          event.preventDefault();
        }
        return;
      }
      if (isLetterShortcutKey(event, "KeyN", "n")) {
        if (!event.shiftKey || !dispatch.hasActiveSession) return;
        event.preventDefault();
        void dispatch.startFreshActiveSession();
        return;
      }
      if (isLetterShortcutKey(event, "KeyH", "h")) {
        if (!event.shiftKey) return;
        event.preventDefault();
        dispatch.toggleHistorySelector();
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open]);

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
      {/* Right-edge drag handle for horizontal resize */}
      <div
        className="hc-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        aria-valuenow={renderedPanelWidth}
        aria-valuemin={MIN_PANEL_WIDTH}
        aria-valuemax={MAX_PANEL_WIDTH}
        tabIndex={0}
        data-resizing={isResizing || undefined}
        data-testid="chat-resize-handle"
        onMouseDown={(event) => {
          event.preventDefault();
          setIsResizing(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") {
            resizePanel(renderedPanelWidth + RESIZE_STEP);
          } else if (event.key === "ArrowLeft") {
            resizePanel(renderedPanelWidth - RESIZE_STEP);
          }
        }}
      />
      {/* Chat windows own their header band, message thread, and composer.
          Maximized mode can render multiple independently bound panes. */}
      {visiblePanes.length > 0 && (
        <div className="hc-panel-main">
          {isMaximized && (
            <LocalChatMiniPanel
              activeSessionId={activeSessionId ?? visiblePanes[0].sessionId}
              activeSession={activeSession}
              sessionGroups={localSessionGroups}
              projectWarning={projectGroupingWarning}
              onStartFresh={() => void startFreshActiveSession()}
              onSelect={(sessionId) => {
                selectHistorySessionForActivePane(sessionId);
              }}
              deletingSessionId={deletingSessionId}
              deleteError={deleteError}
              onDelete={(sessionId) => void handleDeleteSession(sessionId)}
            />
          )}
          <div className="hc-chat-panes">
            {visiblePanes.map((pane, index) => {
              const session = sessions[pane.sessionId];
              if (!session) return null;
              const paneIsActive = pane.id === activePaneId;
              const paneCount = visiblePanes.length;
              return (
                <section
                  key={pane.id}
                  className="hc-chat-pane"
                  data-testid="chat-pane"
                  data-pane-active={paneIsActive || undefined}
                  aria-label={`Chat pane ${index + 1}: ${session.label}`}
                  aria-selected={paneIsActive}
                  tabIndex={0}
                  onMouseDownCapture={() => focusPane(pane.id)}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    focusPane(pane.id);
                  }}
                >
                  {session.isDetached ? (
                    <DetachedPlaceholder
                      label={session.label}
                      onReattach={() => reattachSession(session.id)}
                    />
                  ) : (
                    <ChatWindow
                      key={`${pane.id}:${session.id}`}
                      sessionId={session.id}
                      onClosePanel={closeChatPanel}
                      onToggleHistory={
                        isMaximized
                          ? undefined
                          : () => setHistoryOpen((value) => !value)
                      }
                      onStartFresh={() => void startFreshActiveSession()}
                      onToggleWide={toggleMaximized}
                      isWide={isMaximized}
                      onSplitPane={
                        isMaximized
                          ? () => void splitWithFreshSession()
                          : undefined
                      }
                      canSplitPane={canAddSplitPane}
                      onUnsplitPanes={
                        isMaximized && paneCount > 1
                          ? () => unsplitPanes(pane.id)
                          : undefined
                      }
                      onClosePane={
                        isMaximized && paneCount > 1
                          ? () => closePane(pane.id)
                          : undefined
                      }
                      autoFocusComposer={!isMaximized || paneIsActive}
                    />
                  )}
                </section>
              );
            })}
          </div>
        </div>
      )}
      {historyOpen && activeSession && !isMaximized && (
        <LocalChatHistoryDrawer
          activeSessionId={activeSession.id}
          sessionGroups={localSessionGroups}
          projectWarning={projectGroupingWarning}
          onClose={() => setHistoryOpen(false)}
          onStartFresh={() => void startFreshActiveSession()}
          onSelect={(sessionId) => {
            if (selectHistorySessionForActivePane(sessionId)) {
              setHistoryOpen(false);
            }
          }}
          deletingSessionId={deletingSessionId}
          deleteError={deleteError}
          onDelete={handleDeleteSession}
        />
      )}
      {shortcutsOpen && (
        <ChatShortcutHints onClose={() => setShortcutsOpen(false)} />
      )}
    </div>
  );
}

function formatSessionTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function formatSessionModel(session: LocalChatSessionSummary): string {
  const model = session.model?.trim() || session.selectedModelId?.trim();
  return model ? model.replace(/^claude-/i, "") : "Chat";
}

function buildSpawnOutline(messages: readonly ChatMessage[]): SpawnOutlineItem[] {
  return messages
    .filter(
      (message): message is Extract<ChatMessage, { kind: "tool_call" }> =>
        message.kind === "tool_call" &&
        !message.parentToolUseId &&
        isAgentSpawnTool(message.toolName)
    )
    .map((message) => {
      const input = parseToolInput(message.input);
      const description = stringValue(input.description);
      const subagent = stringValue(input.subagent_type);
      return {
        id: message.toolId,
        label: description || "Agent",
        detail: subagent || message.toolName,
      };
    });
}

function isAgentSpawnTool(toolName: string): boolean {
  return /^(agent|task)$/i.test(toolName);
}

function parseToolInput(input: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(input) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to empty input.
  }
  return {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function scrollToSpawn(sessionId: string, spawnId: string): void {
  window.dispatchEvent(
    new CustomEvent(LOCAL_CHAT_SCROLL_TO_SPAWN_EVENT, {
      detail: { sessionId, spawnId },
    })
  );
}

function LocalChatMiniPanel({
  activeSessionId,
  activeSession,
  deletingSessionId,
  deleteError,
  projectWarning,
  sessionGroups,
  onStartFresh,
  onSelect,
  onDelete,
}: {
  activeSessionId: string;
  activeSession: ChatSession | null;
  deletingSessionId: string | null;
  deleteError: string | null;
  projectWarning: string | null;
  sessionGroups: LocalChatSessionGroup[];
  onStartFresh: () => void | Promise<void>;
  onSelect: (sessionId: string) => void;
  onDelete: (sessionId: string) => void | Promise<void>;
}) {
  const sessionItems = useMemo(
    () => sessionGroups.flatMap((group) => group.sessions),
    [sessionGroups]
  );
  const sessionButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const [keyboardSessionId, setKeyboardSessionId] = useState<string | null>(
    activeSessionId
  );
  const activeSpawnOutline = useMemo(
    () => buildSpawnOutline(activeSession?.messages ?? []),
    [activeSession?.messages]
  );

  useEffect(() => {
    if (sessionItems.length === 0) {
      setKeyboardSessionId(null);
      return;
    }
    if (sessionItems.some((session) => session.id === keyboardSessionId)) {
      return;
    }
    const activeSession = sessionItems.find(
      (session) => session.id === activeSessionId
    );
    setKeyboardSessionId(activeSession?.id ?? sessionItems[0].id);
  }, [activeSessionId, keyboardSessionId, sessionItems]);

  const focusHistorySession = useCallback((sessionId: string) => {
    setKeyboardSessionId(sessionId);
    sessionButtonRefs.current.get(sessionId)?.focus();
  }, []);

  const handleHistoryKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (sessionItems.length === 0) return;
      const currentIndex = Math.max(
        0,
        sessionItems.findIndex((session) => session.id === keyboardSessionId)
      );
      let nextIndex: number | null = null;

      if (event.key === "ArrowDown") {
        nextIndex = Math.min(sessionItems.length - 1, currentIndex + 1);
      } else if (event.key === "ArrowUp") {
        nextIndex = Math.max(0, currentIndex - 1);
      } else if (event.key === "Home") {
        nextIndex = 0;
      } else if (event.key === "End") {
        nextIndex = sessionItems.length - 1;
      }

      if (nextIndex !== null) {
        event.preventDefault();
        focusHistorySession(sessionItems[nextIndex].id);
        return;
      }

      if (event.key !== "Enter" && event.key !== " ") return;
      if ((event.target as HTMLElement).closest("[data-mini-delete]")) return;
      event.preventDefault();
      const selectedSessionId =
        keyboardSessionId ??
        sessionItems.find((session) => session.id === activeSessionId)?.id ??
        sessionItems[0].id;
      onSelect(selectedSessionId);
    },
    [
      activeSessionId,
      focusHistorySession,
      keyboardSessionId,
      onSelect,
      sessionItems,
    ]
  );

  return (
    <aside
      data-testid="local-chat-mini-panel"
      aria-label="Local chat threads for active pane"
      className="hc-mini-history"
      tabIndex={-1}
      onKeyDown={handleHistoryKeyDown}
    >
      <div className="hc-mini-history-head">
        <span>Chats</span>
        <button
          type="button"
          className="hc-ctrl"
          onClick={() => void onStartFresh()}
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
      </div>
      {deleteError && (
        <div role="alert" className="hc-mini-history-error">
          {deleteError}
        </div>
      )}
      {projectWarning && (
        <div role="alert" className="hc-mini-history-error">
          {projectWarning}
        </div>
      )}
      {sessionGroups.length === 0 ? (
        <div className="hc-mini-history-empty">No local chats yet.</div>
      ) : (
        <div className="hc-mini-history-list">
          {sessionGroups.map((group) => (
            <section
              key={group.id}
              className="hc-mini-history-group"
              aria-label={`${group.label} chats`}
            >
              <h3 className="hc-mini-history-group-title">{group.label}</h3>
              {group.sessions.map((session) => {
                const isActive = session.id === activeSessionId;
                const isDeleting = session.id === deletingSessionId;
                const modelLabel = formatSessionModel(session);
                return (
                  <div
                    key={session.id}
                    className="hc-mini-history-row"
                    data-active={isActive || undefined}
                    data-keyboard-active={
                      keyboardSessionId === session.id || undefined
                    }
                  >
                    <button
                      type="button"
                      className="hc-mini-history-open"
                      ref={(node) => {
                        if (node) {
                          sessionButtonRefs.current.set(session.id, node);
                        } else {
                          sessionButtonRefs.current.delete(session.id);
                        }
                      }}
                      onFocus={() => setKeyboardSessionId(session.id)}
                      onClick={() => onSelect(session.id)}
                      title={`Load local chat ${session.label} into active pane`}
                      aria-label={`Load local chat ${session.label} into active pane`}
                      aria-current={isActive ? "true" : undefined}
                    >
                      <span className="label">{session.label}</span>
                      <span className="preview">{session.preview}</span>
                      <span className="meta">{modelLabel}</span>
                    </button>
                    <button
                      type="button"
                      className="hc-ctrl danger shrink-0"
                      data-mini-delete
                      disabled={isDeleting}
                      onClick={() => void onDelete(session.id)}
                      title={`Delete local chat ${session.label}`}
                      aria-label={`Delete local chat ${session.label}`}
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
                    {isActive && activeSpawnOutline.length > 0 && (
                      <div className="hc-mini-history-children">
                        {activeSpawnOutline.map((spawn) => (
                          <button
                            key={spawn.id}
                            type="button"
                            className="hc-mini-history-child"
                            onClick={() => scrollToSpawn(session.id, spawn.id)}
                            title={`Jump to spawned agent ${spawn.label}`}
                            aria-label={`Jump to spawned agent ${spawn.label}`}
                          >
                            <span className="label">{spawn.label}</span>
                            <span className="meta">{spawn.detail}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      )}
    </aside>
  );
}

function LocalChatHistoryDrawer({
  activeSessionId,
  deletingSessionId,
  deleteError,
  projectWarning,
  sessionGroups,
  onClose,
  onStartFresh,
  onSelect,
  onDelete,
}: {
  activeSessionId: string;
  deletingSessionId: string | null;
  deleteError: string | null;
  projectWarning: string | null;
  sessionGroups: LocalChatSessionGroup[];
  onClose: () => void;
  onStartFresh: () => void | Promise<void>;
  onSelect: (sessionId: string) => void;
  onDelete: (sessionId: string) => void | Promise<void>;
}) {
  return (
    <aside
      data-testid="local-chat-history-drawer"
      aria-label="Local chat history"
      className="absolute inset-0 z-20 flex flex-col overflow-hidden rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] shadow-xl"
    >
      <div className="flex items-center justify-between border-b border-[var(--color-line)] px-3 py-2">
        <h2 className="text-sm font-medium text-[var(--color-fg)]">
          Local chats
        </h2>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="hc-ctrl"
            onClick={() => void onStartFresh()}
            title="Start fresh local chat from history"
            aria-label="Start fresh local chat from history"
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
          <button
            type="button"
            className="hc-ctrl"
            onClick={onClose}
            title="Close chat history"
            aria-label="Close chat history"
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
        </div>
      </div>
      {deleteError && (
        <div
          role="alert"
          className="border-b border-[var(--color-line)] bg-[var(--err-wash)] px-3 py-2 text-xs text-[var(--err)]"
        >
          {deleteError}
        </div>
      )}
      {projectWarning && (
        <div
          role="alert"
          className="border-b border-[var(--color-line)] bg-[var(--warn-wash)] px-3 py-2 text-xs text-[var(--warn)]"
        >
          {projectWarning}
        </div>
      )}
      {sessionGroups.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-4 text-center text-sm text-[var(--color-fg-mute)]">
          No local chats yet.
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-2">
          {sessionGroups.map((group) => (
            <section
              key={group.id}
              className="mb-3 last:mb-0"
              aria-label={`${group.label} chats`}
            >
              <h3 className="px-1 pb-2 text-[10px] font-medium text-[var(--color-fg-mute)] uppercase">
                {group.label}
              </h3>
              {group.sessions.map((session) => {
                const isActive = session.id === activeSessionId;
                const isDeleting = session.id === deletingSessionId;
                const formattedTime = formatSessionTime(session.updatedAt);
                return (
                  <div
                    key={session.id}
                    className={`group mb-2 rounded-md border p-2 ${
                      isActive
                        ? "border-[var(--accent)] bg-[var(--color-bg-2)]"
                        : "border-[var(--color-line)] bg-[var(--color-bg-1)]"
                    }`}
                    data-active={isActive || undefined}
                  >
                    <div className="flex items-start gap-2">
                      <button
                        type="button"
                        className="min-w-0 flex-1 text-left"
                        onClick={() => onSelect(session.id)}
                        title={`Open local chat ${session.label}`}
                        aria-label={`Open local chat ${session.label}`}
                        aria-current={isActive ? "true" : undefined}
                      >
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium text-[var(--color-fg)]">
                            {session.label}
                          </span>
                          {session.providerResumeId && (
                            <span className="shrink-0 rounded border border-[var(--color-line)] px-1.5 py-0.5 text-[10px] text-[var(--color-fg-mute)] uppercase">
                              resumable
                            </span>
                          )}
                        </div>
                        <p className="mt-1 line-clamp-2 text-xs text-[var(--color-fg-soft)]">
                          {session.preview}
                        </p>
                        <p className="mt-1 text-[10px] text-[var(--color-fg-mute)] uppercase">
                          Chat · {session.messageCount} messages
                          {formattedTime ? ` · ${formattedTime}` : ""}
                        </p>
                      </button>
                      <button
                        type="button"
                        className="hc-ctrl danger shrink-0"
                        disabled={isDeleting}
                        onClick={() => void onDelete(session.id)}
                        title={`Delete local chat ${session.label}`}
                        aria-label={`Delete local chat ${session.label}`}
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
                    </div>
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      )}
    </aside>
  );
}

function ChatShortcutHints({ onClose }: { onClose: () => void }) {
  return (
    <div className="hc-shortcuts-layer">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Chat keyboard shortcuts"
        className="hc-shortcuts"
      >
        <header className="hc-shortcuts-head">
          <div>
            <p className="hc-shortcuts-eyebrow">Keyboard</p>
            <h2>Chat shortcuts</h2>
          </div>
          <button
            type="button"
            className="hc-ctrl"
            onClick={onClose}
            title="Close keyboard shortcuts"
            aria-label="Close keyboard shortcuts"
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
        </header>
        <div className="hc-shortcuts-body">
          {CHAT_SHORTCUT_SECTIONS.map((section) => (
            <section key={section.title} className="hc-shortcuts-section">
              <h3>{section.title}</h3>
              <dl>
                {section.shortcuts.map((shortcut) => (
                  <div key={`${section.title}:${shortcut.label}`}>
                    <dt>
                      {shortcut.keys.map((key, index) => (
                        <kbd key={`${key}:${index}`}>{key}</kbd>
                      ))}
                    </dt>
                    <dd>{shortcut.label}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </section>
    </div>
  );
}

/**
 * Placeholder shown in the main panel when the active tab's session has
 * been detached into a pop-out window. Offers a one-click reattach.
 */
function DetachedPlaceholder({
  label,
  onReattach,
}: {
  label: string;
  onReattach: () => void;
}) {
  return (
    <div
      role="status"
      aria-label="Session detached"
      className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center"
    >
      <span className="rounded-full bg-[var(--color-accent)]/10 p-3 text-[var(--color-accent)]">
        <svg
          className="h-6 w-6"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M14 5h5v5M19 5l-7 7M5 5h4v2H7v10h10v-2h2v4H5z"
          />
        </svg>
      </span>
      <p className="text-sm text-[var(--color-fg-soft)]">
        <span className="font-medium text-[var(--color-fg)]">{label}</span> is
        open in a pop-out window
      </p>
      <button
        onClick={onReattach}
        className="rounded-md border border-[var(--color-line)] bg-[var(--color-bg-1)] px-3 py-1.5 text-xs text-[var(--color-fg)] transition-colors hover:bg-[var(--color-bg-3)]"
      >
        Reattach to panel
      </button>
    </div>
  );
}

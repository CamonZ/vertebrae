import { useCallback, useMemo } from "react";
import {
  MAX_CHAT_PANES,
  normalizePaneLayout,
  useChatStore,
} from "../stores/chatStore";
import type { ChatPane, ChatSession } from "../stores/chatStore";

/** Pane split requires a minimum width per pane plus the history column. */
export const MIN_SPLIT_PANE_WIDTH = 360;
/** Width of the mini-history column that runs alongside split panes. */
export const MINI_HISTORY_WIDTH = 272;

export function minSplitLayoutWidth(paneCount: number): number {
  return MINI_HISTORY_WIDTH + MIN_SPLIT_PANE_WIDTH * paneCount;
}

interface UseChatPaneManagementOptions {
  /** Whether maximize is currently active (splits only render maximized). */
  isMaximized: boolean;
  /** The currently rendered panel width (used for split eligibility). */
  renderedPanelWidth: number;
  /** The active chat session, if any. */
  activeSession: ChatSession | null;
}

interface UseChatPaneManagementResult {
  normalizedPaneLayout: ReturnType<typeof normalizePaneLayout>;
  visiblePanes: ChatPane[];
  activePaneId: string | null;
  canAddSplitPane: boolean;
  focusPaneByIndex: (index: number) => boolean;
  focusPaneByOffset: (offset: number) => boolean;
  closeActivePane: () => boolean;
  keepOnlyActivePane: () => boolean;
}

/**
 * Pane layout derivation + management actions. In maximized mode the panes
 * render side-by-side; otherwise the active session renders as a single pane.
 * Focus moves and pane close/keep-only are inert outside maximize.
 */
export function useChatPaneManagement({
  isMaximized,
  renderedPanelWidth,
  activeSession,
}: UseChatPaneManagementOptions): UseChatPaneManagementResult {
  const sessions = useChatStore((s) => s.sessions);
  const paneLayout = useChatStore((s) => s.paneLayout);
  const focusPane = useChatStore((s) => s.focusPane);
  const closePane = useChatStore((s) => s.closePane);
  const unsplitPanes = useChatStore((s) => s.unsplitPanes);

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

  const canAddSplitPane =
    isMaximized &&
    visiblePanes.length < MAX_CHAT_PANES &&
    renderedPanelWidth >= minSplitLayoutWidth(visiblePanes.length + 1);

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

  return {
    normalizedPaneLayout,
    visiblePanes,
    activePaneId,
    canAddSplitPane,
    focusPaneByIndex,
    focusPaneByOffset,
    closeActivePane,
    keepOnlyActivePane,
  };
}

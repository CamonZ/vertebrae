import { useCallback } from "react";
import { useChatStore } from "../stores/chatStore";
import {
  activeEntry,
  type ChatPane,
  type ChatWorkspaceLayout,
} from "../stores/chatWorkspace";

interface UseChatPaneManagementOptions {
  /** Open chats needing the user (entry ids, jump order). */
  needingYou: readonly string[];
}

export interface UseChatPaneManagementResult {
  layout: ChatWorkspaceLayout;
  /** The chat shown: the active tab (null before any chat opens). */
  shownPane: ChatPane | null;
  /** ⌘⌥1–8 chat N, ⌘⌥9 the last chat. */
  focusPaneByIndex: (index: number) => boolean;
  /** ⌃Tab / ⌃⇧Tab: next / previous chat in strip order. */
  focusPaneByOffset: (offset: number) => boolean;
  /** ⌘⌥J / ⌘⌥⇧J: next / previous open chat needing the user. */
  focusNeedingYou: (offset: 1 | -1) => boolean;
  activatePane: (paneId: string) => void;
  closeActivePane: () => boolean;
  moveActivePane: (offset: number) => boolean;
}

/**
 * Derives the shown chat from the open-chat list and exposes the
 * chat-addressing actions, which all address the strip order.
 */
export function useChatPaneManagement({
  needingYou,
}: UseChatPaneManagementOptions): UseChatPaneManagementResult {
  // Store actions keep entries synchronized with open sessions. Avoid
  // subscribing to the sessions map here: text deltas replace that map while
  // leaving the layout unchanged.
  const layout = useChatStore((s) => s.paneLayout);
  const focusPane = useChatStore((s) => s.focusPane);
  const focusStoreByOffset = useChatStore((s) => s.focusPaneByOffset);
  const requestComposerFocus = useChatStore((s) => s.requestComposerFocus);
  const closePane = useChatStore((s) => s.closePane);
  const moveChat = useChatStore((s) => s.moveChat);
  const shownPane = activeEntry(layout) ?? layout.order[0] ?? null;

  const activatePane = useCallback(
    (paneId: string) => {
      focusPane(paneId);
      // Chat shortcuts move the keyboard into the chat they select.
      requestComposerFocus();
    },
    [focusPane, requestComposerFocus]
  );

  const focusPaneByIndex = useCallback(
    (index: number) => {
      const { order } = useChatStore.getState().paneLayout;
      // ⌘⌥9 is always the last chat, however many are open.
      const pane = index >= 8 ? order[order.length - 1] : order[index];
      if (!pane) return false;
      activatePane(pane.id);
      return true;
    },
    [activatePane]
  );

  const focusPaneByOffset = useCallback(
    (offset: number) => {
      if (!focusStoreByOffset(offset)) return false;
      requestComposerFocus();
      return true;
    },
    [focusStoreByOffset, requestComposerFocus]
  );

  const focusNeedingYou = useCallback(
    (offset: 1 | -1) => {
      if (needingYou.length === 0) return false;
      const at = needingYou.indexOf(layout.activeId ?? "");
      const next =
        at < 0
          ? offset === 1
            ? needingYou[0]
            : needingYou[needingYou.length - 1]
          : needingYou[(at + offset + needingYou.length) % needingYou.length];
      activatePane(next);
      return true;
    },
    [activatePane, layout.activeId, needingYou]
  );

  const closeActivePane = useCallback(() => {
    if (layout.order.length <= 1 || !layout.activeId) return false;
    closePane(layout.activeId);
    requestComposerFocus();
    return true;
  }, [closePane, layout.activeId, layout.order.length, requestComposerFocus]);

  const moveActivePane = useCallback(
    (offset: number) => {
      if (!layout.activeId || layout.order.length <= 1) return false;
      moveChat(layout.activeId, offset);
      return true;
    },
    [layout.activeId, layout.order.length, moveChat]
  );

  return {
    layout,
    shownPane,
    focusPaneByIndex,
    focusPaneByOffset,
    focusNeedingYou,
    activatePane,
    closeActivePane,
    moveActivePane,
  };
}

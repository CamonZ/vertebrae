import { useEffect, useRef } from "react";
import {
  CHAT_HELP_SHORTCUT,
  WORKSPACE_SHORTCUTS,
  matchesChatShortcut,
  matchesExactChatShortcut,
  type WorkspaceShortcutId,
} from "../components/ChatWindow/chatShortcuts";

export type ShortcutDispatchState = {
  shortcutsOpen: boolean;
  hasActiveSession: boolean;
  /** ⌘\: expand or collapse the chat workspace. */
  toggleExpanded: () => void;
  /** ⌘⌥1–9: chat N in strip order (index 8 = last). */
  focusPaneByIndex: (index: number) => boolean;
  /** ⌃Tab / ⌃⇧Tab: next / previous chat in strip order. */
  focusPaneByOffset: (offset: number) => boolean;
  /** ⌘⌥J / ⌘⌥⇧J: next / previous chat needing you. */
  focusNeedingYou: (offset: 1 | -1) => boolean;
  /** ⌘⌥⇧← / →: move the active chat in the strip. */
  moveActivePane: (offset: number) => boolean;
  /** ⌘⌥←/→: move between the chat's areas (composer, Changes). */
  focusAreaByOffset: (offset: -1 | 1) => boolean;
  /** ⌘⌥\: fresh chat after the active one. */
  openFreshChat: () => Promise<boolean>;
  /** ⌘⌥⇧\: close the active chat (its session stays in history). */
  closeActivePane: () => boolean;
  historyNavigationEnabled: boolean;
  focusHistorySearch: () => boolean;
  /** Open the focused pane's in-transcript find bar. */
  openPaneFind: () => boolean;
  selectHistoryProjectByOffset: (offset: number) => boolean;
  selectHistorySessionByOffset: (offset: number) => Promise<boolean>;
  startFreshActiveSession: () => Promise<boolean>;
  toggleHistorySelector: () => boolean;
  toggleHistoryVisibility: () => void;
  toggleChangesPanel: () => boolean;
};

type WorkspaceHandler = (
  dispatch: ShortcutDispatchState,
  event: KeyboardEvent
) => boolean | void | Promise<boolean>;

/**
 * Workspace bindings in dispatch order. A handler returning false leaves the
 * event alone; void and promises always claim it.
 */
const WORKSPACE_BINDINGS: readonly [WorkspaceShortcutId, WorkspaceHandler][] = [
  ["toggleExpanded", (d) => d.toggleExpanded()],
  ["nextChat", (d) => d.focusPaneByOffset(1)],
  ["previousChat", (d) => d.focusPaneByOffset(-1)],
  [
    "chatByNumber",
    (d, event) => d.focusPaneByIndex(paneNumberShortcutIndex(event) ?? -1),
  ],
  ["nextNeedingYou", (d) => d.focusNeedingYou(1)],
  ["previousNeedingYou", (d) => d.focusNeedingYou(-1)],
  ["moveChatLeft", (d) => d.moveActivePane(-1)],
  ["moveChatRight", (d) => d.moveActivePane(1)],
  ["freshChat", (d) => d.openFreshChat()],
  ["closeChat", (d) => d.closeActivePane()],
];

interface UseChatKeyboardShortcutsOptions {
  /** Whether the chat panel is currently open. Shortcuts are inert when closed. */
  open: boolean;
  /** Latest dispatch state. Stored in a ref so the listener never rebinds. */
  dispatch: ShortcutDispatchState;
  /** Toggle the shortcuts overlay open/closed. */
  setShortcutsOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

export function isShortcutHintsKey(event: KeyboardEvent): boolean {
  return matchesChatShortcut(event, CHAT_HELP_SHORTCUT);
}

export function historyShortcutOffset(event: KeyboardEvent): number | null {
  if (event.code === "BracketLeft" || event.key === "[") return -1;
  if (event.code === "BracketRight" || event.key === "]") return 1;
  return null;
}

export function isLetterShortcutKey(
  event: KeyboardEvent,
  code: string,
  key: string
) {
  return event.code === code || event.key.toLowerCase() === key;
}

export function paneNumberShortcutIndex(event: KeyboardEvent): number | null {
  const codeMatch = /^Digit([1-9])$/.exec(event.code);
  if (codeMatch) return Number(codeMatch[1]) - 1;
  const keyMatch = /^[1-9]$/.exec(event.key);
  return keyMatch ? Number(keyMatch[0]) - 1 : null;
}

/**
 * Global keyboard-shortcut dispatch for the chat panel: the workspace
 * bindings in WORKSPACE_SHORTCUTS (exact modifiers, matched on key codes),
 * then history, find, Changes and focus moves. The listener is capture-phase
 * and inert when `open` is false.
 */
export function useChatKeyboardShortcuts({
  open,
  dispatch,
  setShortcutsOpen,
}: UseChatKeyboardShortcutsOptions) {
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const current = dispatchRef.current;
      if (!current) return;

      const key = event.key.toLowerCase();

      if (isShortcutHintsKey(event)) {
        event.preventDefault();
        setShortcutsOpen((value) => !value);
        return;
      }

      if (key === "escape" && current.shortcutsOpen) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setShortcutsOpen(false);
        return;
      }

      if (current.shortcutsOpen) return;

      if (!event.isComposing) {
        const binding = WORKSPACE_BINDINGS.find(([id]) =>
          matchesExactChatShortcut(event, WORKSPACE_SHORTCUTS[id])
        );
        if (binding) {
          const handled = binding[1](current, event);
          if (handled !== false) event.preventDefault();
          return;
        }
      }

      if (!event.metaKey) return;

      if (
        isLetterShortcutKey(event, "KeyB", "b") &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.isComposing
      ) {
        event.preventDefault();

        if (!event.repeat) current.toggleHistoryVisibility();

        return;
      }

      if (
        isLetterShortcutKey(event, "KeyB", "b") &&
        event.shiftKey &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.isComposing
      ) {
        if (!event.repeat && current.toggleChangesPanel())
          event.preventDefault();
        return;
      }

      if (
        isLetterShortcutKey(event, "KeyF", "f") &&
        !event.altKey &&
        !event.ctrlKey
      ) {
        // ⌘F finds within the focused pane; ⌘⇧F searches chat sessions.
        const handled = event.shiftKey
          ? current.focusHistorySearch()
          : current.openPaneFind();
        if (handled) event.preventDefault();
        return;
      }

      if (event.altKey && !event.ctrlKey && !event.isComposing) {
        const historyOffset = historyShortcutOffset(event);

        if (historyOffset !== null && current.historyNavigationEnabled) {
          event.preventDefault();

          if (event.shiftKey)
            void current.selectHistorySessionByOffset(historyOffset);
          else current.selectHistoryProjectByOffset(historyOffset);

          return;
        }
      }

      if (!event.altKey) return;

      if (key === "arrowright" || key === "arrowleft") {
        if (current.focusAreaByOffset(key === "arrowright" ? 1 : -1)) {
          event.preventDefault();
        }
        return;
      }
      if (isLetterShortcutKey(event, "KeyN", "n")) {
        if (!event.shiftKey || !current.hasActiveSession) return;
        event.preventDefault();
        void current.startFreshActiveSession();
        return;
      }
      if (isLetterShortcutKey(event, "KeyH", "h")) {
        if (!event.shiftKey) return;
        event.preventDefault();
        current.toggleHistorySelector();
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, setShortcutsOpen]);
}

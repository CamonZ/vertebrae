import { useEffect, useRef } from "react";
import {
  CHAT_HELP_SHORTCUT,
  matchesChatShortcut,
} from "../components/ChatWindow/chatShortcuts";

export type ShortcutDispatchState = {
  shortcutsOpen: boolean;
  canAddSplitPane: boolean;
  hasActiveSession: boolean;
  focusPaneByIndex: (index: number) => boolean;
  focusPaneByOffset: (offset: number) => boolean;
  historyNavigationEnabled: boolean;
  focusHistorySearch: () => boolean;
  selectHistorySessionByOffset: (offset: number) => Promise<boolean>;
  closeActivePane: () => boolean;
  keepOnlyActivePane: () => boolean;
  splitWithFreshSession: () => Promise<boolean>;
  startFreshActiveSession: () => Promise<boolean>;
  toggleHistorySelector: () => boolean;
  toggleMaximized: () => void;
};

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

export function isBackslashShortcutKey(event: KeyboardEvent): boolean {
  return event.code === "Backslash" || event.key === "\\" || event.key === "|";
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
  const codeMatch = /^Digit([1-6])$/.exec(event.code);
  if (codeMatch) return Number(codeMatch[1]) - 1;
  const keyMatch = /^[1-6]$/.exec(event.key);
  return keyMatch ? Number(keyMatch[0]) - 1 : null;
}

/**
 * Global keyboard-shortcut dispatch for the chat panel. ~15 bindings covering
 * panel toggles, pane management, focus moves, fresh sessions, and history.
 * The listener is capture-phase and inert when `open` is false.
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

      if (event.ctrlKey && key === "tab") {
        if (current.focusPaneByOffset(event.shiftKey ? -1 : 1)) {
          event.preventDefault();
        }
        return;
      }

      if (!event.metaKey) return;

      if (
        key === "f" &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.shiftKey
      ) {
        if (current.focusHistorySearch()) {
          event.preventDefault();
        }
        return;
      }

      if (event.altKey && !event.shiftKey) {
        const historyOffset = historyShortcutOffset(event);
        if (historyOffset !== null && current.historyNavigationEnabled) {
          event.preventDefault();
          void current.selectHistorySessionByOffset(historyOffset);
          return;
        }
      }

      if (isBackslashShortcutKey(event) && event.altKey && event.shiftKey) {
        if (current.closeActivePane()) {
          event.preventDefault();
        }
        return;
      }

      if (isBackslashShortcutKey(event) && event.altKey) {
        if (!current.canAddSplitPane) return;
        event.preventDefault();
        void current.splitWithFreshSession();
        return;
      }

      if (isBackslashShortcutKey(event) && !event.shiftKey) {
        event.preventDefault();
        current.toggleMaximized();
        return;
      }

      if (!event.altKey) return;

      if (key === "arrowright") {
        if (current.focusPaneByOffset(1)) {
          event.preventDefault();
        }
        return;
      }
      if (key === "arrowleft") {
        if (current.focusPaneByOffset(-1)) {
          event.preventDefault();
        }
        return;
      }
      const paneNumberIndex = paneNumberShortcutIndex(event);
      if (paneNumberIndex !== null) {
        if (current.focusPaneByIndex(paneNumberIndex)) {
          event.preventDefault();
        }
        return;
      }
      if (isLetterShortcutKey(event, "KeyM", "m")) {
        if (current.keepOnlyActivePane()) {
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

import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  useChatKeyboardShortcuts,
  isShortcutHintsKey,
  isBackslashShortcutKey,
  isLetterShortcutKey,
  paneNumberShortcutIndex,
  type ShortcutDispatchState,
} from "./useChatKeyboardShortcuts";

function makeDispatch(
  overrides: Partial<ShortcutDispatchState> = {}
): ShortcutDispatchState {
  return {
    shortcutsOpen: false,
    canAddSplitPane: true,
    hasActiveSession: true,
    focusPaneByIndex: vi.fn(() => true),
    focusPaneByOffset: vi.fn(() => true),
    closeActivePane: vi.fn(() => true),
    keepOnlyActivePane: vi.fn(() => true),
    splitWithFreshSession: vi.fn(async () => true),
    startFreshActiveSession: vi.fn(async () => true),
    toggleHistorySelector: vi.fn(() => true),
    toggleMaximized: vi.fn(),
    ...overrides,
  };
}

function fireKey(
  overrides: Partial<KeyboardEvent> & {
    key: string;
  }
) {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...overrides,
  });
  window.dispatchEvent(event);
  return event;
}

function renderShortcutHook(dispatch: ShortcutDispatchState) {
  const setShortcutsOpen = vi.fn();
  const { rerender, unmount } = renderHook(
    ({ open, dispatch }) =>
      useChatKeyboardShortcuts({ open, dispatch, setShortcutsOpen }),
    { initialProps: { open: true, dispatch } }
  );
  return { setShortcutsOpen, rerender, unmount };
}

describe("useChatKeyboardShortcuts", () => {
  it("does not fire when open=false (listener never attached)", () => {
    const dispatch = makeDispatch();
    const setShortcutsOpen = vi.fn();
    renderHook(
      ({ open }) =>
        useChatKeyboardShortcuts({
          open,
          dispatch,
          setShortcutsOpen,
        }),
      { initialProps: { open: false } }
    );
    fireKey({ key: "\\", metaKey: true });
    expect(dispatch.toggleMaximized).not.toHaveBeenCalled();
  });

  it("toggles shortcuts on cmd+shift+?", () => {
    const dispatch = makeDispatch();
    const { setShortcutsOpen } = renderShortcutHook(dispatch);
    fireKey({ key: "?", metaKey: true, shiftKey: true });
    expect(setShortcutsOpen).toHaveBeenCalled();
  });

  it("toggles shortcuts on cmd+shift+/", () => {
    const dispatch = makeDispatch();
    const { setShortcutsOpen } = renderShortcutHook(dispatch);
    fireKey({ key: "/", metaKey: true, shiftKey: true });
    expect(setShortcutsOpen).toHaveBeenCalled();
  });

  it("closes shortcuts on Escape when open", () => {
    const dispatch = makeDispatch({ shortcutsOpen: true });
    const { setShortcutsOpen } = renderShortcutHook(dispatch);
    fireKey({ key: "Escape" });
    expect(setShortcutsOpen).toHaveBeenCalledWith(false);
  });

  it("keeps Escape from reaching the chat panel while hints are open", () => {
    const dispatch = makeDispatch({ shortcutsOpen: true });
    renderShortcutHook(dispatch);
    const closeChatPanel = vi.fn();
    const panelEscapeListener = () => closeChatPanel();
    window.addEventListener("keydown", panelEscapeListener, true);

    fireKey({ key: "Escape" });

    window.removeEventListener("keydown", panelEscapeListener, true);
    expect(closeChatPanel).not.toHaveBeenCalled();
  });

  it("does not process other shortcuts when hints are open", () => {
    const dispatch = makeDispatch({ shortcutsOpen: true });
    renderShortcutHook(dispatch);
    fireKey({ key: "\\", metaKey: true });
    expect(dispatch.toggleMaximized).not.toHaveBeenCalled();
  });

  it("toggles maximize on cmd+backslash (no shift)", () => {
    const dispatch = makeDispatch();
    renderShortcutHook(dispatch);
    fireKey({ key: "\\", metaKey: true });
    expect(dispatch.toggleMaximized).toHaveBeenCalled();
  });

  it("splits pane on cmd+alt+backslash", () => {
    const dispatch = makeDispatch();
    renderShortcutHook(dispatch);
    fireKey({ key: "\\", metaKey: true, altKey: true });
    expect(dispatch.splitWithFreshSession).toHaveBeenCalled();
  });

  it("does not split when canAddSplitPane is false", () => {
    const dispatch = makeDispatch({ canAddSplitPane: false });
    renderShortcutHook(dispatch);
    fireKey({ key: "\\", metaKey: true, altKey: true });
    expect(dispatch.splitWithFreshSession).not.toHaveBeenCalled();
  });

  it("closes active pane on cmd+shift+alt+backslash", () => {
    const dispatch = makeDispatch();
    renderShortcutHook(dispatch);
    fireKey({ key: "\\", metaKey: true, altKey: true, shiftKey: true });
    expect(dispatch.closeActivePane).toHaveBeenCalled();
  });

  it("focuses next pane on ctrl+tab", () => {
    const dispatch = makeDispatch();
    renderShortcutHook(dispatch);
    fireKey({ key: "Tab", ctrlKey: true });
    expect(dispatch.focusPaneByOffset).toHaveBeenCalledWith(1);
  });

  it("focuses previous pane on ctrl+shift+tab", () => {
    const dispatch = makeDispatch();
    renderShortcutHook(dispatch);
    fireKey({ key: "Tab", ctrlKey: true, shiftKey: true });
    expect(dispatch.focusPaneByOffset).toHaveBeenCalledWith(-1);
  });

  it("focuses right pane on cmd+alt+ArrowRight", () => {
    const dispatch = makeDispatch();
    renderShortcutHook(dispatch);
    fireKey({ key: "ArrowRight", metaKey: true, altKey: true });
    expect(dispatch.focusPaneByOffset).toHaveBeenCalledWith(1);
  });

  it("focuses left pane on cmd+alt+ArrowLeft", () => {
    const dispatch = makeDispatch();
    renderShortcutHook(dispatch);
    fireKey({ key: "ArrowLeft", metaKey: true, altKey: true });
    expect(dispatch.focusPaneByOffset).toHaveBeenCalledWith(-1);
  });

  it("focuses pane by number on cmd+alt+1", () => {
    const dispatch = makeDispatch();
    renderShortcutHook(dispatch);
    fireKey({ key: "1", metaKey: true, altKey: true });
    expect(dispatch.focusPaneByIndex).toHaveBeenCalledWith(0);
  });

  it("keeps only active pane on cmd+alt+M", () => {
    const dispatch = makeDispatch();
    renderShortcutHook(dispatch);
    fireKey({ key: "m", code: "KeyM", metaKey: true, altKey: true });
    expect(dispatch.keepOnlyActivePane).toHaveBeenCalled();
  });

  it("starts fresh session on cmd+shift+alt+N", () => {
    const dispatch = makeDispatch();
    renderShortcutHook(dispatch);
    fireKey({ key: "n", code: "KeyN", metaKey: true, altKey: true, shiftKey: true });
    expect(dispatch.startFreshActiveSession).toHaveBeenCalled();
  });

  it("does not start fresh session without shift", () => {
    const dispatch = makeDispatch();
    renderShortcutHook(dispatch);
    fireKey({ key: "n", code: "KeyN", metaKey: true, altKey: true });
    expect(dispatch.startFreshActiveSession).not.toHaveBeenCalled();
  });

  it("toggles history on cmd+shift+alt+H", () => {
    const dispatch = makeDispatch();
    renderShortcutHook(dispatch);
    fireKey({ key: "h", code: "KeyH", metaKey: true, altKey: true, shiftKey: true });
    expect(dispatch.toggleHistorySelector).toHaveBeenCalled();
  });

  it("does not toggle history without shift", () => {
    const dispatch = makeDispatch();
    renderShortcutHook(dispatch);
    fireKey({ key: "h", code: "KeyH", metaKey: true, altKey: true });
    expect(dispatch.toggleHistorySelector).not.toHaveBeenCalled();
  });

  it("does not start fresh session when hasActiveSession is false", () => {
    const dispatch = makeDispatch({ hasActiveSession: false });
    renderShortcutHook(dispatch);
    fireKey({ key: "n", code: "KeyN", metaKey: true, altKey: true, shiftKey: true });
    expect(dispatch.startFreshActiveSession).not.toHaveBeenCalled();
  });

  it("removes the keydown listener on unmount", () => {
    const dispatch = makeDispatch();
    const { unmount } = renderShortcutHook(dispatch);
    unmount();
    fireKey({ key: "\\", metaKey: true });
    expect(dispatch.toggleMaximized).not.toHaveBeenCalled();
  });
});

describe("isShortcutHintsKey", () => {
  it("returns true for cmd+shift+?", () => {
    const event = { metaKey: true, shiftKey: true, key: "?" } as KeyboardEvent;
    expect(isShortcutHintsKey(event)).toBe(true);
  });

  it("returns true for cmd+shift+/", () => {
    const event = { metaKey: true, shiftKey: true, key: "/" } as KeyboardEvent;
    expect(isShortcutHintsKey(event)).toBe(true);
  });

  it("returns false without metaKey", () => {
    const event = { metaKey: false, shiftKey: true, key: "?" } as KeyboardEvent;
    expect(isShortcutHintsKey(event)).toBe(false);
  });

  it("returns false without shiftKey", () => {
    const event = { metaKey: true, shiftKey: false, key: "?" } as KeyboardEvent;
    expect(isShortcutHintsKey(event)).toBe(false);
  });

  it("returns false for other keys", () => {
    const event = { metaKey: true, shiftKey: true, key: "a" } as KeyboardEvent;
    expect(isShortcutHintsKey(event)).toBe(false);
  });
});

describe("isBackslashShortcutKey", () => {
  it("returns true for code=Backslash", () => {
    const event = { code: "Backslash", key: "a" } as KeyboardEvent;
    expect(isBackslashShortcutKey(event)).toBe(true);
  });

  it("returns true for key=\\", () => {
    const event = { code: "", key: "\\" } as KeyboardEvent;
    expect(isBackslashShortcutKey(event)).toBe(true);
  });

  it("returns true for key=|", () => {
    const event = { code: "", key: "|" } as KeyboardEvent;
    expect(isBackslashShortcutKey(event)).toBe(true);
  });

  it("returns false for unrelated keys", () => {
    const event = { code: "KeyA", key: "a" } as KeyboardEvent;
    expect(isBackslashShortcutKey(event)).toBe(false);
  });
});

describe("isLetterShortcutKey", () => {
  it("matches by code", () => {
    const event = { code: "KeyM", key: "z" } as KeyboardEvent;
    expect(isLetterShortcutKey(event, "KeyM", "m")).toBe(true);
  });

  it("matches by lowercase key", () => {
    const event = { code: "", key: "m" } as KeyboardEvent;
    expect(isLetterShortcutKey(event, "KeyM", "m")).toBe(true);
  });

  it("matches case-insensitively", () => {
    const event = { code: "", key: "M" } as KeyboardEvent;
    expect(isLetterShortcutKey(event, "KeyM", "m")).toBe(true);
  });

  it("returns false when neither matches", () => {
    const event = { code: "KeyA", key: "a" } as KeyboardEvent;
    expect(isLetterShortcutKey(event, "KeyM", "m")).toBe(false);
  });
});

describe("paneNumberShortcutIndex", () => {
  it("returns 0 for Digit1", () => {
    expect(paneNumberShortcutIndex({ code: "Digit1" } as KeyboardEvent)).toBe(0);
  });

  it("returns 5 for Digit6", () => {
    expect(paneNumberShortcutIndex({ code: "Digit6" } as KeyboardEvent)).toBe(5);
  });

  it("returns 0 for key='1'", () => {
    expect(paneNumberShortcutIndex({ code: "", key: "1" } as KeyboardEvent)).toBe(0);
  });

  it("returns null for Digit7 (out of range)", () => {
    expect(paneNumberShortcutIndex({ code: "Digit7" } as KeyboardEvent)).toBeNull();
  });

  it("returns null for non-numeric keys", () => {
    expect(paneNumberShortcutIndex({ code: "KeyA", key: "a" } as KeyboardEvent)).toBeNull();
  });
});

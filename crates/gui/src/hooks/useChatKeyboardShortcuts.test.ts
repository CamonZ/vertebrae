import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  useChatKeyboardShortcuts,
  isShortcutHintsKey,
  historyShortcutOffset,
  isLetterShortcutKey,
  paneNumberShortcutIndex,
  type ShortcutDispatchState,
} from "./useChatKeyboardShortcuts";

function makeDispatch(
  overrides: Partial<ShortcutDispatchState> = {}
): ShortcutDispatchState {
  return {
    shortcutsOpen: false,
    hasActiveSession: true,
    toggleExpanded: vi.fn(),
    focusPaneByIndex: vi.fn(() => true),
    focusPaneByOffset: vi.fn(() => true),
    focusNeedingYou: vi.fn(() => true),
    moveActivePane: vi.fn(() => true),
    focusAreaByOffset: vi.fn(() => true),
    historyNavigationEnabled: true,
    focusHistorySearch: vi.fn(() => true),
    openPaneFind: vi.fn(() => true),
    selectHistoryProjectByOffset: vi.fn(() => true),
    selectHistorySessionByOffset: vi.fn(async () => true),
    closeActivePane: vi.fn(() => true),
    openFreshChat: vi.fn(async () => true),
    startFreshActiveSession: vi.fn(async () => true),
    toggleHistorySelector: vi.fn(() => true),
    toggleHistoryVisibility: vi.fn(),
    toggleSideColumn: vi.fn(() => true),
    toggleSideSection: vi.fn(() => true),
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
    expect(dispatch.toggleExpanded).not.toHaveBeenCalled();
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
    expect(dispatch.toggleExpanded).not.toHaveBeenCalled();
  });

  it("expands or collapses on cmd+backslash", () => {
    const dispatch = makeDispatch();
    renderShortcutHook(dispatch);
    fireKey({ key: "\\", code: "Backslash", metaKey: true });
    expect(dispatch.toggleExpanded).toHaveBeenCalled();
  });

  it("leaves cmd+shift+backslash unbound", () => {
    const dispatch = makeDispatch();
    renderShortcutHook(dispatch);
    // Shift turns the key into "|"; the code still names the key.
    fireKey({ key: "|", code: "Backslash", metaKey: true, shiftKey: true });
    expect(dispatch.toggleExpanded).not.toHaveBeenCalled();
  });

  it("opens a fresh chat on cmd+alt+backslash", () => {
    const dispatch = makeDispatch();
    renderShortcutHook(dispatch);
    fireKey({ key: "\\", code: "Backslash", metaKey: true, altKey: true });
    expect(dispatch.openFreshChat).toHaveBeenCalled();
  });

  it("leaves a workspace key alone when its action does nothing", () => {
    const dispatch = makeDispatch({ closeActivePane: vi.fn(() => false) });
    renderShortcutHook(dispatch);
    const event = fireKey({
      key: "|",
      code: "Backslash",
      metaKey: true,
      altKey: true,
      shiftKey: true,
    });
    expect(dispatch.closeActivePane).toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it.each([
    [{ shiftKey: false }, 1],
    [{ shiftKey: true }, -1],
  ] as const)(
    "jumps to the chats needing you on cmd+alt+J %j",
    (extra, offset) => {
      const dispatch = makeDispatch();
      renderShortcutHook(dispatch);
      // Option turns J into "∆" on macOS; the code still names the key.
      fireKey({
        key: "∆",
        code: "KeyJ",
        metaKey: true,
        altKey: true,
        ...extra,
      });
      expect(dispatch.focusNeedingYou).toHaveBeenCalledWith(offset);
    }
  );

  it.each([
    ["ArrowLeft", -1],
    ["ArrowRight", 1],
  ] as const)("moves the active chat on cmd+alt+shift+%s", (key, offset) => {
    const dispatch = makeDispatch();
    renderShortcutHook(dispatch);
    fireKey({ key, code: key, metaKey: true, altKey: true, shiftKey: true });
    expect(dispatch.moveActivePane).toHaveBeenCalledWith(offset);
    expect(dispatch.focusAreaByOffset).not.toHaveBeenCalled();
  });

  it("closes active pane on cmd+shift+alt+backslash", () => {
    const dispatch = makeDispatch();
    renderShortcutHook(dispatch);
    fireKey({
      key: "|",
      code: "Backslash",
      metaKey: true,
      altKey: true,
      shiftKey: true,
    });
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

  it("moves to the next chat area on cmd+alt+ArrowRight", () => {
    const dispatch = makeDispatch();
    renderShortcutHook(dispatch);
    fireKey({ key: "ArrowRight", metaKey: true, altKey: true });
    expect(dispatch.focusAreaByOffset).toHaveBeenCalledWith(1);
  });

  it("moves to the previous chat area on cmd+alt+ArrowLeft", () => {
    const dispatch = makeDispatch();
    renderShortcutHook(dispatch);
    fireKey({ key: "ArrowLeft", metaKey: true, altKey: true });
    expect(dispatch.focusAreaByOffset).toHaveBeenCalledWith(-1);
  });

  it("selects the previous and next projects with cmd+alt brackets", () => {
    const dispatch = makeDispatch();
    renderShortcutHook(dispatch);

    fireKey({ key: "[", code: "BracketLeft", metaKey: true, altKey: true });
    fireKey({ key: "]", code: "BracketRight", metaKey: true, altKey: true });

    expect(dispatch.selectHistoryProjectByOffset).toHaveBeenNthCalledWith(
      1,
      -1
    );
    expect(dispatch.selectHistoryProjectByOffset).toHaveBeenNthCalledWith(2, 1);
  });

  it("leaves bracket keys alone outside maximized history navigation", () => {
    const dispatch = makeDispatch({ historyNavigationEnabled: false });
    renderShortcutHook(dispatch);

    const event = fireKey({
      key: "]",
      code: "BracketRight",
      metaKey: true,
      altKey: true,
    });

    expect(event.defaultPrevented).toBe(false);
    expect(dispatch.selectHistoryProjectByOffset).not.toHaveBeenCalled();
  });

  it("routes shifted transformed brackets only to sessions while an input is focused", () => {
    const dispatch = makeDispatch();

    renderShortcutHook(dispatch);

    const input = document.createElement("textarea");

    document.body.append(input);
    input.focus();

    for (const [code, key, offset] of [
      ["BracketLeft", "{", -1],
      ["BracketRight", "}", 1],
    ] as const) {
      const event = new KeyboardEvent("keydown", {
        code,
        key,
        metaKey: true,
        altKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });

      input.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(dispatch.selectHistorySessionByOffset).toHaveBeenLastCalledWith(
        offset
      );
    }

    expect(dispatch.selectHistoryProjectByOffset).not.toHaveBeenCalled();

    input.remove();
  });

  it("opens the focused pane's find bar with cmd+f", () => {
    const dispatch = makeDispatch();
    renderShortcutHook(dispatch);

    const event = fireKey({ key: "f", code: "KeyF", metaKey: true });

    expect(dispatch.openPaneFind).toHaveBeenCalledTimes(1);
    expect(dispatch.focusHistorySearch).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it("focuses history search with cmd+shift+f", () => {
    const dispatch = makeDispatch();
    renderShortcutHook(dispatch);

    fireKey({ key: "F", code: "KeyF", metaKey: true, shiftKey: true });

    expect(dispatch.focusHistorySearch).toHaveBeenCalledTimes(1);
    expect(dispatch.openPaneFind).not.toHaveBeenCalled();
  });

  it("does not intercept cmd+shift+f when history search is unavailable", () => {
    const dispatch = makeDispatch();
    dispatch.focusHistorySearch = vi.fn(() => false);
    const { unmount } = renderShortcutHook(dispatch);

    const event = fireKey({
      key: "F",
      code: "KeyF",
      metaKey: true,
      shiftKey: true,
    });

    expect(event.defaultPrevented).toBe(false);
    unmount();
  });

  it("focuses chat by number on cmd+alt+1", () => {
    const dispatch = makeDispatch();
    renderShortcutHook(dispatch);
    fireKey({ key: "¡", code: "Digit1", metaKey: true, altKey: true });
    expect(dispatch.focusPaneByIndex).toHaveBeenCalledWith(0);
  });

  it("passes index 8 for cmd+alt+9 (the last chat)", () => {
    const dispatch = makeDispatch();
    renderShortcutHook(dispatch);
    fireKey({ key: "ª", code: "Digit9", metaKey: true, altKey: true });
    expect(dispatch.focusPaneByIndex).toHaveBeenCalledWith(8);
  });

  it("starts fresh session on cmd+shift+alt+N", () => {
    const dispatch = makeDispatch();
    renderShortcutHook(dispatch);
    fireKey({
      key: "n",
      code: "KeyN",
      metaKey: true,
      altKey: true,
      shiftKey: true,
    });

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
    fireKey({
      key: "h",
      code: "KeyH",
      metaKey: true,
      altKey: true,
      shiftKey: true,
    });

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
    fireKey({
      key: "n",
      code: "KeyN",
      metaKey: true,
      altKey: true,
      shiftKey: true,
    });

    expect(dispatch.startFreshActiveSession).not.toHaveBeenCalled();
  });

  it("removes the keydown listener on unmount", () => {
    const dispatch = makeDispatch();
    const { unmount } = renderShortcutHook(dispatch);
    unmount();
    fireKey({ key: "\\", metaKey: true });
    expect(dispatch.toggleExpanded).not.toHaveBeenCalled();
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

describe("historyShortcutOffset", () => {
  it("returns the previous offset for the left bracket", () => {
    expect(
      historyShortcutOffset({ code: "BracketLeft", key: "[" } as KeyboardEvent)
    ).toBe(-1);
  });

  it("returns the next offset for the right bracket", () => {
    expect(
      historyShortcutOffset({ code: "BracketRight", key: "]" } as KeyboardEvent)
    ).toBe(1);
  });

  it("returns null for other keys", () => {
    expect(
      historyShortcutOffset({ code: "KeyF", key: "f" } as KeyboardEvent)
    ).toBeNull();
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
    expect(paneNumberShortcutIndex({ code: "Digit1" } as KeyboardEvent)).toBe(
      0
    );
  });

  it("returns 5 for Digit6", () => {
    expect(paneNumberShortcutIndex({ code: "Digit6" } as KeyboardEvent)).toBe(
      5
    );
  });

  it("returns 0 for key='1'", () => {
    expect(
      paneNumberShortcutIndex({ code: "", key: "1" } as KeyboardEvent)
    ).toBe(0);
  });

  it("returns 8 for Digit9 (the last chat)", () => {
    expect(paneNumberShortcutIndex({ code: "Digit9" } as KeyboardEvent)).toBe(
      8
    );
  });

  it("returns null for Digit0", () => {
    expect(
      paneNumberShortcutIndex({ code: "Digit0", key: "0" } as KeyboardEvent)
    ).toBeNull();
  });

  it("returns null for non-numeric keys", () => {
    expect(
      paneNumberShortcutIndex({ code: "KeyA", key: "a" } as KeyboardEvent)
    ).toBeNull();
  });
});

it("toggles the sidebar on Cmd+B and ignores repeats, composition, and extra modifiers", () => {
  const dispatch = makeDispatch();
  renderShortcutHook(dispatch);

  expect(
    fireKey({ key: "b", code: "KeyB", metaKey: true }).defaultPrevented
  ).toBe(true);
  expect(dispatch.toggleHistoryVisibility).toHaveBeenCalledTimes(1);

  for (const modifiers of [
    { repeat: true },
    { isComposing: true },
    { altKey: true },
    { ctrlKey: true },
    { shiftKey: true },
  ]) {
    fireKey({ key: "b", code: "KeyB", metaKey: true, ...modifiers });
  }

  expect(dispatch.toggleHistoryVisibility).toHaveBeenCalledTimes(1);
});

describe("Side column shortcuts", () => {
  it("dispatches Cmd+Shift+B without toggling the history sidebar", () => {
    const dispatch = makeDispatch();

    renderShortcutHook(dispatch);

    expect(
      fireKey({ key: "B", code: "KeyB", metaKey: true, shiftKey: true })
        .defaultPrevented
    ).toBe(true);
    expect(dispatch.toggleSideColumn).toHaveBeenCalledOnce();
    expect(dispatch.toggleHistoryVisibility).not.toHaveBeenCalled();
  });

  it("leaves the key alone without an eligible active conversation", () => {
    const dispatch = makeDispatch({ toggleSideColumn: vi.fn(() => false) });

    renderShortcutHook(dispatch);

    expect(
      fireKey({ key: "B", metaKey: true, shiftKey: true }).defaultPrevented
    ).toBe(false);
  });

  it.each([
    { repeat: true },
    { altKey: true },
    { ctrlKey: true },
    { isComposing: true },
  ])("ignores repeats and extra modifiers %j", (extra) => {
    const dispatch = makeDispatch();

    renderShortcutHook(dispatch);
    fireKey({ key: "B", metaKey: true, shiftKey: true, ...extra });

    expect(dispatch.toggleSideColumn).not.toHaveBeenCalled();
  });

  it.each([
    // Shift turns the brackets into braces on US layouts; other layouts
    // report other keys. The physical key decides.
    { key: "{", code: "BracketLeft", offset: -1 },
    { key: "[", code: "BracketLeft", offset: -1 },
    { key: "ü", code: "BracketLeft", offset: -1 },
    { key: "}", code: "BracketRight", offset: 1 },
    { key: "+", code: "BracketRight", offset: 1 },
  ])("Cmd+Shift+$key ($code) switches chat tabs by $offset", ({ key, code, offset }) => {
    const dispatch = makeDispatch();

    renderShortcutHook(dispatch);

    expect(
      fireKey({ key, code, metaKey: true, shiftKey: true }).defaultPrevented
    ).toBe(true);
    expect(dispatch.focusPaneByOffset).toHaveBeenCalledExactlyOnceWith(offset);
    expect(dispatch.toggleSideSection).not.toHaveBeenCalled();
  });

  it.each([
    { code: "Digit1", section: "changes" },
    { code: "Digit2", section: "discussions" },
    { code: "Digit3", section: "background" },
  ])("Ctrl+Cmd+$code toggles the $section section", ({ code, section }) => {
    const dispatch = makeDispatch();

    renderShortcutHook(dispatch);

    expect(
      fireKey({ key: code.slice(-1), code, metaKey: true, ctrlKey: true })
        .defaultPrevented
    ).toBe(true);
    expect(dispatch.toggleSideSection).toHaveBeenCalledExactlyOnceWith(section);
    expect(dispatch.focusPaneByIndex).not.toHaveBeenCalled();
  });

  it.each([
    { key: "ArrowLeft", offset: -1 },
    { key: "ArrowRight", offset: 1 },
  ])("Cmd+Option+$key moves composer ↔ side column, never switching tabs", ({ key, offset }) => {
    const dispatch = makeDispatch();

    renderShortcutHook(dispatch);

    expect(
      fireKey({ key, code: key, metaKey: true, altKey: true }).defaultPrevented
    ).toBe(true);
    expect(dispatch.focusAreaByOffset).toHaveBeenCalledExactlyOnceWith(offset);
    expect(dispatch.focusPaneByOffset).not.toHaveBeenCalled();
    expect(dispatch.moveActivePane).not.toHaveBeenCalled();
    expect(dispatch.toggleSideSection).not.toHaveBeenCalled();
  });
});

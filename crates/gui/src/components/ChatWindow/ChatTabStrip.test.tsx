import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useChatStore, type ChatSession } from "../../stores/chatStore";
import { moveEntryBefore, type ChatPane } from "../../stores/chatWorkspace";
import { ChatTabStrip, type ChatTabStripProps } from "./ChatTabStrip";
import { useChatTabs } from "./useChatTabs";

function session(id: string, overrides: Partial<ChatSession> = {}) {
  return {
    id,
    label: id,
    title: `Chat ${id}`,
    messages: [],
    status: "open",
    harness: "claude",
    backendSessionId: null,
    providerResumeId: null,
    ...overrides,
  } as ChatSession;
}

function seed(
  ids: string[],
  overrides: Record<string, Partial<ChatSession>> = {}
) {
  useChatStore.setState({
    sessions: Object.fromEntries(
      ids.map((id) => [id, session(id, overrides[id])])
    ),
  });
  return ids.map((id): ChatPane => ({ id: `e-${id}`, sessionId: id }));
}

type Handlers = Pick<
  ChatTabStripProps,
  | "onEnterChat"
  | "onClose"
  | "onMoveBefore"
  | "onFreshChat"
  | "onToggleExpanded"
  | "onToggleHistory"
  | "onNextNeedingYou"
>;

function handlers(): Handlers {
  return {
    onEnterChat: vi.fn(),
    onClose: vi.fn(),
    onMoveBefore: vi.fn(),
    onFreshChat: vi.fn(),
    onToggleExpanded: vi.fn(),
    onToggleHistory: vi.fn(),
    onNextNeedingYou: vi.fn(),
  };
}

/** Owns order and selection like the workspace does. */
function Strip({
  initial,
  props = {},
  spies = handlers(),
}: {
  initial: ChatPane[];
  props?: Partial<ChatTabStripProps>;
  spies?: Handlers;
}) {
  const [order, setOrder] = useState(initial);
  const [activeId, setActiveId] = useState(initial[0]?.id ?? null);
  const tabs = useChatTabs(order, undefined);
  return (
    <ChatTabStrip
      tabs={tabs}
      activeId={activeId}
      expanded
      needingYou={[]}
      historyVisible
      onSelect={setActiveId}
      {...spies}
      onClose={(id) => {
        spies.onClose(id);
        setOrder((current) => current.filter((pane) => pane.id !== id));
      }}
      onMoveBefore={(id, beforeId) => {
        spies.onMoveBefore(id, beforeId);
        setOrder(
          (current) =>
            moveEntryBefore({ order: current, activeId }, id, beforeId).order
        );
      }}
      {...props}
    />
  );
}

const tabs = () => screen.getAllByRole("tab");
const selected = () =>
  tabs().find((tab) => tab.getAttribute("aria-selected") === "true");

beforeEach(() => {
  useChatStore.setState({ sessions: {} });
});

describe("ChatTabStrip tablist", () => {
  it("exposes the open chats as a named tablist with one tab stop", () => {
    render(<Strip initial={seed(["a", "b", "c"])} />);
    expect(screen.getByRole("tablist", { name: "Open chats" })).toBeVisible();
    expect(tabs().map((tab) => tab.getAttribute("tabindex"))).toEqual([
      "0",
      "-1",
      "-1",
    ]);
    expect(tabs()[0]).toHaveAccessibleName(/^Chat a, /);
    expect(tabs()[0]).toHaveAttribute("aria-controls", "chat-tabpanel-e-a");
    expect(tabs()[1]).not.toHaveAttribute("aria-controls");
  });

  it("moves selection and focus with arrows, Home and End, wrapping", () => {
    render(<Strip initial={seed(["a", "b", "c"])} />);
    act(() => tabs()[0].focus());

    fireEvent.keyDown(tabs()[0], { key: "ArrowRight" });
    expect(selected()).toHaveAccessibleName(/^Chat b/);
    expect(selected()).toHaveFocus();
    expect(selected()).toHaveAttribute("tabindex", "0");

    fireEvent.keyDown(selected()!, { key: "End" });
    expect(selected()).toHaveAccessibleName(/^Chat c/);
    fireEvent.keyDown(selected()!, { key: "ArrowRight" });
    expect(selected()).toHaveAccessibleName(/^Chat a/);
    fireEvent.keyDown(selected()!, { key: "ArrowLeft" });
    expect(selected()).toHaveAccessibleName(/^Chat c/);
    fireEvent.keyDown(selected()!, { key: "Home" });
    expect(selected()).toHaveAccessibleName(/^Chat a/);
    expect(selected()).toHaveFocus();
  });

  it("leaves modified arrows to the workspace shortcuts", () => {
    render(<Strip initial={seed(["a", "b"])} />);
    fireEvent.keyDown(tabs()[0], {
      key: "ArrowRight",
      metaKey: true,
      altKey: true,
      shiftKey: true,
    });
    expect(selected()).toHaveAccessibleName(/^Chat a/);
  });

  it.each(["Enter", "ArrowDown"])("%s enters the chat's composer", (key) => {
    const spies = handlers();
    render(<Strip initial={seed(["a", "b"])} spies={spies} />);
    fireEvent.keyDown(tabs()[1], { key });
    expect(spies.onEnterChat).toHaveBeenCalledWith("e-b");
  });

  it("clicking a tab enters its chat", () => {
    const spies = handlers();
    render(<Strip initial={seed(["a", "b"])} spies={spies} />);
    fireEvent.click(tabs()[1]);
    expect(spies.onEnterChat).toHaveBeenCalledWith("e-b");
  });

  it.each(["Delete", "Backspace"])(
    "%s closes the focused tab and focus follows to its neighbour",
    (key) => {
      const spies = handlers();
      render(<Strip initial={seed(["a", "b", "c"])} spies={spies} />);
      act(() => tabs()[0].focus());
      fireEvent.keyDown(tabs()[0], { key: "ArrowRight" });

      fireEvent.keyDown(selected()!, { key });
      expect(spies.onClose).toHaveBeenCalledWith("e-b");
      expect(tabs()).toHaveLength(2);
      expect(screen.getByRole("tab", { name: /^Chat c/ })).toHaveFocus();
    }
  );

  it("keeps the last open chat", () => {
    const spies = handlers();
    render(<Strip initial={seed(["a"])} spies={spies} />);
    fireEvent.keyDown(tabs()[0], { key: "Delete" });
    expect(spies.onClose).not.toHaveBeenCalled();
    expect(screen.queryByTestId("chat-tab-close")).toBeNull();
  });

  it("closes a chat from its close button", () => {
    const spies = handlers();
    render(<Strip initial={seed(["a", "b"])} spies={spies} />);
    fireEvent.click(screen.getByRole("button", { name: "Close Chat b" }));
    expect(spies.onClose).toHaveBeenCalledWith("e-b");
  });

  it("reorders by dragging a tab past its neighbour, without selecting", () => {
    const spies = handlers();
    render(<Strip initial={seed(["a", "b", "c"])} spies={spies} />);
    tabs().forEach((tab, index) => {
      tab.getBoundingClientRect = () =>
        ({ left: index * 100, width: 100 }) as DOMRect;
    });
    const tablist = screen.getByRole("tablist");
    fireEvent.pointerDown(tabs()[0], { button: 0, clientX: 10, pointerId: 1 });
    fireEvent.pointerMove(tablist, { clientX: 160, pointerId: 1 });
    fireEvent.pointerUp(tablist, { clientX: 160, pointerId: 1 });
    // Pointer capture retargets the click after a drag to the tablist.
    fireEvent.click(tablist);

    expect(spies.onMoveBefore).toHaveBeenCalledWith("e-a", "e-c");
    expect(tabs().map((tab) => tab.getAttribute("data-entry-id"))).toEqual([
      "e-b",
      "e-a",
      "e-c",
    ]);
    expect(spies.onEnterChat).not.toHaveBeenCalled();

    // Only that click is swallowed: the next one selects.
    fireEvent.click(tabs()[2]);
    expect(spies.onEnterChat).toHaveBeenCalledWith("e-c");
  });

  it("drops a dragged tab at the end past the last tab", () => {
    const spies = handlers();
    render(<Strip initial={seed(["a", "b", "c"])} spies={spies} />);
    tabs().forEach((tab, index) => {
      tab.getBoundingClientRect = () =>
        ({ left: index * 100, width: 100 }) as DOMRect;
    });
    const tablist = screen.getByRole("tablist");
    fireEvent.pointerDown(tabs()[0], { button: 0, clientX: 10, pointerId: 1 });
    fireEvent.pointerMove(tablist, { clientX: 290, pointerId: 1 });
    fireEvent.pointerUp(tablist, { clientX: 290, pointerId: 1 });

    expect(spies.onMoveBefore).toHaveBeenCalledWith("e-a", null);
    expect(tabs().map((tab) => tab.getAttribute("data-entry-id"))).toEqual([
      "e-b",
      "e-c",
      "e-a",
    ]);
  });

  it("does not swallow a click after a drag that ended elsewhere", () => {
    const spies = handlers();
    render(<Strip initial={seed(["a", "b"])} spies={spies} />);
    const tablist = screen.getByRole("tablist");
    fireEvent.pointerDown(tabs()[0], { button: 0, clientX: 10, pointerId: 1 });
    fireEvent.pointerMove(tablist, { clientX: 60, pointerId: 1 });
    fireEvent.pointerUp(tablist, { clientX: 60, pointerId: 1 });
    // No click follows (released outside the window); a new press resets.
    const chatB = screen.getByRole("tab", { name: /^Chat b/ });
    fireEvent.pointerDown(chatB, { button: 0, clientX: 10, pointerId: 2 });
    fireEvent.pointerUp(tablist, { clientX: 10, pointerId: 2 });
    fireEvent.click(chatB);
    expect(spies.onEnterChat).toHaveBeenCalledWith("e-b");
  });

  it("treats a press that does not travel as a click", () => {
    const spies = handlers();
    render(<Strip initial={seed(["a", "b"])} spies={spies} />);
    const tablist = screen.getByRole("tablist");
    fireEvent.pointerDown(tabs()[1], { button: 0, clientX: 10, pointerId: 1 });
    fireEvent.pointerMove(tablist, { clientX: 12, pointerId: 1 });
    fireEvent.pointerUp(tablist, { clientX: 12, pointerId: 1 });
    fireEvent.click(tabs()[1]);
    expect(spies.onMoveBefore).not.toHaveBeenCalled();
    expect(spies.onEnterChat).toHaveBeenCalledWith("e-b");
  });
});

describe("ChatTabStrip overflow", () => {
  let widthSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    // Room for two tabs beside the strip controls.
    widthSpy = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(88 + 112 * 2);
  });
  afterEach(() => widthSpy.mockRestore());

  it("moves tabs that do not fit into a +N menu", () => {
    const spies = handlers();
    render(<Strip initial={seed(["a", "b", "c", "d"])} spies={spies} />);
    expect(tabs()).toHaveLength(2);
    const trigger = screen.getByRole("button", { name: "2 more open chats" });
    expect(trigger).toHaveTextContent("+2");
    expect(screen.queryByTestId("chat-tabs-overflow-dot")).toBeNull();

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: /^Chat d/ }));
    expect(spies.onEnterChat).toHaveBeenCalledWith("e-d");
  });

  it("marks the +N menu when a hidden chat needs the user", () => {
    render(
      <Strip
        initial={seed(["a", "b", "c", "d"])}
        props={{ needingYou: ["e-c", "e-d"] }}
      />
    );
    expect(
      screen.getByRole("button", { name: "2 more open chats, 2 need you" })
    ).toBeVisible();
    expect(screen.getByTestId("chat-tabs-overflow-dot")).toBeInTheDocument();
  });

  it("drops past the last inline tab in front of the first hidden one", () => {
    const spies = handlers();
    render(<Strip initial={seed(["a", "b", "c", "d"])} spies={spies} />);
    tabs().forEach((tab, index) => {
      tab.getBoundingClientRect = () =>
        ({ left: index * 100, width: 100 }) as DOMRect;
    });
    const tablist = screen.getByRole("tablist");
    fireEvent.pointerDown(tabs()[0], { button: 0, clientX: 10, pointerId: 1 });
    fireEvent.pointerMove(tablist, { clientX: 190, pointerId: 1 });
    fireEvent.pointerUp(tablist, { clientX: 190, pointerId: 1 });

    expect(spies.onMoveBefore).toHaveBeenCalledWith("e-a", "e-c");
  });

  it("keeps the last inline tab in place when dropped past itself", () => {
    const spies = handlers();
    render(<Strip initial={seed(["a", "b", "c", "d"])} spies={spies} />);
    tabs().forEach((tab, index) => {
      tab.getBoundingClientRect = () =>
        ({ left: index * 100, width: 100 }) as DOMRect;
    });
    const tablist = screen.getByRole("tablist");
    fireEvent.pointerDown(tabs()[1], { button: 0, clientX: 110, pointerId: 1 });
    fireEvent.pointerMove(tablist, { clientX: 190, pointerId: 1 });
    fireEvent.pointerUp(tablist, { clientX: 190, pointerId: 1 });

    expect(spies.onMoveBefore).not.toHaveBeenCalled();
  });

  it("keeps the active chat inline", () => {
    const initial = seed(["a", "b", "c", "d"]);
    render(<Strip initial={initial} props={{ activeId: "e-d" }} />);
    expect(tabs().map((tab) => tab.getAttribute("data-entry-id"))).toEqual([
      "e-a",
      "e-d",
    ]);
  });
});

describe("ChatTabStrip status", () => {
  it("counts chats needing the user and jumps to the next one", () => {
    const spies = handlers();
    render(
      <Strip
        initial={seed(["a", "b"])}
        spies={spies}
        props={{ needingYou: ["e-a", "e-b"] }}
      />
    );
    const counter = screen.getByRole("button", {
      name: "2 chats need you; go to the next",
    });
    expect(counter).toHaveTextContent("2 need you");
    fireEvent.click(counter);
    expect(spies.onNextNeedingYou).toHaveBeenCalledTimes(1);
  });

  it("hides the counter when no chat needs the user", () => {
    render(<Strip initial={seed(["a"])} />);
    expect(screen.queryByTestId("chat-tabs-need-you")).toBeNull();
  });

  it("names the state in the tab and announces new attention once", () => {
    const initial = seed(["a", "b"]);
    render(<Strip initial={initial} />);
    expect(screen.getByTestId("chat-tabs-live")).toHaveTextContent("");

    act(() => {
      useChatStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          b: { ...state.sessions.b, lifecycle: "error" },
        },
      }));
    });
    expect(screen.getByRole("tab", { name: /^Chat b, Error/i })).toBeVisible();
    expect(screen.getByTestId("chat-tabs-live")).toHaveTextContent(/^Chat b: /);
    expect(
      within(screen.getByRole("tab", { name: /^Chat b/ })).getByTestId(
        "chat-tab-dot"
      )
    ).toHaveAttribute("data-attention", "error");
  });

  it("announces the same attention again after it clears", () => {
    const initial = seed(["a", "b"]);
    render(<Strip initial={initial} />);
    const setLifecycle = (lifecycle: ChatSession["lifecycle"]) =>
      act(() => {
        useChatStore.setState((state) => ({
          sessions: {
            ...state.sessions,
            b: { ...state.sessions.b, lifecycle },
          },
        }));
      });
    const live = screen.getByTestId("chat-tabs-live");

    setLifecycle("error");
    const first = live.firstElementChild;
    expect(first).toHaveTextContent(/^Chat b: /);
    setLifecycle(undefined);
    setLifecycle("error");
    // A fresh node with the same text, so screen readers read it again.
    expect(live.firstElementChild).not.toBe(first);
    expect(live.firstElementChild).toHaveTextContent(
      first?.textContent ?? "missing"
    );
  });
});

describe("ChatTabStrip controls", () => {
  it("offers no layout choice", () => {
    render(<Strip initial={seed(["a", "b"])} />);
    expect(screen.queryByRole("group", { name: "Layout" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Split" })).toBeNull();
  });

  it("links only the selected tab to the shown chat", () => {
    render(<Strip initial={seed(["a", "b"])} />);
    const [first, second] = tabs();
    expect(first).toHaveAttribute("aria-controls");
    expect(second).not.toHaveAttribute("aria-controls");
  });

  it("opens a fresh chat, toggles history and collapses", () => {
    const spies = handlers();
    render(<Strip initial={seed(["a"])} spies={spies} />);
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    fireEvent.click(screen.getByRole("button", { name: "Chat history" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Collapse chat workspace" })
    );
    expect(spies.onFreshChat).toHaveBeenCalledTimes(1);
    expect(spies.onToggleHistory).toHaveBeenCalledTimes(1);
    expect(spies.onToggleExpanded).toHaveBeenCalledTimes(1);
  });

  it("gives the close button a tooltip, not a native title", () => {
    render(<Strip initial={seed(["a", "b"])} />);
    const close = screen.getByRole("button", { name: "Close Chat b" });
    expect(close).not.toHaveAttribute("title");
    act(() => close.focus());
    expect(close).toHaveAccessibleDescription(/^Close chat/);
  });
});

describe("ChatTabStrip single chat", () => {
  it("keeps the lone tab out of the tab order and visually hidden", () => {
    render(<Strip initial={seed(["a"])} />);
    expect(screen.getByRole("tablist")).toHaveAttribute("data-single");
    expect(screen.getByRole("tab")).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("button", { name: "New chat" })).toBeVisible();
  });
});

describe("ChatTabStrip compact", () => {
  it("switches chats from a title menu instead of tabs", () => {
    const spies = handlers();
    render(
      <Strip
        initial={seed(["a", "b"])}
        spies={spies}
        props={{ expanded: false }}
      />
    );
    expect(screen.queryByRole("tablist")).toBeNull();
    const switcher = screen.getByRole("button", {
      name: /^Switch chat: Chat a/,
    });
    expect(switcher).toHaveTextContent("2");
    // The pane header below owns the visible title; the switcher does not
    // repeat it (its accessible name still names the chat).
    expect(switcher).not.toHaveTextContent("Chat a");
    fireEvent.click(switcher);
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /^Chat b/ }));
    expect(spies.onEnterChat).toHaveBeenCalledWith("e-b");
    // History and expand live in the pane header's menu, not a second row.
    expect(
      screen.queryByRole("button", { name: "Expand chat workspace" })
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Chat history" })).toBeNull();
  });

  it("collapses the whole row when there is nothing to switch or answer", () => {
    render(<Strip initial={seed(["a"])} props={{ expanded: false }} />);
    expect(screen.getByTestId("chat-tab-strip")).toHaveAttribute("data-empty");
  });

  it("keeps the row for several chats or chats needing you", () => {
    render(<Strip initial={seed(["a", "b"])} props={{ expanded: false }} />);
    expect(screen.getByTestId("chat-tab-strip")).not.toHaveAttribute(
      "data-empty"
    );
  });

  it("shows no switcher for a single chat", () => {
    render(<Strip initial={seed(["a"])} props={{ expanded: false }} />);
    expect(screen.queryByTestId("chat-tabs-switcher")).toBeNull();
  });
});

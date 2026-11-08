import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ChatPaneList } from "./ChatPaneList";
import { useChatStore } from "../../stores/chatStore";
import type { ChatPane, ChatSession } from "../../stores/chatStore";

const windowRenders = vi.hoisted(() => ({ count: 0 }));

vi.mock("./ChatWindow", () => ({
  ChatWindow: ({
    sessionId,
    showProjectContext,
  }: {
    sessionId: string;
    showProjectContext?: boolean;
  }) => {
    windowRenders.count++;

    return (
      <div
        data-testid="mock-chat-window"
        data-project-visible={showProjectContext}
      >
        <textarea
          data-testid="local-chat-composer"
          aria-label={`${sessionId} input`}
        />
      </div>
    );
  },
}));

function createSession(id: string): ChatSession {
  return {
    id,
    label: id,
    messages: [],
    status: "open",
    harness: "claude",
    backendSessionId: null,
    providerResumeId: null,
  };
}

function renderPaneList(count = 1, maximized = false) {
  const panes: ChatPane[] = Array.from({ length: count }, (_, index) => ({
    id: `pane-${index + 1}`,
    sessionId: `session-${index + 1}`,
  }));
  const sessionEntries = panes.map((pane) => {
    const session = createSession(pane.sessionId);

    return [pane.sessionId, session];
  });
  const sessions = Object.fromEntries(sessionEntries);

  useChatStore.setState({ sessions });

  const focusPane = vi.fn();
  const props = {
    visiblePanes: panes,
    activePaneId: null,
    isMaximized: maximized,
    canAddSplitPane: false,
    focusPane,
    closePane: vi.fn(),
    unsplitPanes: vi.fn(),
    closeChatPanel: vi.fn(),
    toggleHistorySelector: vi.fn(),
    toggleMaximized: vi.fn(),
    startFreshActiveSession: vi.fn(),
    splitWithFreshSession: vi.fn(),
  };

  const view = render(<ChatPaneList {...props} />);

  return { ...view, props, focusPane };
}

describe("ChatPaneList", () => {
  it("does not re-render the pane for live text deltas", () => {
    renderPaneList();

    const delta = (text: string) => {
      const store = useChatStore.getState();

      store.addMessage("session-1", {
        kind: "assistant",
        itemId: "live",
        turnId: "turn",
        text,
        timestamp: "2026-11-03T12:00:00Z",
        lifecycle: "streaming",
        isPartial: true,
      });
    };

    act(() => delta("first"));
    const before = windowRenders.count;

    act(() => {
      for (let index = 0; index < 10; index++) delta(` ${index}`);
    });

    expect(windowRenders.count).toBe(before);

    act(() => {
      useChatStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          "session-1": { ...state.sessions["session-1"], title: "Renamed" },
        },
      }));
    });

    const pane = screen.getByTestId("chat-pane");
    expect(pane).toHaveAttribute("aria-label", "Chat pane 1: Renamed");
  });

  it.each([1, 2])(
    "shows project context only with multiple visible panes (%s)",
    (count) => {
      renderPaneList(count);

      const panes = screen.getAllByTestId("mock-chat-window");
      const expectedVisibility = String(count > 1);

      for (const pane of panes) {
        expect(pane).toHaveAttribute(
          "data-project-visible",
          expectedVisibility
        );
      }
    }
  );

  it("focuses the clicked pane input after selecting the pane", () => {
    const { focusPane } = renderPaneList();
    const pane = screen.getByTestId("chat-pane");
    const input = screen.getByTestId("local-chat-composer");

    fireEvent.mouseDown(pane);

    expect(focusPane).toHaveBeenCalledWith("pane-1");
    expect(document.activeElement).toBe(input);
  });
});

describe("split pane allocation integration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("resizes just a pair, retains drafts/focus/instances and does not rerender chats", () => {
    const widthSpy = vi.spyOn(HTMLElement.prototype, "clientWidth", "get");
    widthSpy.mockReturnValue(1516);

    const { focusPane, props, rerender } = renderPaneList(3, true);
    const handles = screen.getAllByRole("separator");
    const panes = screen.getAllByTestId("chat-pane");
    const slots = panes.map((pane) => pane.parentElement!);
    const inputs = screen.getAllByTestId("local-chat-composer");

    expect(handles).toHaveLength(2);

    fireEvent.change(inputs[0], { target: { value: "draft" } });
    inputs[0].focus();
    const renders = windowRenders.count;

    fireEvent.keyDown(handles[0], { key: "ArrowRight" });

    const expectedWidths = [516, 484, 500];

    slots.forEach((slot, index) => {
      const width = parseFloat(slot.style.flexBasis);
      const expectedWidth = expectedWidths[index];

      expect(width).toBeCloseTo(expectedWidth, 6);
    });

    const resizedInputs = screen.getAllByTestId("local-chat-composer");

    expect(handles[0]).toHaveAttribute("aria-valuenow", "516");
    expect(resizedInputs[0]).toBe(inputs[0]);
    expect(inputs[0]).toHaveValue("draft");
    expect(inputs[0]).toHaveFocus();
    expect(windowRenders.count).toBe(renders);
    expect(focusPane).not.toHaveBeenCalled();

    const unrelatedCallbacks = [
      props.closePane,
      props.unsplitPanes,
      props.closeChatPanel,
      props.toggleHistorySelector,
      props.toggleMaximized,
    ];

    for (const callback of unrelatedCallbacks) {
      expect(callback).not.toHaveBeenCalled();
    }

    act(() => {
      const store = useChatStore.getState();

      store.addMessage("session-1", {
        kind: "assistant",
        text: "streamed",
        timestamp: "2026-11-08T12:00:00Z",
      });
    });

    expect(slots[0].style.flexBasis).toBe("516px");

    const remainingPanes = props.visiblePanes.slice(1);
    const replacementPane = {
      ...props.visiblePanes[0],
      sessionId: "session-2",
    };
    const replacementPanes = [replacementPane, ...remainingPanes];

    rerender(<ChatPaneList {...props} visiblePanes={replacementPanes} />);

    expect(slots[0].style.flexBasis).toBe("516px");

    rerender(<ChatPaneList {...props} visiblePanes={remainingPanes} />);

    const survivingHandles = screen.getAllByRole("separator");
    const survivingPanes = screen.getAllByTestId("chat-pane");
    const firstSurvivingSlot = survivingPanes[0].parentElement;

    expect(survivingHandles).toHaveLength(1);
    expect(firstSurvivingSlot?.dataset.paneId).toBe("pane-2");
    expect(firstSurvivingSlot?.style.flexBasis).toBe("754px");

    const compactPanes = props.visiblePanes.slice(0, 1);

    rerender(
      <ChatPaneList
        {...props}
        isMaximized={false}
        visiblePanes={compactPanes}
      />
    );

    const compactSeparator = screen.queryByRole("separator");
    expect(compactSeparator).not.toBeInTheDocument();

    rerender(<ChatPaneList {...props} />);

    const expandedPanes = screen.getAllByTestId("chat-pane");
    const firstExpandedSlot = expandedPanes[0].parentElement;

    expect(firstExpandedSlot?.style.flexBasis).toBe("500px");
  });

  it("retains preferred proportions through measured viewport and history changes", () => {
    let width = 1516;
    let measure = () => {};

    const widthSpy = vi.spyOn(HTMLElement.prototype, "clientWidth", "get");
    widthSpy.mockImplementation(() => width);

    class TestResizeObserver {
      constructor(callback: () => void) {
        measure = callback;
      }

      observe() {}
      disconnect() {}
    }

    vi.stubGlobal("ResizeObserver", TestResizeObserver);

    const { props, rerender } = renderPaneList(3, true);
    const handles = screen.getAllByRole("separator");
    const firstHandle = handles[0];
    const sizes = () => {
      const panes = screen.getAllByTestId("chat-pane");

      return panes.map((pane) => {
        const basis = pane.parentElement!.style.flexBasis;

        return parseFloat(basis);
      });
    };

    fireEvent.keyDown(firstHandle, { key: "ArrowRight" });
    const preferred = sizes();

    act(() => {
      width = 800;
      measure();
    });

    const minimumSizes = sizes();
    expect(minimumSizes).toEqual([360, 360, 360]);

    fireEvent.keyDown(firstHandle, { key: "ArrowLeft" });

    act(() => {
      width = 1816;
      measure();
    });

    const expandedSizes = sizes();

    expandedSizes.forEach((value, index) => {
      const expectedWidth = preferred[index] * 1.2;

      expect(value).toBeCloseTo(expectedWidth, 6);
    });

    act(() => {
      width = 1516;
      measure();
    });

    const restoredSizes = sizes();

    restoredSizes.forEach((value, index) => {
      expect(value).toBeCloseTo(preferred[index], 6);
    });

    const singlePane = props.visiblePanes.slice(0, 1);

    rerender(<ChatPaneList {...props} visiblePanes={singlePane} />);

    const singlePaneSeparator = screen.queryByRole("separator");
    expect(singlePaneSeparator).not.toBeInTheDocument();

    rerender(<ChatPaneList {...props} />);

    const normalizedSizes = sizes();
    expect(normalizedSizes).toEqual([500, 500, 500]);

    vi.unstubAllGlobals();
  });

  it("omits separators for a single expanded pane and compact layouts", () => {
    const { props, rerender } = renderPaneList(1, true);
    const expandedSeparator = screen.queryByRole("separator");

    expect(expandedSeparator).not.toBeInTheDocument();

    rerender(<ChatPaneList {...props} isMaximized={false} />);

    const compactSeparator = screen.queryByRole("separator");
    expect(compactSeparator).not.toBeInTheDocument();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ChatPaneList } from "./ChatPaneList";
import { useChatStore } from "../../stores/chatStore";
import type { ChatSession, LocalChatPane } from "../../stores/chatStore";
import { EMPTY_WORKSPACE } from "../../stores/chatWorkspace";

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

beforeEach(() => {
  useChatStore.setState({ paneLayout: EMPTY_WORKSPACE });
});

function renderPaneList(count = 1, showProjectContext = false) {
  const panes: LocalChatPane[] = Array.from({ length: count }, (_, index) => ({
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
    shownPane: panes[0],
    tabPanels: false,
    focusPane,
    closeChatPanel: vi.fn(),
    startFreshActiveSession: vi.fn(),
    showProjectContext,
  };

  const view = render(<ChatPaneList {...props} />);

  return { ...view, props, panes, focusPane };
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
    expect(pane).toHaveAttribute("aria-label", "Renamed");
  });

  it.each([false, true])(
    "passes the project-context flag to the chat (%s)",
    (showProjectContext) => {
      renderPaneList(1, showProjectContext);
      expect(screen.getByTestId("mock-chat-window")).toHaveAttribute(
        "data-project-visible",
        String(showProjectContext)
      );
    }
  );

  it("renders only the shown chat, as the active tab's panel", () => {
    const { props, panes, rerender } = renderPaneList(2);
    rerender(<ChatPaneList {...props} shownPane={panes[1]} tabPanels />);
    const slots = document.querySelectorAll(".hc-chat-pane-slot");
    expect(slots).toHaveLength(1);
    expect(slots[0]).toHaveAttribute("role", "tabpanel");
    expect(slots[0]).toHaveAttribute("id", "chat-tabpanel-pane-2");
    expect(slots[0]).toHaveAttribute("data-pane-id", "pane-2");
  });

  it("focuses the clicked pane input after selecting the pane", () => {
    const { focusPane } = renderPaneList();
    const pane = screen.getByTestId("chat-pane");
    const input = screen.getByTestId("local-chat-composer");

    fireEvent.mouseDown(pane);

    expect(focusPane).toHaveBeenCalledWith("pane-1");
    expect(document.activeElement).toBe(input);
  });
});

describe("leaving a focused chat", () => {
  it("parks focus on the pane list instead of the body", () => {
    const { props, panes, rerender, container } = renderPaneList(2);
    const first = screen.getByTestId("local-chat-composer");
    first.focus();

    // The second tab is chosen: the focused first chat unmounts.
    rerender(<ChatPaneList {...props} shownPane={panes[1]} />);

    expect(first.isConnected).toBe(false);
    expect(document.activeElement).toBe(
      container.querySelector(".hc-chat-panes")
    );
  });

  it("leaves focus alone when the chat unmounts without it", () => {
    const { props, panes, rerender } = renderPaneList(2);
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();

    rerender(<ChatPaneList {...props} shownPane={panes[1]} />);

    expect(outside).toHaveFocus();
    outside.remove();
  });
});

describe("single chat layout", () => {
  it("renders no pane resize separators", () => {
    renderPaneList(2);
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
  });
});

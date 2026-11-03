import { describe, expect, it, vi } from "vitest";
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
  }) => (
    windowRenders.count++,
    (
      <div
        data-testid="mock-chat-window"
        data-project-visible={showProjectContext}
      >
        <textarea
          data-testid="local-chat-composer"
          aria-label={`${sessionId} input`}
        />
      </div>
    )
  ),
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

function renderPaneList(count = 1) {
  const panes: ChatPane[] = Array.from({ length: count }, (_, index) => ({
    id: `pane-${index + 1}`,
    sessionId: `session-${index + 1}`,
  }));
  const focusPane = vi.fn();
  useChatStore.setState({
    sessions: Object.fromEntries(
      panes.map((pane) => [pane.sessionId, createSession(pane.sessionId)])
    ),
  });

  render(
    <ChatPaneList
      visiblePanes={panes}
      activePaneId={null}
      isMaximized={false}
      canAddSplitPane={false}
      focusPane={focusPane}
      closePane={vi.fn()}
      unsplitPanes={vi.fn()}
      closeChatPanel={vi.fn()}
      toggleHistorySelector={vi.fn()}
      toggleMaximized={vi.fn()}
      startFreshActiveSession={vi.fn()}
      splitWithFreshSession={vi.fn()}
    />
  );

  return { focusPane };
}

describe("ChatPaneList", () => {
  it("does not re-render the pane for live text deltas", () => {
    renderPaneList();
    const delta = (text: string) =>
      useChatStore.getState().addMessage("session-1", {
        kind: "assistant",
        itemId: "live",
        turnId: "turn",
        text,
        timestamp: "2026-11-03T12:00:00Z",
        lifecycle: "streaming",
        isPartial: true,
      });

    act(() => delta("first"));
    const before = windowRenders.count;
    act(() => {
      for (let index = 0; index < 10; index++) delta(` ${index}`);
    });
    expect(windowRenders.count).toBe(before);

    act(() =>
      useChatStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          "session-1": { ...state.sessions["session-1"], title: "Renamed" },
        },
      }))
    );
    expect(screen.getByTestId("chat-pane")).toHaveAttribute(
      "aria-label",
      "Chat pane 1: Renamed"
    );
  });

  it.each([1, 2])(
    "shows project context only with multiple visible panes (%s)",
    (count) => {
      renderPaneList(count);
      for (const pane of screen.getAllByTestId("mock-chat-window")) {
        expect(pane).toHaveAttribute("data-project-visible", String(count > 1));
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

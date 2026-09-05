import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ChatPaneList } from "./ChatPaneList";
import { useChatStore } from "../../stores/chatStore";
import type { ChatPane, ChatSession } from "../../stores/chatStore";

vi.mock("./ChatWindow", () => ({
  ChatWindow: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="mock-chat-window">
      <textarea
        data-testid="local-chat-composer"
        aria-label={`${sessionId} input`}
      />
    </div>
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

function renderPaneList() {
  const panes: ChatPane[] = [{ id: "pane-1", sessionId: "session-1" }];
  const focusPane = vi.fn();
  useChatStore.setState({
    sessions: { "session-1": createSession("session-1") },
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
  it("focuses the clicked pane input after selecting the pane", () => {
    const { focusPane } = renderPaneList();
    const pane = screen.getByTestId("chat-pane");
    const input = screen.getByTestId("local-chat-composer");

    fireEvent.mouseDown(pane);

    expect(focusPane).toHaveBeenCalledWith("pane-1");
    expect(document.activeElement).toBe(input);
  });
});

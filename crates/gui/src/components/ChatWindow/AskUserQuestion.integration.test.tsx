import { invoke } from "@tauri-apps/api/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { routePermissionRequestEvent } from "../../hooks/useLocalChatEventRouter";
import { useChatStore, type ChatSession } from "../../stores/chatStore";
import { ChatMessages } from "./ChatMessages";

Element.prototype.scrollIntoView = vi.fn();

function TestChat() {
  const session = useChatStore((state) => state.sessions.session);
  return (
    <ChatMessages
      sessionId="session"
      messages={session.messages}
      assistantLabel="Claude"
      isEmpty={session.messages.length === 0}
      isActive={session.backendSessionId !== null}
      isWaiting={false}
      streamingAssistant={null}
    />
  );
}

describe("AskUserQuestion frontend integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const session: ChatSession = {
      id: "session",
      label: "Claude",
      messages: [],
      status: "open",
      harness: "claude",
      backendSessionId: "backend-1",
      providerResumeId: "conversation-1",
      lifecycle: "streaming",
    };
    useChatStore.setState({
      sessions: { session },
      activeSessionId: "session",
      paneLayout: { panes: [], activePaneId: null },
      panelOpen: true,
      localSessionSummaries: {},
    });
  });

  it("routes the real event through store/card and generated command wrapper", async () => {
    const originalQuestions = [
      {
        question: "Which layers?",
        header: "Scope",
        options: [
          { label: "Backend", description: "Rust" },
          { label: "Frontend", description: "React" },
        ],
        multiSelect: true,
      },
    ];
    const questions = originalQuestions.map(({ multiSelect, ...question }) => ({
      ...question,
      multi_select: multiSelect,
    }));
    vi.mocked(invoke).mockResolvedValue({
      behavior: "allow",
      updatedInput: {
        questions: originalQuestions,
        answers: { "Which layers?": "Backend, Frontend" },
      },
    });

    expect(
      routePermissionRequestEvent({
        request_id: "request-1",
        session_id: "backend-1",
        tool_name: "AskUserQuestion",
        tool_use_id: "tool-1",
        input: { questions: originalQuestions },
        message: "AskUserQuestion needs approval",
        questions,
        input_error: null,
      })
    ).toBe(true);

    render(<TestChat />);
    expect(screen.getAllByText("Which layers?")).toHaveLength(1);
    fireEvent.click(screen.getByLabelText(/Frontend/));
    fireEvent.click(screen.getByLabelText(/Backend/));
    fireEvent.click(screen.getByRole("button", { name: "Submit answers" }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("resolve_permission_request", {
        input: {
          request_id: "request-1",
          behavior: "allow",
          message: null,
          updated_input: {
            questions: originalQuestions,
            answers: { "Which layers?": "Backend, Frontend" },
          },
        },
      })
    );
    expect(await screen.findByText("Answered")).toBeInTheDocument();
    expect(useChatStore.getState().sessions.session.messages).toEqual([
      expect.objectContaining({
        kind: "user_question",
        requestId: "request-1",
        status: "resolved",
      }),
    ]);
  });
});

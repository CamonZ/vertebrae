import type { ComponentProps } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatMessages } from "./ChatMessages";
import type { ChatMessage } from "../../stores/chatStore";
import { useEntityPanelStore } from "../../stores/entityPanelStore";

const { markdownRenderSpy } = vi.hoisted(() => ({
  markdownRenderSpy: vi.fn(),
}));

vi.mock("react-markdown", async () => {
  const actual =
    await vi.importActual<typeof import("react-markdown")>("react-markdown");
  const Markdown = actual.default;
  return {
    ...actual,
    default: (props: ComponentProps<typeof Markdown>) => {
      markdownRenderSpy(props.children);
      return <Markdown {...props} />;
    },
  };
});

Element.prototype.scrollIntoView = vi.fn();

function defaultProps(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "test-session",
    messages: [] as ChatMessage[],
    assistantLabel: "Claude",
    isEmpty: true,
    isActive: false,
    isWaiting: false,
    activityLabel: null,
    streamingAssistant: null,
    ...overrides,
  };
}

describe("ChatMessages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useEntityPanelStore.getState().reset();
  });

  // --- Empty state ---

  it("shows the empty state message when isEmpty and not active", () => {
    render(<ChatMessages {...defaultProps()} />);
    expect(
      screen.getByText("Create, edit, and delete tasks, steps, and workflows")
    ).toBeInTheDocument();
    expect(
      screen.getByText("Or run a task through a workflow")
    ).toBeInTheDocument();
  });

  it("hides the empty state when not empty", () => {
    const messages: ChatMessage[] = [
      { kind: "user", text: "Hello", timestamp: "2024-01-01T12:00:00Z" },
    ];
    render(<ChatMessages {...defaultProps({ messages, isEmpty: false })} />);
    expect(
      screen.queryByText("Create, edit, and delete tasks, steps, and workflows")
    ).not.toBeInTheDocument();
  });

  it("hides the empty state when active even with no messages", () => {
    render(
      <ChatMessages {...defaultProps({ isEmpty: true, isActive: true })} />
    );
    expect(
      screen.queryByText("Create, edit, and delete tasks, steps, and workflows")
    ).not.toBeInTheDocument();
  });

  // --- Message rendering ---

  it("renders user messages", () => {
    const messages: ChatMessage[] = [
      { kind: "user", text: "Hello world", timestamp: "2024-01-01T12:00:00Z" },
    ];
    render(<ChatMessages {...defaultProps({ messages, isEmpty: false })} />);
    expect(screen.getByText("Hello world")).toBeInTheDocument();
  });

  it("wraps local chat threads in the bare event-log surface", () => {
    const messages: ChatMessage[] = [
      {
        kind: "user",
        text: "Please use `vtb ready`",
        timestamp: "2024-01-01T12:00:00Z",
      },
      {
        kind: "assistant",
        text: "I will check it.",
        timestamp: "2024-01-01T12:00:01Z",
      },
      {
        kind: "tool_call",
        toolName: "Bash",
        toolId: "tool-1",
        input: '{"command":"vtb ready"}',
        timestamp: "2024-01-01T12:00:02Z",
      },
    ];
    const { container } = render(
      <ChatMessages {...defaultProps({ messages, isEmpty: false })} />
    );

    const eventLog = container.querySelector(".evlog.evlog--bare");
    expect(eventLog).toBeInTheDocument();
    const userRow = eventLog?.querySelector(".evrow--user");
    expect(userRow).toBeInTheDocument();
    expect(
      eventLog?.querySelector(
        ".evlog--bare .evrow--user:not(.is-prompt):not(.is-system)"
      )
    ).toBe(userRow);
    expect(userRow?.querySelector(".evbody")).toBeInTheDocument();
    expect(userRow).toHaveTextContent("You");
    expect(eventLog?.querySelector(".evrow--agent")).toBeInTheDocument();
    expect(eventLog?.querySelector(".evrow--tool")).toBeInTheDocument();
  });

  it("renders assistant messages", () => {
    const messages: ChatMessage[] = [
      {
        kind: "assistant",
        text: "Hi there",
        timestamp: "2024-01-01T12:00:00Z",
      },
    ];
    render(<ChatMessages {...defaultProps({ messages, isEmpty: false })} />);
    expect(screen.getByText("Hi there")).toBeInTheDocument();
  });

  it("opens a task panel from an entity link in an assistant chat row", async () => {
    const user = userEvent.setup();
    const taskId = "03111754-4769-47c1-a64c-078d73554af8";
    const messages: ChatMessage[] = [
      {
        kind: "assistant",
        text: `See [the task](vtb://task/${taskId})`,
        timestamp: "2024-01-01T12:00:00Z",
      },
    ];

    render(<ChatMessages {...defaultProps({ messages, isEmpty: false })} />);

    await user.click(screen.getByTestId("vtb-entity-link"));

    expect(useEntityPanelStore.getState().selection).toEqual({
      type: "task",
      taskId,
    });
  });

  it("renders the flat agent spawn marker without child-agent transcript prose", () => {
    const messages: ChatMessage[] = [
      {
        kind: "tool_call",
        toolName: "Agent",
        toolId: "agent-1",
        input: JSON.stringify({ description: "Inspect repo" }),
        timestamp: "2024-01-01T12:00:00Z",
      },
      {
        kind: "assistant",
        text: "child-only prose",
        timestamp: "2024-01-01T12:00:01Z",
        parentToolUseId: "agent-1",
      },
    ];
    render(<ChatMessages {...defaultProps({ messages, isEmpty: false })} />);
    // The spawn row itself renders from the spawn call's description, while
    // child-thread prose stays out of the parent transcript.
    expect(screen.getByText("Inspect repo")).toBeInTheDocument();
    expect(screen.queryByText("child-only prose")).not.toBeInTheDocument();
  });

  it("renders permission request messages", () => {
    const messages: ChatMessage[] = [
      {
        kind: "permission_request",
        requestId: "req-1",
        toolName: "Bash",
        message: "Run command",
        input: undefined,
        timestamp: "2024-01-01T12:00:00Z",
      },
    ];
    render(<ChatMessages {...defaultProps({ messages, isEmpty: false })} />);
    expect(screen.getByText("Bash")).toBeInTheDocument();
    expect(screen.getByText("Run command")).toBeInTheDocument();
    expect(screen.getByText("Permission required")).toBeInTheDocument();
  });

  it("preserves tool expansion when conversation segmentation remounts the row", () => {
    const tail = "PRESERVED-AFTER-REMOUNT";
    const largeResult = `${"large output line\n".repeat(800)}${tail}`;
    const toolMessages: ChatMessage[] = [
      {
        kind: "tool_call",
        toolName: "Read",
        toolId: "tool-stable",
        input: "{}",
        timestamp: "2024-01-01T12:00:01Z",
      },
      {
        kind: "tool_result",
        toolId: "tool-stable",
        result: largeResult,
        isError: false,
        timestamp: "2024-01-01T12:00:02Z",
      },
    ];
    const { rerender } = render(
      <ChatMessages
        {...defaultProps({ messages: toolMessages, isEmpty: false })}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Read/ }));
    fireEvent.click(screen.getByRole("button", { name: /Show full content/ }));
    expect(screen.getByText((text) => text.endsWith(tail))).toBeInTheDocument();

    rerender(
      <ChatMessages
        {...defaultProps({
          messages: [
            {
              kind: "user",
              text: "Before remount",
              timestamp: "2024-01-01T12:00:00Z",
            },
            {
              kind: "permission_request",
              requestId: "req-remount",
              toolName: "Bash",
              message: "Allow command?",
              input: undefined,
              timestamp: "2024-01-01T12:00:00Z",
            },
            ...toolMessages,
          ],
          isEmpty: false,
        })}
      />
    );

    expect(screen.getByText((text) => text.endsWith(tail))).toBeInTheDocument();
    expect(
      screen.queryByTestId("bounded-content-preview")
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Read/ })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
  });

  it("renders a structured user question exactly once", () => {
    const questions = [
      {
        question: "Choose a target",
        header: "Target",
        options: [{ label: "Web", description: "Browser app" }],
        multi_select: false,
      },
    ];
    const messages: ChatMessage[] = [
      {
        kind: "user_question",
        requestId: "req-1",
        toolUseId: "tool-1",
        questions,
        originalQuestions: questions,
        status: "pending",
        timestamp: "2026-07-14T00:00:00Z",
      },
    ];
    render(
      <ChatMessages
        {...defaultProps({ messages, isEmpty: false, isActive: true })}
      />
    );
    expect(screen.getAllByText("Choose a target")).toHaveLength(1);
    expect(screen.getAllByText("Web")).toHaveLength(1);
  });

  // --- Thinking indicator ---

  it("shows ThinkingIndicator when isWaiting is true", () => {
    const messages: ChatMessage[] = [
      { kind: "user", text: "Hello", timestamp: "2024-01-01T12:00:00Z" },
    ];
    render(
      <ChatMessages
        {...defaultProps({ messages, isEmpty: false, isWaiting: true })}
      />
    );
    expect(screen.getByText("Thinking...")).toBeInTheDocument();
  });

  it("does not show ThinkingIndicator when isWaiting is false", () => {
    const messages: ChatMessage[] = [
      { kind: "user", text: "Hello", timestamp: "2024-01-01T12:00:00Z" },
    ];
    render(
      <ChatMessages
        {...defaultProps({ messages, isEmpty: false, isWaiting: false })}
      />
    );
    expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
  });

  it("shows a stopping label for a stopping active turn", () => {
    render(
      <ChatMessages
        {...defaultProps({
          isEmpty: false,
          isWaiting: true,
          activityLabel: "Stopping...",
        })}
      />
    );
    expect(screen.getByText("Stopping...")).toBeInTheDocument();
  });

  it("renders an accessible indeterminate compaction label in the activity area", () => {
    render(
      <ChatMessages
        {...defaultProps({
          isEmpty: false,
          isWaiting: true,
          activityLabel: "Compacting conversation…",
        })}
      />
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Compacting conversation…"
    );
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
  });

  it("shows completion metadata without adding a transcript message", () => {
    render(
      <ChatMessages
        {...defaultProps({
          isEmpty: true,
          compactionSummary: { trigger: "auto", preTokens: 4096 },
        })}
      />
    );
    expect(screen.getByTestId("chat-compaction-summary")).toHaveTextContent(
      "Conversation compacted (auto) · 4,096 tokens before compaction"
    );
    expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
  });

  // --- Scroll-to-spawn event ---

  it("handles scroll-to-spawn events without crashing for non-existent spawn", () => {
    const messages: ChatMessage[] = [
      { kind: "user", text: "Hello", timestamp: "2024-01-01T12:00:00Z" },
    ];
    render(
      <ChatMessages
        {...defaultProps({
          sessionId: "test-session",
          messages,
          isEmpty: false,
        })}
      />
    );

    // Since messageRefs is internal, we just verify the listener doesn't
    // crash when dispatching an event for a non-existent spawn.
    expect(() => {
      window.dispatchEvent(
        new CustomEvent("local-chat-scroll-to-spawn", {
          detail: { sessionId: "test-session", spawnId: "non-existent" },
        })
      );
    }).not.toThrow();
  });

  it("ignores scroll-to-spawn events for other sessions", () => {
    render(
      <ChatMessages
        {...defaultProps({
          sessionId: "test-session",
          isEmpty: false,
        })}
      />
    );

    // Clear calls from the initial mount auto-scroll effect
    vi.mocked(Element.prototype.scrollIntoView).mockClear();

    // Dispatch for a different session; should not trigger additional scrolls.
    window.dispatchEvent(
      new CustomEvent("local-chat-scroll-to-spawn", {
        detail: { sessionId: "other-session", spawnId: "some-spawn" },
      })
    );

    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it("keeps historical rows mounted while repeated streaming deltas replace only the tail", () => {
    const messages: ChatMessage[] = [
      {
        kind: "assistant",
        text: "Finalized history",
        timestamp: "2024-01-01T12:00:00Z",
      },
    ];
    const { rerender } = render(
      <ChatMessages
        {...defaultProps({
          messages,
          isEmpty: false,
          streamingAssistant: {
            text: "First draft",
            timestamp: "2024-01-01T12:00:01Z",
          },
        })}
      />
    );
    const historicalRow = screen
      .getByText("Finalized history")
      .closest(".evrow--agent");

    expect(historicalRow).toBeInTheDocument();
    expect(screen.getByTestId("chat-streaming-tail")).toHaveTextContent(
      "First draft"
    );
    markdownRenderSpy.mockClear();

    rerender(
      <ChatMessages
        {...defaultProps({
          messages,
          isEmpty: false,
          streamingAssistant: {
            text: "Second draft",
            timestamp: "2024-01-01T12:00:01Z",
          },
        })}
      />
    );

    expect(screen.getByText("Finalized history").closest(".evrow--agent")).toBe(
      historicalRow
    );
    expect(screen.getAllByText("Finalized history")).toHaveLength(1);
    expect(
      markdownRenderSpy.mock.calls.filter(
        ([text]) => text === "Finalized history"
      )
    ).toHaveLength(0);
    expect(screen.queryByText("First draft")).not.toBeInTheDocument();
    expect(screen.getByTestId("chat-streaming-tail")).toHaveTextContent(
      "Second draft"
    );
  });

  it("replaces the streaming tail with exactly one finalized assistant row", () => {
    const history: ChatMessage[] = [
      { kind: "user", text: "Question", timestamp: "2024-01-01T12:00:00Z" },
    ];
    const { rerender } = render(
      <ChatMessages
        {...defaultProps({
          messages: history,
          isEmpty: false,
          streamingAssistant: {
            text: "Complete answer",
            timestamp: "2024-01-01T12:00:01Z",
          },
        })}
      />
    );

    expect(screen.getByTestId("chat-streaming-tail")).toHaveTextContent(
      "Complete answer"
    );

    rerender(
      <ChatMessages
        {...defaultProps({
          messages: [
            ...history,
            {
              kind: "assistant",
              text: "Complete answer",
              timestamp: "2024-01-01T12:00:01Z",
              isPartial: false,
            },
          ],
          isEmpty: false,
          streamingAssistant: null,
        })}
      />
    );

    expect(screen.queryByTestId("chat-streaming-tail")).not.toBeInTheDocument();
    expect(screen.getAllByText("Complete answer")).toHaveLength(1);
    expect(document.querySelector(".ev-cursor")).not.toBeInTheDocument();
  });

  it("scrolls the message container instead of scrolling ancestors for streaming updates", () => {
    const messages: ChatMessage[] = [
      { kind: "user", text: "Hello", timestamp: "2024-01-01T12:00:00Z" },
    ];
    const { rerender } = render(
      <ChatMessages {...defaultProps({ messages, isEmpty: false })} />
    );
    const container = screen.getByTestId("chat-messages-scroll");
    Object.defineProperties(container, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 400 },
    });
    container.scrollTop = 300;
    fireEvent.scroll(container);
    vi.mocked(Element.prototype.scrollIntoView).mockClear();

    rerender(
      <ChatMessages
        {...defaultProps({
          messages,
          isEmpty: false,
          streamingAssistant: { text: "streaming", timestamp: "now" },
        })}
      />
    );

    expect(container.scrollTop).toBe(400);
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();

    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      value: 500,
    });
    rerender(
      <ChatMessages
        {...defaultProps({
          messages,
          isEmpty: false,
          streamingAssistant: { text: "streaming more", timestamp: "now" },
        })}
      />
    );

    expect(container.scrollTop).toBe(500);
  });

  it("does not steal the user's position when they scroll away from the bottom", () => {
    const messages: ChatMessage[] = [
      { kind: "user", text: "Hello", timestamp: "2024-01-01T12:00:00Z" },
    ];
    const { rerender } = render(
      <ChatMessages {...defaultProps({ messages, isEmpty: false })} />
    );
    const container = screen.getByTestId("chat-messages-scroll");
    Object.defineProperties(container, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 1_000 },
    });
    container.scrollTop = 200;
    fireEvent.scroll(container);

    rerender(
      <ChatMessages
        {...defaultProps({
          messages,
          isEmpty: false,
          streamingAssistant: { text: "more", timestamp: "now" },
        })}
      />
    );

    expect(container.scrollTop).toBe(200);
  });
});

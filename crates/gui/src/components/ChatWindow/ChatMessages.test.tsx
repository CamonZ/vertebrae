import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ChatMessages } from "./ChatMessages";
import type { ChatMessage } from "../../stores/chatStore";

Element.prototype.scrollIntoView = vi.fn();

function defaultProps(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "test-session",
    messages: [] as ChatMessage[],
    assistantLabel: "Claude",
    isEmpty: true,
    isActive: false,
    isWaiting: false,
    streamingAssistant: null,
    ...overrides,
  };
}

describe("ChatMessages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});

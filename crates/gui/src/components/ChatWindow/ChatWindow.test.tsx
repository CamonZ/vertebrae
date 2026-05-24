import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatWindow } from "./ChatWindow";
import { useChatStore } from "../../stores/chatStore";
import type { ChatSession } from "../../stores/chatStore";

// Mock scrollIntoView
Element.prototype.scrollIntoView = vi.fn();

// Mock the bindings
vi.mock("../../bindings", () => ({
  commands: {
    getCurrentProjectPath: vi.fn().mockResolvedValue({
      status: "ok",
      data: "/test/project",
    }),
    createClaudeSession: vi.fn().mockResolvedValue({ status: "ok" }),
    sendClaudeMessage: vi.fn().mockResolvedValue({ status: "ok" }),
    closeClaudeSession: vi.fn().mockResolvedValue({ status: "ok" }),
    getTask: vi.fn().mockResolvedValue({ status: "ok", data: null }),
    getStep: vi.fn().mockResolvedValue({ status: "ok", data: null }),
    getWorkflowWithTasks: vi
      .fn()
      .mockResolvedValue({ status: "ok", data: null }),
    getCurrentProject: vi
      .fn()
      .mockResolvedValue({ status: "ok", data: "test-project" }),
    getTaskExecutions: vi
      .fn()
      .mockResolvedValue({ status: "ok", data: [] }),
  },
  events: {
    claudeSessionInitEvent: { listen: vi.fn(() => Promise.resolve(() => {})) },
    claudeSessionUsageEvent: { listen: vi.fn(() => Promise.resolve(() => {})) },
    claudeTextEvent: { listen: vi.fn(() => Promise.resolve(() => {})) },
    claudeToolCallEvent: { listen: vi.fn(() => Promise.resolve(() => {})) },
    claudeToolResultEvent: { listen: vi.fn(() => Promise.resolve(() => {})) },
    claudePermissionRequestEvent: {
      listen: vi.fn(() => Promise.resolve(() => {})),
    },
    claudeSessionEndEvent: { listen: vi.fn(() => Promise.resolve(() => {})) },
    claudeSessionErrorEvent: {
      listen: vi.fn(() => Promise.resolve(() => {})),
    },
  },
}));

function createSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "test-session",
    scope: "task",
    entityId: "task-1",
    label: "Test Task",
    messages: [],
    status: "open",
    claudeSessionId: null,
    claudeConversationId: null,
    contextSummary: null,
    ...overrides,
  };
}

describe("ChatWindow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useChatStore.setState({
      sessions: {},
      activeSessionId: null,
      panelOpen: false,
    });
  });

  it("returns null when session does not exist", () => {
    const { container } = render(<ChatWindow sessionId="non-existent" />);
    expect(container.innerHTML).toBe("");
  });

  it("renders scope breadcrumb with correct scope label", () => {
    const session = createSession({ scope: "task", label: "My Task" });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByText("Task")).toBeInTheDocument();
    expect(screen.getByText("My Task")).toBeInTheDocument();
  });

  it("renders workflow scope breadcrumb", () => {
    const session = createSession({
      scope: "workflow",
      entityId: "wf-1",
      label: "Deploy Pipeline",
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByText("Workflow")).toBeInTheDocument();
    expect(screen.getByText("Deploy Pipeline")).toBeInTheDocument();
  });

  it("shows widen button for non-project scopes", () => {
    const session = createSession({ scope: "step", label: "Step 1" });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByTitle("Widen scope to Task")).toBeInTheDocument();
  });

  it("does not show widen button for project scope", () => {
    const session = createSession({
      scope: "project",
      entityId: null,
      label: "Project Chat",
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.queryByTitle(/Widen scope/)).not.toBeInTheDocument();
  });

  it("shows empty state message when no messages", () => {
    const session = createSession();
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(
      screen.getByText("Chat scoped to task")
    ).toBeInTheDocument();
    expect(
      screen.getByText("Type a message and press Enter to begin")
    ).toBeInTheDocument();
  });

  it("renders user messages from store", () => {
    const session = createSession({
      messages: [
        {
          kind: "user",
          text: "Hello from store",
          timestamp: "2024-01-01T12:00:00Z",
        },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByText("Hello from store")).toBeInTheDocument();
  });

  it("renders assistant messages from store", () => {
    const session = createSession({
      messages: [
        {
          kind: "assistant",
          text: "I can help with that!",
          timestamp: "2024-01-01T12:00:00Z",
          isPartial: false,
        },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByText("I can help with that!")).toBeInTheDocument();
  });

  it("renders error messages", () => {
    const session = createSession({
      messages: [
        {
          kind: "error",
          message: "Connection failed",
          timestamp: "2024-01-01T12:00:00Z",
        },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByText("Connection failed")).toBeInTheDocument();
  });

  it("renders tool call messages", () => {
    const session = createSession({
      messages: [
        {
          kind: "tool_call",
          toolName: "Read",
          toolId: "tool-1",
          input: '{"file_path": "/test.ts"}',
          timestamp: "2024-01-01T12:00:00Z",
        },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    // Tool name is the collapsed header label.
    expect(screen.getByText("Read")).toBeInTheDocument();
    // Input is hidden until the block is expanded.
    expect(
      screen.queryByText('{"file_path": "/test.ts"}')
    ).toBeNull();
  });

  it("shows context summary when present", () => {
    const session = createSession({
      contextSummary: "[Context: Task]\nTask: My Important Task",
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByText("Context injected")).toBeInTheDocument();
  });

  it("shows end session button when session has claude backend", () => {
    const session = createSession({ claudeSessionId: "claude-abc" });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByTitle("End session")).toBeInTheDocument();
  });

  it("does not show end session button when not active", () => {
    const session = createSession({ claudeSessionId: null });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.queryByTitle("End session")).not.toBeInTheDocument();
  });

  it("has clear messages button", () => {
    const session = createSession();
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByTitle("Clear messages")).toBeInTheDocument();
  });

  it("clears messages when clear button is clicked", async () => {
    const user = userEvent.setup();
    const session = createSession({
      messages: [
        {
          kind: "user",
          text: "Hello",
          timestamp: "2024-01-01T12:00:00Z",
        },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByText("Hello")).toBeInTheDocument();

    await user.click(screen.getByTitle("Clear messages"));

    expect(
      useChatStore.getState().sessions["test-session"].messages
    ).toHaveLength(0);
  });

  it("shows placeholder text for idle session", () => {
    const session = createSession({ claudeSessionId: null });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(
      screen.getByPlaceholderText("Type a message to start...")
    ).toBeInTheDocument();
  });

  it("shows placeholder text for active session", () => {
    const session = createSession({ claudeSessionId: "claude-abc" });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(
      screen.getByPlaceholderText("Type a message...")
    ).toBeInTheDocument();
  });

  it("shows closed status indicator for closed sessions", () => {
    const session = createSession({ status: "closed" });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    // The scope header should have a muted dot for closed status
    screen.getByText("Test Task");
    // Closed session indicator is a sibling of the header content
    expect(screen.getByTestId("chat-closed-dot")).toBeInTheDocument();
  });

  // --- A) User interaction flow ---

  it("sends message when send button is clicked and clears input", async () => {
    const user = userEvent.setup();
    const session = createSession({ claudeSessionId: "claude-abc" });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    const textarea = screen.getByPlaceholderText("Type a message...");
    await user.type(textarea, "Hello world");
    expect(textarea).toHaveValue("Hello world");

    await user.click(screen.getByTitle("Send message"));

    expect(textarea).toHaveValue("");
  });

  it("sends message on Enter key and clears input", async () => {
    const user = userEvent.setup();
    const session = createSession({ claudeSessionId: "claude-abc" });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    const textarea = screen.getByPlaceholderText("Type a message...");
    await user.type(textarea, "Test message");
    await user.keyboard("{Enter}");

    expect(textarea).toHaveValue("");
  });

  it("does not send whitespace-only messages", async () => {
    const user = userEvent.setup();
    const session = createSession({ claudeSessionId: "claude-abc" });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    const textarea = screen.getByPlaceholderText("Type a message...");
    await user.type(textarea, "   ");
    await user.keyboard("{Enter}");

    // Input not cleared because send was blocked by trim() check
    expect(textarea).toHaveValue("   ");
  });

  it("starts session on Enter when not active and input has text", async () => {
    const user = userEvent.setup();
    const session = createSession({ claudeSessionId: null });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    const textarea = screen.getByPlaceholderText("Type a message to start...");
    await user.type(textarea, "Start chat");
    await user.keyboard("{Enter}");

    // Input cleared after starting session
    expect(textarea).toHaveValue("");
  });

  // --- B) Conditional indicators presence AND absence ---

  it("shows partial cursor for streaming assistant messages", () => {
    const session = createSession({
      messages: [
        {
          kind: "assistant",
          text: "Still typing...",
          timestamp: "2024-01-01T12:00:00Z",
          isPartial: true,
        },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(document.querySelector(".animate-pulse")).toBeInTheDocument();
  });

  it("does not show partial cursor for complete assistant messages", () => {
    const session = createSession({
      messages: [
        {
          kind: "assistant",
          text: "Done",
          timestamp: "2024-01-01T12:00:00Z",
          isPartial: false,
        },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(document.querySelector(".animate-pulse")).not.toBeInTheDocument();
  });

  it("shows thinking indicator when waiting for response", () => {
    const session = createSession({
      claudeSessionId: "claude-abc",
      messages: [
        {
          kind: "user",
          text: "What is this?",
          timestamp: "2024-01-01T12:00:00Z",
        },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByText("Thinking...")).toBeInTheDocument();
  });

  it("does not show thinking indicator when last message is from assistant", () => {
    const session = createSession({
      claudeSessionId: "claude-abc",
      messages: [
        {
          kind: "user",
          text: "Hello",
          timestamp: "2024-01-01T12:00:00Z",
        },
        {
          kind: "assistant",
          text: "Hi!",
          timestamp: "2024-01-01T12:00:01Z",
          isPartial: false,
        },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
  });

  it("does not show thinking indicator when session is not active", () => {
    const session = createSession({
      claudeSessionId: null,
      messages: [
        {
          kind: "user",
          text: "Hello",
          timestamp: "2024-01-01T12:00:00Z",
        },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
  });

  it("shows active green dot when session has claude backend", () => {
    const session = createSession({
      claudeSessionId: "claude-abc",
      status: "open",
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByTestId("chat-active-dot")).toBeInTheDocument();
  });

  it("does not show active green dot when session has no claude backend", () => {
    const session = createSession({ claudeSessionId: null, status: "open" });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.queryByTestId("chat-active-dot")).toBeNull();
  });

  it("does not show closed dot for open sessions", () => {
    const session = createSession({ status: "open" });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.queryByTestId("chat-closed-dot")).toBeNull();
  });

  it("hides empty state when there are messages", () => {
    const session = createSession({
      messages: [
        {
          kind: "user",
          text: "Hello",
          timestamp: "2024-01-01T12:00:00Z",
        },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.queryByText(/Chat scoped to/)).not.toBeInTheDocument();
    expect(
      screen.queryByText("Type a message and press Enter to begin")
    ).not.toBeInTheDocument();
  });

  it("hides empty state when session is active with no messages", () => {
    const session = createSession({
      claudeSessionId: "claude-abc",
      messages: [],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.queryByText(/Chat scoped to/)).not.toBeInTheDocument();
  });

  // --- C) Send button disabled state ---

  it("disables send button when input is empty and session not active", () => {
    const session = createSession({ claudeSessionId: null });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByTitle("Start session")).toBeDisabled();
  });

  it("enables send button when input has text", async () => {
    const user = userEvent.setup();
    const session = createSession({ claudeSessionId: null });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    await user.type(
      screen.getByPlaceholderText("Type a message to start..."),
      "Hello"
    );

    expect(screen.getByTitle("Start session")).not.toBeDisabled();
  });

  it("enables send button when session is active even with empty input", () => {
    const session = createSession({ claudeSessionId: "claude-abc" });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByTitle("Send message")).not.toBeDisabled();
  });

  // --- D) Button title attributes ---

  it("shows 'Send message' title when active, not 'Start session'", () => {
    const session = createSession({ claudeSessionId: "claude-abc" });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByTitle("Send message")).toBeInTheDocument();
    expect(screen.queryByTitle("Start session")).not.toBeInTheDocument();
  });

  it("shows 'Start session' title when not active, not 'Send message'", () => {
    const session = createSession({ claudeSessionId: null });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByTitle("Start session")).toBeInTheDocument();
    expect(screen.queryByTitle("Send message")).not.toBeInTheDocument();
  });
});

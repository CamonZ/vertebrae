import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatWindow } from "./ChatWindow";
import { useChatStore } from "../../stores/chatStore";
import type { ChatSession } from "../../stores/chatStore";

// Mock scrollIntoView
Element.prototype.scrollIntoView = vi.fn();

// Synchronous project so the header's "scoped to" line renders without an async
// state update (which would otherwise log act() warnings).
vi.mock("../../hooks/useCurrentProject", () => ({
  useCurrentProject: () => ({ name: "test-project", path: "/test/project" }),
}));

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
    resolvePermissionRequest: vi.fn().mockResolvedValue({ status: "ok" }),
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

  it("renders the session label as the header title with the scope line", () => {
    const session = createSession({ scope: "task", label: "My Task" });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByText("My Task")).toBeInTheDocument();
    expect(screen.getByText("scoped to")).toBeInTheDocument();
    expect(screen.getByText("this task")).toBeInTheDocument();
  });

  it("renders the workflow scope line", () => {
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

    expect(screen.getByText("Deploy Pipeline")).toBeInTheDocument();
    expect(screen.getByText("this workflow")).toBeInTheDocument();
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
      screen.getByText("Create, edit, and delete tasks, steps, and workflows")
    ).toBeInTheDocument();
    expect(
      screen.getByText("Or run a task through a workflow")
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

  it("focuses the composer on mount, before any session is started", () => {
    const session = createSession({ claudeSessionId: null });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(
      screen.getByPlaceholderText("Type a message to start...")
    ).toHaveFocus();
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

    expect(document.querySelector(".ev-cursor")).toBeInTheDocument();
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

    expect(document.querySelector(".ev-cursor")).not.toBeInTheDocument();
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

    expect(
      screen.queryByText(/Create, edit, and delete/)
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Or run a task through a workflow")
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

    expect(
      screen.queryByText(/Create, edit, and delete/)
    ).not.toBeInTheDocument();
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

  // --- E) Tool toggling (interactive collapse) ---

  it("merges a tool_call + tool_result into one collapsible tool row", () => {
    const session = createSession({
      messages: [
        {
          kind: "assistant",
          text: "Reading file",
          timestamp: "2024-01-01T12:00:00Z",
          isPartial: false,
        },
        {
          kind: "tool_call",
          toolName: "Read",
          toolId: "tool-1",
          input: '{"file_path":"/test.ts"}',
          timestamp: "2024-01-01T12:00:01Z",
        },
        {
          kind: "tool_result",
          toolId: "tool-1",
          result: "RESULT BODY",
          isError: false,
          timestamp: "2024-01-01T12:00:02Z",
        },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    // One tool row carrying the result body (a "has-body" card).
    expect(screen.getByText("Read")).toBeInTheDocument();
    expect(document.querySelector(".evtool.has-body")).toBeInTheDocument();
    // Body is visible by default (not collapsed).
    expect(screen.getByText("RESULT BODY")).toBeInTheDocument();
  });

  it("toggles a tool body when its header is clicked (collapsed by default)", async () => {
    const user = userEvent.setup();
    const session = createSession({
      messages: [
        {
          kind: "tool_call",
          toolName: "Read",
          toolId: "tool-1",
          input: "{}",
          timestamp: "2024-01-01T12:00:01Z",
        },
        {
          kind: "tool_result",
          toolId: "tool-1",
          result: "RESULT BODY",
          isError: false,
          timestamp: "2024-01-01T12:00:02Z",
        },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    const header = document.querySelector(".evtool-hd") as HTMLElement;
    expect(header).toBeTruthy();
    // Collapsed by default.
    expect(document.querySelector(".evtool.collapsed")).toBeInTheDocument();

    // Click expands…
    await user.click(header);
    expect(document.querySelector(".evtool.collapsed")).toBeNull();

    // …and click again collapses.
    await user.click(header);
    expect(document.querySelector(".evtool.collapsed")).toBeInTheDocument();
  });

  // --- F) Permission request (interactive sibling of <Thread>) ---

  it("renders a permission request with approve / deny controls", () => {
    const session = createSession({
      claudeSessionId: "claude-abc",
      messages: [
        {
          kind: "permission_request",
          requestId: "req-1",
          toolName: "Bash",
          message: "Allow running ls?",
          input: '{"command":"ls"}',
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

    expect(screen.getByText("Permission required")).toBeInTheDocument();
    expect(screen.getByText("Allow running ls?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument();
  });

  it("resolves a permission request when Approve is clicked", async () => {
    const user = userEvent.setup();
    const { commands } = await import("../../bindings");
    (commands.resolvePermissionRequest as ReturnType<typeof vi.fn>).mockResolvedValue(
      { status: "ok" }
    );
    const session = createSession({
      claudeSessionId: "claude-abc",
      messages: [
        {
          kind: "permission_request",
          requestId: "req-1",
          toolName: "Bash",
          message: "Allow running ls?",
          input: '{"command":"ls"}',
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

    await user.click(screen.getByRole("button", { name: "Approve" }));

    expect(commands.resolvePermissionRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        request_id: "req-1",
        behavior: "allow",
        message: null,
        updated_input: { command: "ls" },
      })
    );
    expect(await screen.findByText("Resolved")).toBeInTheDocument();
  });

  it("renders permission requests in chronological message order", () => {
    const session = createSession({
      claudeSessionId: "claude-abc",
      messages: [
        {
          kind: "assistant",
          text: "Before permission",
          timestamp: "2024-01-01T12:00:00Z",
        },
        {
          kind: "permission_request",
          requestId: "req-1",
          toolName: "Bash",
          message: "Allow running ls?",
          input: '{"command":"ls"}',
          timestamp: "2024-01-01T12:00:01Z",
        },
        {
          kind: "assistant",
          text: "After permission",
          timestamp: "2024-01-01T12:00:02Z",
        },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    const { container } = render(<ChatWindow sessionId="test-session" />);
    const text = container.textContent ?? "";

    expect(text.indexOf("Before permission")).toBeLessThan(
      text.indexOf("Allow running ls?")
    );
    expect(text.indexOf("Allow running ls?")).toBeLessThan(
      text.indexOf("After permission")
    );
  });

  // --- G) Context fill bar ---

  it("fills the context bar to the utilization percentage", () => {
    const session = createSession({
      claudeSessionId: "claude-abc",
      model: "claude-sonnet-4.5",
      tokenUsage: { used: 50, max: 100 },
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    const fill = screen.getByTestId("chat-context-fill");
    expect(fill).toHaveStyle({ width: "50%" });
    expect(screen.getByText("50%")).toBeInTheDocument();
  });
});

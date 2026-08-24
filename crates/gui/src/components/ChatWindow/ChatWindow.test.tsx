import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatWindow } from "./ChatWindow";
import { useChatStore } from "../../stores/chatStore";
import type { ChatSession } from "../../stores/chatStore";
import { commands } from "../../bindings";
import { loadPersistedLocalChatSession } from "../../utils/localChatPersistence";
import {
  routeLocalChatSessionEndEvent,
  routeLocalChatSessionErrorEvent,
  routeLocalChatTextEvent,
  routeLocalChatToolCallEvent,
  routeLocalChatToolResultEvent,
  routeLocalChatTurnStartedEvent,
  routePermissionRequestEvent,
} from "../../hooks/useLocalChatEventRouter";

// Mock scrollIntoView
Element.prototype.scrollIntoView = vi.fn();
const mockedCommands = vi.mocked(commands);

// Mock the bindings
vi.mock("../../bindings", () => ({
  commands: {
    getCurrentProjectPath: vi.fn().mockResolvedValue({
      status: "ok",
      data: "/test/project",
    }),
    getSupportedLocalChatHarnesses: vi.fn().mockResolvedValue({
      status: "ok",
      data: {
        default_harness: "claude",
        harnesses: [
          {
            harness: "claude",
            label: "Claude",
            available: true,
            unavailable_reason: null,
            default_model_id: "sonnet",
            default_reasoning_effort: null,
            reasoning_efforts: [],
            supports_resume: true,
            models: [
              { id: "sonnet", label: "Sonnet" },
              { id: "opus", label: "Opus" },
              { id: "haiku", label: "Haiku" },
              { id: "fable", label: "Fable" },
            ],
          },
          {
            harness: "codex",
            label: "Codex",
            available: false,
            unavailable_reason: "Codex app-server is not installed",
            default_model_id: null,
            default_reasoning_effort: null,
            reasoning_efforts: [],
            supports_resume: true,
            models: [],
          },
        ],
      },
    }),
    createLocalChatSession: vi.fn().mockResolvedValue({ status: "ok" }),
    getLocalFileRoots: vi.fn().mockResolvedValue({
      status: "ok",
      data: ["/test/project"],
    }),
    inferLocalChatSessionTitle: vi.fn().mockResolvedValue({
      status: "ok",
      data: {
        title: "Inferred Title",
        confidence: 0.91,
        sufficient_signal: true,
      },
    }),
    sendLocalChatMessage: vi.fn().mockResolvedValue({ status: "ok" }),
    closeLocalChatSession: vi.fn().mockResolvedValue({ status: "ok" }),
    resolvePermissionRequest: vi.fn().mockResolvedValue({ status: "ok" }),
    getTask: vi.fn().mockResolvedValue({ status: "ok", data: null }),
    getStep: vi.fn().mockResolvedValue({ status: "ok", data: null }),
    getWorkflowWithTasks: vi
      .fn()
      .mockResolvedValue({ status: "ok", data: null }),
    getCurrentProject: vi
      .fn()
      .mockResolvedValue({ status: "ok", data: "test-project" }),
    getTaskExecutions: vi.fn().mockResolvedValue({ status: "ok", data: [] }),
  },
  events: {
    localChatSessionInitEvent: {
      listen: vi.fn(() => Promise.resolve(() => {})),
    },
    localChatSessionUsageEvent: {
      listen: vi.fn(() => Promise.resolve(() => {})),
    },
    localChatTextEvent: { listen: vi.fn(() => Promise.resolve(() => {})) },
    localChatToolCallEvent: { listen: vi.fn(() => Promise.resolve(() => {})) },
    localChatToolResultEvent: {
      listen: vi.fn(() => Promise.resolve(() => {})),
    },
    permissionRequestEvent: {
      listen: vi.fn(() => Promise.resolve(() => {})),
    },
    localChatSessionEndEvent: {
      listen: vi.fn(() => Promise.resolve(() => {})),
    },
    localChatSessionErrorEvent: {
      listen: vi.fn(() => Promise.resolve(() => {})),
    },
    localChatSessionWarningEvent: {
      listen: vi.fn(() => Promise.resolve(() => {})),
    },
  },
}));

function createSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "test-session",
    label: "Test Task",
    messages: [],
    status: "open",
    harness: "claude",
    backendSessionId: null,
    providerResumeId: null,
    ...overrides,
  };
}

function mockAvailableCodexHarness() {
  mockedCommands.getSupportedLocalChatHarnesses.mockResolvedValueOnce({
    status: "ok",
    data: {
      default_harness: "codex",
      harnesses: [
        {
          harness: "codex",
          label: "Codex",
          available: true,
          unavailable_reason: null,
          default_model_id: "default",
          default_reasoning_effort: "medium",
          reasoning_efforts: [{ id: "medium", label: "Medium" }],
          supports_resume: true,
          models: [{ id: "default", label: "Default" }],
        },
      ],
    },
  });
}

describe("ChatWindow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useChatStore.setState({
      sessions: {},
      activeSessionId: null,
      paneLayout: { panes: [], activePaneId: null },
      panelOpen: false,
    });
  });

  it("returns null when session does not exist", () => {
    const { container } = render(<ChatWindow sessionId="non-existent" />);
    expect(container.innerHTML).toBe("");
  });

  it("renders the session label as the header title without entity copy", () => {
    const session = createSession({ label: "My Task" });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByText("My Task")).toBeInTheDocument();
    expect(screen.queryByText("local to")).not.toBeInTheDocument();
    expect(screen.queryByText("this task")).not.toBeInTheDocument();
  });

  it("exposes the active session project path for GUI acceptance assertions", () => {
    const session = createSession({ projectPath: "/selected/project" });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByTestId("local-chat-window")).toHaveAttribute(
      "data-project-path",
      "/selected/project"
    );
  });

  it("renders the project label from the session's captured path", () => {
    const session = createSession({
      label: "Captured project chat",
      projectPath: "/persisted/project-alpha",
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByTestId("local-chat-project-context")).toHaveTextContent(
      "project-alpha"
    );
    expect(
      screen.getByRole("button", { name: /Rename chat/ })
    ).toBeInTheDocument();
  });

  it("renders the inferred session title in the header", () => {
    const session = createSession({
      label: "New Chat",
      title: "Simple PR Review",
      titleStatus: "generated",
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByText("Simple PR Review")).toBeInTheDocument();
    expect(screen.queryByText("New Chat")).not.toBeInTheDocument();
  });

  it("regenerates the title in the current pane and persists the session index", async () => {
    const user = userEvent.setup();
    const session = createSession({
      title: "Old Generated Title",
      titleStatus: "generated",
      projectPath: "/test/project",
      messages: [
        {
          kind: "user",
          text: "Regenerate this title from the complete conversation",
          timestamp: "2026-01-01T00:00:00Z",
        },
        {
          kind: "assistant",
          text: "I will use the shared inference command.",
          timestamp: "2026-01-01T00:00:01Z",
        },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    await user.click(
      screen.getByRole("button", { name: "Regenerate chat title" })
    );

    await waitFor(() => {
      expect(mockedCommands.inferLocalChatSessionTitle).toHaveBeenCalledWith({
        harness: "claude",
        initial_prompts: [
          "User: Regenerate this title from the complete conversation",
          "Assistant: I will use the shared inference command.",
        ],
        working_dir: "/test/project",
      });
      expect(useChatStore.getState().sessions["test-session"].title).toBe(
        "Inferred Title"
      );
    });

    expect(screen.getByText("Inferred Title")).toBeInTheDocument();
    expect(loadPersistedLocalChatSession("test-session")).toMatchObject({
      title: "Inferred Title",
      titleStatus: "generated",
      titleConfidence: 0.91,
    });
  });

  it("saves a normalized manual title and protects it from regeneration", async () => {
    const user = userEvent.setup();
    const session = createSession({
      title: "Generated Title",
      titleStatus: "generated",
      messages: [
        {
          kind: "user",
          text: "Keep this conversation title",
          timestamp: "2026-01-01T00:00:00Z",
        },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    await user.click(
      screen.getByRole("button", { name: "Rename chat: Generated Title" })
    );
    const input = screen.getByRole("textbox", { name: "Chat title" });
    await user.clear(input);
    await user.type(input, "  Manual   conversation title  ");
    await user.click(screen.getByRole("button", { name: "Save chat title" }));

    await waitFor(() => {
      expect(useChatStore.getState().sessions["test-session"]).toMatchObject({
        title: "Manual conversation title",
        titleStatus: "manual",
        titleConfidence: null,
      });
    });
    expect(loadPersistedLocalChatSession("test-session")).toMatchObject({
      title: "Manual conversation title",
      titleStatus: "manual",
    });

    await user.click(
      screen.getByRole("button", { name: "Regenerate chat title" })
    );
    expect(mockedCommands.inferLocalChatSessionTitle).not.toHaveBeenCalled();
    expect(screen.getByText("Manual conversation title")).toBeInTheDocument();
  });

  it.each(["claude", "codex"] as const)(
    "supports regenerate, cancel, and rename controls for %s sessions",
    async (harness) => {
      const user = userEvent.setup();
      if (harness === "codex") mockAvailableCodexHarness();
      const session = createSession({
        harness,
        title: `Generated ${harness} title`,
        titleStatus: "generated",
        messages: [
          {
            kind: "user",
            text: `Summarize the ${harness} session`,
            timestamp: "2026-01-01T00:00:00Z",
          },
        ],
      });
      useChatStore.setState({
        sessions: { "test-session": session },
        activeSessionId: "test-session",
        panelOpen: true,
      });

      render(<ChatWindow sessionId="test-session" />);

      await user.click(
        screen.getByRole("button", { name: "Regenerate chat title" })
      );
      await waitFor(() => {
        expect(mockedCommands.inferLocalChatSessionTitle).toHaveBeenCalledWith(
          expect.objectContaining({ harness })
        );
        expect(useChatStore.getState().sessions["test-session"].title).toBe(
          "Inferred Title"
        );
      });

      await user.click(
        screen.getByRole("button", { name: "Rename chat: Inferred Title" })
      );
      const input = screen.getByRole("textbox", { name: "Chat title" });
      await user.clear(input);
      await user.type(input, "Canceled title");
      await user.click(
        screen.getByRole("button", { name: "Cancel chat title edit" })
      );
      expect(screen.getByText("Inferred Title")).toBeInTheDocument();

      await user.click(
        screen.getByRole("button", { name: "Rename chat: Inferred Title" })
      );
      await user.clear(screen.getByRole("textbox", { name: "Chat title" }));
      await user.type(
        screen.getByRole("textbox", { name: "Chat title" }),
        "Manual title"
      );
      await user.click(screen.getByRole("button", { name: "Save chat title" }));

      await waitFor(() => {
        expect(useChatStore.getState().sessions["test-session"]).toMatchObject({
          title: "Manual title",
          titleStatus: "manual",
        });
      });
      expect(loadPersistedLocalChatSession("test-session")).toMatchObject({
        title: "Manual title",
        titleStatus: "manual",
      });
    }
  );

  it.each(["claude", "codex"] as const)(
    "keeps an existing title after failed or low-confidence %s inference",
    async (harness) => {
      const user = userEvent.setup();
      if (harness === "codex") mockAvailableCodexHarness();
      const session = createSession({
        harness,
        title: "Existing Usable Title",
        titleStatus: "generated",
        messages: [
          {
            kind: "user",
            text: "Keep the existing title if inference fails",
            timestamp: "2026-01-01T00:00:00Z",
          },
        ],
      });
      useChatStore.setState({
        sessions: { "test-session": session },
        activeSessionId: "test-session",
        panelOpen: true,
      });

      mockedCommands.inferLocalChatSessionTitle.mockResolvedValueOnce({
        status: "ok",
        data: {
          title: null,
          confidence: 0.2,
          sufficient_signal: false,
        },
      });
      render(<ChatWindow sessionId="test-session" />);
      await user.click(
        screen.getByRole("button", { name: "Regenerate chat title" })
      );
      await waitFor(() => {
        expect(mockedCommands.inferLocalChatSessionTitle).toHaveBeenCalledWith(
          expect.objectContaining({ harness })
        );
      });
      expect(screen.getByText("Existing Usable Title")).toBeInTheDocument();
      expect(useChatStore.getState().sessions["test-session"].title).toBe(
        "Existing Usable Title"
      );

      mockedCommands.inferLocalChatSessionTitle.mockResolvedValueOnce({
        status: "error",
        error: { message: "provider unavailable" },
      });
      await user.click(
        screen.getByRole("button", { name: "Regenerate chat title" })
      );
      await waitFor(() => {
        expect(screen.getByRole("alert")).toHaveTextContent(
          "provider unavailable"
        );
      });
      expect(screen.getByText("Existing Usable Title")).toBeInTheDocument();
    }
  );

  it("does not render old entity copy", () => {
    const session = createSession({
      label: "Deploy Pipeline",
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByText("Deploy Pipeline")).toBeInTheDocument();
    expect(screen.queryByText("this workflow")).not.toBeInTheDocument();
    expect(screen.queryByText("wf-1")).not.toBeInTheDocument();
  });

  it("reserves the context metadata footer before usage lands", () => {
    const session = createSession();
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    const { container } = render(<ChatWindow sessionId="test-session" />);

    expect(container.querySelector(".hc-foot-meta")).toBeInTheDocument();
  });

  it("shows a scope-neutral widening control when the panel can expand", async () => {
    const user = userEvent.setup();
    const onToggleWide = vi.fn();
    const session = createSession({
      label: "New Chat",
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" onToggleWide={onToggleWide} />);

    expect(screen.queryByTitle(/Widen scope/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Widen chat panel" }));

    expect(onToggleWide).toHaveBeenCalledTimes(1);
  });

  it("labels the widening control as collapse while the panel is wide", () => {
    const session = createSession({
      label: "New Chat",
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(
      <ChatWindow
        sessionId="test-session"
        onToggleWide={() => {}}
        isWide={true}
      />
    );

    expect(
      screen.getByRole("button", { name: "Collapse chat panel" })
    ).toBeInTheDocument();
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
    expect(screen.queryByText('{"file_path": "/test.ts"}')).toBeNull();
  });

  it("does not render stored context summaries", () => {
    const session = createSession({});
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.queryByText("Context injected")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Task: My Important Task")
    ).not.toBeInTheDocument();
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

  it("renders the Claude model picker without forcing a model for a new session", async () => {
    const session = createSession();
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    const picker = await screen.findByTestId("local-chat-model-picker");
    expect(picker).toHaveValue("");
    expect(
      useChatStore.getState().sessions["test-session"].selectedModelId
    ).toBeUndefined();
  });

  it("omits unavailable Codex from the provider picker", async () => {
    mockedCommands.getSupportedLocalChatHarnesses.mockResolvedValueOnce({
      status: "ok",
      data: {
        default_harness: "claude",
        harnesses: [
          {
            harness: "claude",
            label: "Claude",
            available: true,
            unavailable_reason: null,
            default_model_id: "sonnet",
            default_reasoning_effort: null,
            reasoning_efforts: [],
            supports_resume: true,
            models: [
              {
                id: "sonnet",
                label: "Sonnet",
                supported_reasoning_effort_ids: null,
              },
            ],
          },
          {
            harness: "codex",
            label: "Codex",
            available: false,
            unavailable_reason: "Codex CLI not found",
            default_model_id: null,
            default_reasoning_effort: null,
            reasoning_efforts: [],
            supports_resume: true,
            models: [],
          },
        ],
      },
    });
    const session = createSession();
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    const providerPicker = await screen.findByTestId(
      "local-chat-provider-picker"
    );
    expect(providerPicker).toHaveValue("claude");
    expect(
      Array.from((providerPicker as HTMLSelectElement).options).map(
        (option) => option.value
      )
    ).toEqual(["claude"]);
  });

  it("falls back to Codex when Claude is unavailable before starting", async () => {
    const user = userEvent.setup();
    mockedCommands.getSupportedLocalChatHarnesses.mockResolvedValueOnce({
      status: "ok",
      data: {
        default_harness: "codex",
        harnesses: [
          {
            harness: "claude",
            label: "Claude",
            available: false,
            unavailable_reason: "Claude CLI not found",
            default_model_id: "sonnet",
            default_reasoning_effort: null,
            reasoning_efforts: [],
            supports_resume: true,
            models: [],
          },
          {
            harness: "codex",
            label: "Codex",
            available: true,
            unavailable_reason: null,
            default_model_id: "default",
            default_reasoning_effort: "medium",
            reasoning_efforts: [{ id: "medium", label: "Medium" }],
            supports_resume: true,
            models: [
              {
                id: "default",
                label: "Default",
                supported_reasoning_effort_ids: null,
              },
            ],
          },
        ],
      },
    });
    const session = createSession();
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    const providerPicker = await screen.findByTestId(
      "local-chat-provider-picker"
    );
    await waitFor(() => {
      expect(useChatStore.getState().sessions["test-session"].harness).toBe(
        "codex"
      );
    });
    expect(providerPicker).toHaveValue("codex");
    expect(
      Array.from((providerPicker as HTMLSelectElement).options).map(
        (option) => option.value
      )
    ).toEqual(["codex"]);

    await user.type(screen.getByTestId("local-chat-composer"), "Start Codex");
    await user.click(screen.getByTitle("Start session"));

    await waitFor(() => {
      expect(mockedCommands.createLocalChatSession).toHaveBeenCalledWith(
        expect.objectContaining({
          harness: "codex",
          initial_prompt: "Start Codex",
        })
      );
    });
  });

  it("selects Codex provider models from the catalog and starts with neutral commands", async () => {
    const user = userEvent.setup();
    mockedCommands.getSupportedLocalChatHarnesses.mockResolvedValueOnce({
      status: "ok",
      data: {
        default_harness: "claude",
        harnesses: [
          {
            harness: "claude",
            label: "Claude",
            available: true,
            unavailable_reason: null,
            default_model_id: "sonnet",
            default_reasoning_effort: null,
            reasoning_efforts: [],
            supports_resume: true,
            models: [
              {
                id: "sonnet",
                label: "Sonnet",
                supported_reasoning_effort_ids: null,
              },
            ],
          },
          {
            harness: "codex",
            label: "Codex",
            available: true,
            unavailable_reason: null,
            default_model_id: "catalog-codex-default",
            default_reasoning_effort: "medium",
            reasoning_efforts: [
              { id: "low", label: "Low" },
              { id: "medium", label: "Medium" },
              { id: "high", label: "High" },
            ],
            supports_resume: true,
            models: [
              {
                id: "catalog-codex-default",
                label: "Catalog Default",
                supported_reasoning_effort_ids: null,
              },
              {
                id: "catalog-codex-alt",
                label: "Catalog Alt",
                supported_reasoning_effort_ids: ["medium"],
              },
            ],
          },
        ],
      },
    });
    const session = createSession();
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    await user.selectOptions(
      await screen.findByTestId("local-chat-provider-picker"),
      "codex"
    );
    await waitFor(() => {
      expect(useChatStore.getState().sessions["test-session"].harness).toBe(
        "codex"
      );
    });
    await user.selectOptions(
      await screen.findByTestId("local-chat-effort-picker"),
      "high"
    );
    await user.selectOptions(
      await screen.findByTestId("local-chat-model-picker"),
      "catalog-codex-alt"
    );
    await waitFor(() => {
      expect(
        useChatStore.getState().sessions["test-session"].selectedReasoningEffort
      ).toBeNull();
    });
    expect(
      Array.from(
        (screen.getByTestId("local-chat-effort-picker") as HTMLSelectElement)
          .options,
        (option) => option.value
      )
    ).toEqual(["", "medium"]);
    await user.selectOptions(
      screen.getByTestId("local-chat-effort-picker"),
      "medium"
    );
    await user.type(screen.getByTestId("local-chat-composer"), "Start");
    await user.click(screen.getByTitle("Start session"));

    await waitFor(() => {
      expect(mockedCommands.createLocalChatSession).toHaveBeenCalledWith({
        backend_session_id: expect.any(String),
        harness: "codex",
        working_dir: "/test/project",
        initial_prompt: "Start",
        provider_resume_id: null,
        model_id: "catalog-codex-alt",
        reasoning_effort: "medium",
        personality: null,
        permission_mode: "default",
      });
    });
  });

  it("renders model and permission controls in the composer footer", async () => {
    const session = createSession();
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    const modelPicker = await screen.findByTestId("local-chat-model-picker");
    const permissionPicker = screen.getByTestId(
      "local-chat-permission-mode-picker"
    );

    expect(modelPicker.closest(".hc-foot")).not.toBeNull();
    expect(permissionPicker.closest(".hc-foot")).not.toBeNull();
    expect(
      (await screen.findByTestId("local-chat-provider-picker")).closest(
        ".hc-foot"
      )
    ).not.toBeNull();
    expect(
      document.querySelector(".hc-head [data-testid='local-chat-model-picker']")
    ).toBeNull();
    expect(permissionPicker).toHaveValue("default");
    expect(
      Array.from((permissionPicker as HTMLSelectElement).options, (option) => [
        option.textContent,
        option.value,
      ])
    ).toEqual([
      ["Ask before edits", "default"],
      ["Edit automatically", "accept_edits"],
      ["Plan mode", "plan"],
      ["Auto mode", "auto"],
      ["Don't ask", "dont_ask"],
      ["Bypass permissions", "bypass_permissions"],
    ]);
  });

  it("keeps a locked session on an unavailable Codex harness", async () => {
    const user = userEvent.setup();
    const session = createSession({
      harness: "codex",
      providerResumeId: "codex-resume-1",
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(
      await screen.findByTestId("local-chat-provider-unavailable")
    ).toHaveTextContent("This chat session's harness is no longer available.");
    expect(
      Array.from(
        (screen.getByTestId("local-chat-provider-picker") as HTMLSelectElement)
          .options
      ).map((option) => option.value)
    ).toEqual(["claude"]);
    expect(useChatStore.getState().sessions["test-session"].harness).toBe(
      "codex"
    );
    expect(screen.getByTestId("local-chat-model-picker")).toBeDisabled();
    expect(screen.getByTestId("local-chat-composer")).toBeDisabled();

    await user.type(screen.getByTestId("local-chat-composer"), "Start Codex");

    expect(mockedCommands.createLocalChatSession).not.toHaveBeenCalled();
  });

  it("blocks local chat and shows the neither-installed message", async () => {
    mockedCommands.getSupportedLocalChatHarnesses.mockResolvedValueOnce({
      status: "ok",
      data: {
        default_harness: "claude",
        harnesses: [
          {
            harness: "claude",
            label: "Claude",
            available: false,
            unavailable_reason: "Claude CLI not found",
            default_model_id: "sonnet",
            default_reasoning_effort: null,
            reasoning_efforts: [],
            supports_resume: true,
            models: [],
          },
          {
            harness: "codex",
            label: "Codex",
            available: false,
            unavailable_reason: "Codex CLI not found",
            default_model_id: null,
            default_reasoning_effort: null,
            reasoning_efforts: [],
            supports_resume: true,
            models: [],
          },
        ],
      },
    });
    const session = createSession();
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    const providerPicker = await screen.findByTestId(
      "local-chat-provider-picker"
    );
    expect((providerPicker as HTMLSelectElement).options).toHaveLength(0);
    expect(
      await screen.findByTestId("local-chat-provider-unavailable")
    ).toHaveTextContent(
      "Local chat unavailable because neither Claude nor Codex was found."
    );
    expect(screen.getByTestId("local-chat-composer")).toBeDisabled();
    expect(screen.getByTitle("Start session")).toBeDisabled();
    expect(mockedCommands.createLocalChatSession).not.toHaveBeenCalled();
  });

  it("locks persisted Codex sessions and resumes with providerResumeId", async () => {
    const user = userEvent.setup();
    mockedCommands.getSupportedLocalChatHarnesses.mockResolvedValueOnce({
      status: "ok",
      data: {
        default_harness: "claude",
        harnesses: [
          {
            harness: "claude",
            label: "Claude",
            available: true,
            unavailable_reason: null,
            default_model_id: "sonnet",
            default_reasoning_effort: null,
            reasoning_efforts: [],
            supports_resume: true,
            models: [
              {
                id: "sonnet",
                label: "Sonnet",
                supported_reasoning_effort_ids: null,
              },
            ],
          },
          {
            harness: "codex",
            label: "Codex",
            available: true,
            unavailable_reason: null,
            default_model_id: "catalog-codex-default",
            default_reasoning_effort: "medium",
            reasoning_efforts: [{ id: "medium", label: "Medium" }],
            supports_resume: true,
            models: [
              {
                id: "catalog-codex-default",
                label: "Catalog Default",
                supported_reasoning_effort_ids: null,
              },
            ],
          },
        ],
      },
    });
    const session = createSession({
      harness: "codex",
      providerResumeId: "codex-resume-1",
      selectedModelId: "catalog-codex-default",
      selectedReasoningEffort: "medium",
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(
      await screen.findByTestId("local-chat-provider-picker")
    ).toBeDisabled();
    expect(screen.getByTestId("local-chat-model-picker")).toBeDisabled();

    await user.type(screen.getByTestId("local-chat-composer"), "Resume Codex");
    await user.click(screen.getByTitle("Resume session"));

    await waitFor(() => {
      expect(mockedCommands.createLocalChatSession).toHaveBeenCalledWith({
        backend_session_id: expect.any(String),
        harness: "codex",
        working_dir: "/test/project",
        initial_prompt: "Resume Codex",
        provider_resume_id: "codex-resume-1",
        model_id: null,
        reasoning_effort: null,
        personality: null,
        permission_mode: "default",
      });
    });
  });

  it("persists selected model changes and sends the model when starting", async () => {
    const user = userEvent.setup();
    const session = createSession();
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    await user.selectOptions(
      await screen.findByTestId("local-chat-model-picker"),
      "opus"
    );
    await user.type(screen.getByTestId("local-chat-composer"), "Start");
    await user.click(screen.getByTitle("Start session"));

    await waitFor(() => {
      expect(mockedCommands.createLocalChatSession).toHaveBeenCalledWith({
        backend_session_id: expect.any(String),
        harness: "claude",
        working_dir: "/test/project",
        initial_prompt: "Start",
        provider_resume_id: null,
        model_id: "opus",
        reasoning_effort: null,
        personality: null,
        permission_mode: "default",
      });
    });
    expect(
      useChatStore.getState().sessions["test-session"].selectedModelId
    ).toBe("opus");
  });

  it("sends the selected permission mode when starting", async () => {
    const user = userEvent.setup();
    const session = createSession();
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    await user.selectOptions(
      screen.getByTestId("local-chat-permission-mode-picker"),
      "plan"
    );
    await user.type(screen.getByTestId("local-chat-composer"), "Start");
    await user.click(screen.getByTitle("Start session"));

    await waitFor(() => {
      expect(mockedCommands.createLocalChatSession).toHaveBeenCalledWith({
        backend_session_id: expect.any(String),
        harness: "claude",
        working_dir: "/test/project",
        initial_prompt: "Start",
        provider_resume_id: null,
        model_id: null,
        reasoning_effort: null,
        personality: null,
        permission_mode: "plan",
      });
    });
    expect(
      useChatStore.getState().sessions["test-session"].permissionMode
    ).toBe("plan");
  });

  it("disables model and permission pickers while active or busy", async () => {
    const activeSession = createSession({
      backendSessionId: "claude-active",
    });
    useChatStore.setState({
      sessions: { "test-session": activeSession },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    const { rerender } = render(<ChatWindow sessionId="test-session" />);

    expect(await screen.findByTestId("local-chat-model-picker")).toBeDisabled();
    expect(
      screen.getByTestId("local-chat-permission-mode-picker")
    ).toBeDisabled();

    act(() => {
      useChatStore.setState({
        sessions: {
          "test-session": createSession({ lifecycle: "sending" }),
        },
        activeSessionId: "test-session",
        panelOpen: true,
      });
    });
    rerender(<ChatWindow sessionId="test-session" />);

    expect(await screen.findByTestId("local-chat-model-picker")).toBeDisabled();
    expect(
      screen.getByTestId("local-chat-permission-mode-picker")
    ).toBeDisabled();
  });

  it("can clear a selected model back to CLI default before starting", async () => {
    const user = userEvent.setup();
    const session = createSession();
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    await user.selectOptions(
      await screen.findByTestId("local-chat-model-picker"),
      "opus"
    );
    expect(localStorage.getItem("local-chat-model:last-used:v1")).toBe("opus");

    await user.selectOptions(
      await screen.findByTestId("local-chat-model-picker"),
      ""
    );
    await user.type(screen.getByTestId("local-chat-composer"), "Start");
    await user.click(screen.getByTitle("Start session"));

    await waitFor(() => {
      expect(mockedCommands.createLocalChatSession).toHaveBeenCalledWith({
        backend_session_id: expect.any(String),
        harness: "claude",
        working_dir: "/test/project",
        initial_prompt: "Start",
        provider_resume_id: null,
        model_id: null,
        reasoning_effort: null,
        personality: null,
        permission_mode: "default",
      });
    });
    expect(
      useChatStore.getState().sessions["test-session"].selectedModelId
    ).toBeNull();
    expect(localStorage.getItem("local-chat-model:last-used:v1")).toBeNull();
  });

  it("uses the last selected model as the default for a new session", async () => {
    localStorage.setItem("local-chat-model:last-used:v1", "haiku");
    const session = createSession();
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    const picker = await screen.findByTestId("local-chat-model-picker");
    await waitFor(() => {
      expect(picker).toHaveValue("haiku");
    });
  });

  it("does not assign a default model to old resumable sessions without a saved choice", async () => {
    const session = createSession({ providerResumeId: "conv-existing" });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(await screen.findByTestId("local-chat-model-picker")).toHaveValue(
      ""
    );
    expect(
      useChatStore.getState().sessions["test-session"].selectedModelId
    ).toBeUndefined();
  });

  it("preserves unsupported saved model ids so backend fallback can warn", async () => {
    const session = createSession({ selectedModelId: "claude-retired" });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    await screen.findByTestId("local-chat-model-picker");
    expect(
      useChatStore.getState().sessions["test-session"].selectedModelId
    ).toBe("claude-retired");
  });

  it("clears saved model override when selected harness has no selectable models", async () => {
    mockedCommands.getSupportedLocalChatHarnesses.mockResolvedValueOnce({
      status: "ok",
      data: {
        default_harness: "claude",
        harnesses: [
          {
            harness: "claude",
            label: "Claude",
            available: true,
            unavailable_reason: null,
            default_model_id: "sonnet",
            default_reasoning_effort: null,
            reasoning_efforts: [],
            supports_resume: true,
            models: [
              {
                id: "sonnet",
                label: "Sonnet",
                supported_reasoning_effort_ids: null,
              },
            ],
          },
          {
            harness: "codex",
            label: "Codex",
            available: true,
            unavailable_reason: null,
            default_model_id: null,
            default_reasoning_effort: null,
            reasoning_efforts: [],
            supports_resume: true,
            models: [],
          },
        ],
      },
    });
    const session = createSession({
      harness: "codex",
      selectedModelId: "stale-catalog-id",
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(await screen.findByTestId("local-chat-model-picker")).toBeDisabled();
    await waitFor(() => {
      expect(
        useChatStore.getState().sessions["test-session"].selectedModelId
      ).toBeNull();
    });
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

  it("closes the backend before clearing an active session", async () => {
    const user = userEvent.setup();
    const session = createSession({
      backendSessionId: "claude-abc",
      lifecycle: "streaming",
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

    await user.click(screen.getByTitle("Clear messages"));

    await waitFor(() => {
      expect(mockedCommands.closeLocalChatSession).toHaveBeenCalledWith(
        "claude-abc"
      );
      expect(
        useChatStore.getState().sessions["test-session"].messages
      ).toHaveLength(0);
    });
  });

  it("keeps an empty active chat open after clearing its backend session", async () => {
    const user = userEvent.setup();
    const session = createSession({
      backendSessionId: "claude-empty",
      lifecycle: "idle",
      messages: [],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    await user.click(screen.getByTitle("Clear messages"));

    await waitFor(() => {
      expect(mockedCommands.closeLocalChatSession).toHaveBeenCalledWith(
        "claude-empty"
      );
      expect(useChatStore.getState().sessions["test-session"]).toMatchObject({
        messages: [],
        backendSessionId: null,
        lifecycle: "idle",
      });
      expect(useChatStore.getState().panelOpen).toBe(true);
    });
  });

  it("stops an active backend session without clearing messages", async () => {
    const user = userEvent.setup();
    const session = createSession({
      backendSessionId: "codex-active",
      harness: "codex",
      lifecycle: "streaming",
      activeTurn: {
        localId: "local-turn-active",
        turnId: "root-turn-active",
        phase: "active",
      },
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

    await user.click(screen.getByTestId("local-chat-stop-generation"));

    await waitFor(() => {
      expect(mockedCommands.closeLocalChatSession).toHaveBeenCalledWith(
        "codex-active"
      );
      expect(
        useChatStore.getState().sessions["test-session"].messages
      ).toHaveLength(1);
    });
  });

  it("keeps stopping visible and sends only one close request", async () => {
    let resolveClose!: (result: { status: "ok"; data: null }) => void;
    mockedCommands.closeLocalChatSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveClose = resolve;
        })
    );
    const session = createSession({
      backendSessionId: "codex-stopping",
      harness: "codex",
      lifecycle: "streaming",
      activeTurn: {
        localId: "local-turn-stopping",
        turnId: "root-turn-stopping",
        phase: "active",
      },
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });
    render(<ChatWindow sessionId="test-session" />);

    const stop = screen.getByTestId("local-chat-stop-generation");
    fireEvent.click(stop);
    fireEvent.click(stop);

    expect(mockedCommands.closeLocalChatSession).toHaveBeenCalledTimes(1);
    expect(
      useChatStore.getState().sessions["test-session"].activeTurn
    ).toMatchObject({
      turnId: "root-turn-stopping",
      phase: "stopping",
    });
    expect(stop).toBeDisabled();
    expect(screen.getByText("Stopping...")).toBeInTheDocument();

    await act(async () => resolveClose({ status: "ok", data: null }));
    await waitFor(() => {
      expect(
        useChatStore.getState().sessions["test-session"].activeTurn
      ).toBeNull();
      expect(
        useChatStore.getState().sessions["test-session"].backendSessionId
      ).toBeNull();
    });
  });

  it("keeps Stop disabled when provider acknowledgement races a local stop", async () => {
    let resolveClose!: (result: { status: "ok"; data: null }) => void;
    mockedCommands.closeLocalChatSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveClose = resolve;
        })
    );
    const session = createSession({
      backendSessionId: "codex-stop-before-ack",
      harness: "codex",
      lifecycle: "sending",
      activeTurn: {
        localId: "local-turn-before-ack",
        turnId: null,
        phase: "starting",
      },
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });
    render(<ChatWindow sessionId="test-session" />);

    const stop = screen.getByTestId("local-chat-stop-generation");
    fireEvent.click(stop);
    act(() => {
      expect(
        routeLocalChatTurnStartedEvent({
          backend_session_id: "codex-stop-before-ack",
          harness: "codex",
          turn_id: "provider-turn-before-ack",
          thread_id: "provider-thread-before-ack",
          is_root: true,
        })
      ).toBe(true);
    });

    expect(stop).toBeDisabled();
    expect(useChatStore.getState().sessions["test-session"].activeTurn).toEqual(
      {
        localId: "local-turn-before-ack",
        turnId: "provider-turn-before-ack",
        phase: "stopping",
      }
    );
    fireEvent.click(stop);
    expect(mockedCommands.closeLocalChatSession).toHaveBeenCalledTimes(1);

    await act(async () => resolveClose({ status: "ok", data: null }));
  });

  it("keeps the composer closed when End arrives before Stop completes", async () => {
    const user = userEvent.setup();
    let resolveClose!: (result: { status: "ok"; data: null }) => void;
    mockedCommands.closeLocalChatSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveClose = resolve;
        })
    );
    const session = createSession({
      backendSessionId: "claude-stop-end-race",
      lifecycle: "streaming",
      activeTurn: {
        localId: "local-turn-stop-end-race",
        turnId: "root-turn-stop-end-race",
        phase: "active",
      },
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });
    render(<ChatWindow sessionId="test-session" />);

    fireEvent.click(screen.getByTestId("local-chat-stop-generation"));
    act(() => {
      expect(
        routeLocalChatSessionEndEvent({
          backend_session_id: "claude-stop-end-race",
          harness: "claude",
          turn_id: "root-turn-stop-end-race",
          thread_id: "root-thread-stop-end-race",
          is_root: true,
          duration_ms: 1,
          cost_usd: 0,
          num_turns: 1,
          result: "interrupted",
          is_error: false,
          context_tokens: 0,
          context_window: 200000,
        })
      ).toBe(true);
    });

    const composer = screen.getByTestId("local-chat-composer");
    expect(useChatStore.getState().sessions["test-session"].lifecycle).toBe(
      "closing"
    );
    expect(composer).toBeDisabled();
    await user.type(composer, "must not send{Enter}");
    expect(composer).toHaveValue("");
    expect(mockedCommands.sendLocalChatMessage).not.toHaveBeenCalled();

    await act(async () => resolveClose({ status: "ok", data: null }));
    expect(useChatStore.getState().sessions["test-session"]).toMatchObject({
      lifecycle: "idle",
      backendSessionId: null,
    });
  });

  it("disables Stop while a clear is already closing the session", async () => {
    const user = userEvent.setup();
    let resolveClose!: (result: { status: "ok"; data: null }) => void;
    mockedCommands.closeLocalChatSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveClose = resolve;
        })
    );
    const session = createSession({
      backendSessionId: "claude-clear-stop",
      lifecycle: "streaming",
      activeTurn: {
        localId: "local-turn-clear",
        turnId: "root-turn-clear",
        phase: "active",
      },
      messages: [
        { kind: "user", text: "Hello", timestamp: "2024-01-01T12:00:00Z" },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });
    render(<ChatWindow sessionId="test-session" />);

    await user.click(screen.getByTitle("Clear messages"));

    // The clear owns the teardown; a second concurrent close must not be sent.
    const stop = screen.getByTestId("local-chat-stop-generation");
    expect(stop).toBeDisabled();
    fireEvent.click(stop);
    expect(mockedCommands.closeLocalChatSession).toHaveBeenCalledTimes(1);

    await act(async () => resolveClose({ status: "ok", data: null }));
    await waitFor(() => {
      expect(
        useChatStore.getState().sessions["test-session"].messages
      ).toHaveLength(0);
    });
  });

  it("restores Stop for retry when the close transport fails", async () => {
    const user = userEvent.setup();
    mockedCommands.closeLocalChatSession.mockResolvedValueOnce({
      status: "error",
      error: { SendFailed: "close transport failed" },
    } as never);
    const session = createSession({
      backendSessionId: "claude-stop-retry",
      lifecycle: "streaming",
      activeTurn: {
        localId: "local-turn-retry",
        turnId: "provider-turn-retry",
        phase: "active",
      },
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });
    render(<ChatWindow sessionId="test-session" />);

    const stop = screen.getByTestId("local-chat-stop-generation");
    await user.click(stop);

    expect(stop).toBeEnabled();
    expect(useChatStore.getState().sessions["test-session"]).toMatchObject({
      backendSessionId: "claude-stop-retry",
      lifecycle: "streaming",
      activeTurn: {
        localId: "local-turn-retry",
        turnId: "provider-turn-retry",
        phase: "active",
      },
    });

    await user.click(stop);
    expect(mockedCommands.closeLocalChatSession).toHaveBeenCalledTimes(2);
  });

  it("disables stop after a persistent turn returns to idle", () => {
    const session = createSession({
      backendSessionId: "codex-idle",
      harness: "codex",
      lifecycle: "idle",
      messages: [
        {
          kind: "assistant",
          text: "Completed answer",
          timestamp: "2026-07-19T00:00:00Z",
        },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByTestId("local-chat-stop-generation")).toBeDisabled();
  });

  it.each([
    { harness: "claude" as const, backendSessionId: "claude-full-turn" },
    { harness: "codex" as const, backendSessionId: "codex-full-turn" },
  ])(
    "keeps $harness activity and Stop active through the complete turn",
    ({ harness, backendSessionId }) => {
      const turnId = `${harness}-root-turn`;
      const session = createSession({
        backendSessionId,
        harness,
        lifecycle: "sending",
        messages: [
          {
            kind: "user",
            text: "Inspect the project",
            timestamp: "2026-07-26T00:00:00Z",
          },
        ],
      });
      useChatStore.setState({
        sessions: { "test-session": session },
        activeSessionId: "test-session",
        panelOpen: true,
      });
      useChatStore.getState().beginActiveTurn("test-session");

      render(<ChatWindow sessionId="test-session" />);

      const stop = screen.getByTestId("local-chat-stop-generation");
      const expectTurnActive = () => {
        expect(stop).toBeEnabled();
        expect(screen.getByText("Thinking...")).toBeInTheDocument();
      };
      expectTurnActive();

      act(() => {
        expect(
          routeLocalChatTurnStartedEvent({
            backend_session_id: backendSessionId,
            harness,
            turn_id: turnId,
            thread_id: `${harness}-thread`,
            is_root: true,
          })
        ).toBe(true);
      });
      expectTurnActive();

      act(() => {
        expect(
          routeLocalChatTextEvent({
            backend_session_id: backendSessionId,
            harness,
            turn_id: turnId,
            thread_id: `${harness}-thread`,
            is_root: true,
            text: "I found the entry point.",
            is_partial: false,
            parent_tool_use_id: null,
          })
        ).toBe(true);
      });
      expectTurnActive();

      act(() => {
        expect(
          routeLocalChatToolCallEvent({
            backend_session_id: backendSessionId,
            harness,
            turn_id: turnId,
            thread_id: `${harness}-thread`,
            is_root: true,
            tool_name: "Read",
            tool_id: `${harness}-tool`,
            input: '{"path":"src/main.rs"}',
            parent_tool_use_id: null,
          })
        ).toBe(true);
        expect(
          routeLocalChatToolResultEvent({
            backend_session_id: backendSessionId,
            harness,
            turn_id: turnId,
            thread_id: `${harness}-thread`,
            is_root: true,
            tool_id: `${harness}-tool`,
            result: "fn main() {}",
            is_error: false,
            parent_tool_use_id: null,
          })
        ).toBe(true);
      });
      expectTurnActive();

      act(() => {
        expect(
          routePermissionRequestEvent({
            request_id: `${harness}-permission`,
            session_id: backendSessionId,
            turn_id: turnId,
            thread_id: `${harness}-thread`,
            is_root: true,
            tool_name: "Bash",
            tool_use_id: `${harness}-approval-tool`,
            input: { command: "cargo test" },
            message: "Allow running the tests?",
          })
        ).toBe(true);
      });
      expectTurnActive();
      expect(screen.getByText("Permission required")).toBeInTheDocument();

      act(() => {
        expect(
          routeLocalChatSessionEndEvent({
            backend_session_id: backendSessionId,
            harness,
            turn_id: `${turnId}-child`,
            thread_id: `${harness}-child-thread`,
            is_root: false,
            duration_ms: 1,
            cost_usd: 0,
            num_turns: 1,
            result: "child done",
            is_error: false,
            context_tokens: 10,
            context_window: 200000,
          })
        ).toBe(false);
      });
      expectTurnActive();

      act(() => {
        expect(
          routeLocalChatSessionEndEvent({
            backend_session_id: backendSessionId,
            harness,
            turn_id: turnId,
            thread_id: `${harness}-thread`,
            is_root: true,
            duration_ms: 10,
            cost_usd: 0,
            num_turns: 1,
            result: "done",
            is_error: false,
            context_tokens: 10,
            context_window: 200000,
          })
        ).toBe(true);
      });

      expect(stop).toBeDisabled();
      expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
      expect(useChatStore.getState().sessions["test-session"]).toMatchObject({
        backendSessionId,
        activeTurn: null,
        lifecycle: "idle",
      });
    }
  );

  it("ends activity for an empty assistant response", () => {
    const backendSessionId = "claude-empty-turn";
    const session = createSession({
      backendSessionId,
      lifecycle: "streaming",
      messages: [
        {
          kind: "user",
          text: "Respond only if needed",
          timestamp: "2026-07-26T00:00:00Z",
        },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });
    useChatStore.getState().beginActiveTurn("test-session");
    routeLocalChatTurnStartedEvent({
      backend_session_id: backendSessionId,
      harness: "claude",
      turn_id: "empty-root-turn",
      thread_id: "empty-root-thread",
      is_root: true,
    });
    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByText("Thinking...")).toBeInTheDocument();
    act(() => {
      routeLocalChatSessionEndEvent({
        backend_session_id: backendSessionId,
        harness: "claude",
        turn_id: "empty-root-turn",
        thread_id: "empty-root-thread",
        is_root: true,
        duration_ms: 1,
        cost_usd: 0,
        num_turns: 1,
        result: "",
        is_error: false,
        context_tokens: 0,
        context_window: 200000,
      });
    });

    expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
    expect(screen.getByTestId("local-chat-stop-generation")).toBeDisabled();
    expect(useChatStore.getState().sessions["test-session"].messages).toEqual([
      expect.objectContaining({ kind: "user", text: "Respond only if needed" }),
    ]);
  });

  it("ends activity and disables Stop on a matching terminal error", () => {
    const backendSessionId = "codex-error-turn";
    const session = createSession({
      backendSessionId,
      harness: "codex",
      lifecycle: "streaming",
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });
    useChatStore.getState().beginActiveTurn("test-session");
    routeLocalChatTurnStartedEvent({
      backend_session_id: backendSessionId,
      harness: "codex",
      turn_id: "error-root-turn",
      thread_id: "error-root-thread",
      is_root: true,
    });
    render(<ChatWindow sessionId="test-session" />);

    act(() => {
      expect(
        routeLocalChatSessionErrorEvent({
          backend_session_id: backendSessionId,
          harness: "codex",
          turn_id: "error-root-turn",
          thread_id: "error-root-thread",
          is_root: true,
          error: "Codex stopped unexpectedly",
        })
      ).toBe(true);
    });

    expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
    expect(screen.getByTestId("local-chat-stop-generation")).toBeDisabled();
    expect(screen.getByText("Codex stopped unexpectedly")).toBeInTheDocument();
    expect(useChatStore.getState().sessions["test-session"]).toMatchObject({
      backendSessionId: null,
      activeTurn: null,
      lifecycle: "error",
      lifecycleError: "Codex stopped unexpectedly",
    });
  });

  it("stops an active backend session with Cmd+period", async () => {
    const session = createSession({
      backendSessionId: "codex-hotkey",
      harness: "codex",
      lifecycle: "streaming",
      activeTurn: {
        localId: "local-turn-hotkey",
        turnId: "root-turn-hotkey",
        phase: "active",
      },
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    fireEvent.keyDown(window, { key: ".", metaKey: true });

    await waitFor(() => {
      expect(mockedCommands.closeLocalChatSession).toHaveBeenCalledWith(
        "codex-hotkey"
      );
    });
  });

  it("retires a pending user question and enables the composer when stopped", async () => {
    const questions = [
      {
        question: "Proceed?",
        header: "Confirm",
        options: [{ label: "Yes", description: "Continue" }],
        multi_select: false,
      },
    ];
    const session = createSession({
      backendSessionId: "claude-question",
      providerResumeId: "claude-conversation",
      lifecycle: "streaming",
      activeTurn: {
        localId: "local-turn-question",
        turnId: "root-turn-question",
        phase: "active",
      },
      messages: [
        {
          kind: "user_question",
          requestId: "req-stop",
          toolUseId: "tool-stop",
          questions,
          originalQuestions: questions,
          status: "pending",
          timestamp: "2026-07-14T00:00:00Z",
        },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByTestId("local-chat-composer")).toBeDisabled();
    fireEvent.keyDown(window, { key: ".", metaKey: true });

    await waitFor(() => {
      expect(mockedCommands.closeLocalChatSession).toHaveBeenCalledWith(
        "claude-question"
      );
      expect(screen.getByTestId("local-chat-composer")).toBeEnabled();
      expect(
        useChatStore.getState().sessions["test-session"].messages[0]
      ).toMatchObject({ kind: "user_question", status: "unavailable" });
    });
  });

  it("keeps messages when backend close fails during clear", async () => {
    mockedCommands.closeLocalChatSession.mockResolvedValueOnce({
      status: "error",
      error: { SendFailed: "pipe closed" },
    } as never);
    const user = userEvent.setup();
    const session = createSession({
      backendSessionId: "claude-abc",
      lifecycle: "streaming",
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

    await user.click(screen.getByTitle("Clear messages"));

    await waitFor(() => {
      expect(mockedCommands.closeLocalChatSession).toHaveBeenCalledWith(
        "claude-abc"
      );
      const current = useChatStore.getState().sessions["test-session"];
      expect(current.messages).toHaveLength(1);
      expect(current.backendSessionId).toBe("claude-abc");
      expect(current.lifecycle).toBe("error");
      expect(current.lifecycleError).toBe("pipe closed");
    });
  });

  it("shows placeholder text for idle session", () => {
    const session = createSession({ backendSessionId: null });
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
    const session = createSession({ backendSessionId: null });
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
    const session = createSession({ backendSessionId: "claude-abc" });
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
    const session = createSession({ lifecycle: "closed" });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    // The chat header should have a muted dot for closed status.
    screen.getByText("Test Task");
    // Closed session indicator is a sibling of the header content
    expect(screen.getByTestId("chat-closed-dot")).toBeInTheDocument();
  });

  // --- A) User interaction flow ---

  it("sends message when send button is clicked and clears input", async () => {
    const user = userEvent.setup();
    const session = createSession({ backendSessionId: "claude-abc" });
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
    const session = createSession({ backendSessionId: "claude-abc" });
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

  it("keeps newline input on Shift+Enter and grows the composer", async () => {
    const original = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "scrollHeight"
    );
    Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.value.includes("\n") ? 88 : 40;
      },
    });
    const user = userEvent.setup();
    const session = createSession({ backendSessionId: "claude-abc" });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    try {
      render(<ChatWindow sessionId="test-session" />);

      const textarea = screen.getByTestId("local-chat-composer");
      await user.type(textarea, "Line one");
      expect(textarea).toHaveStyle({ height: "40px" });

      await user.keyboard("{Shift>}{Enter}{/Shift}");
      await user.type(textarea, "Line two");

      expect(textarea).toHaveValue("Line one\nLine two");
      expect(textarea).toHaveStyle({ height: "88px" });
      expect(mockedCommands.sendLocalChatMessage).not.toHaveBeenCalled();
    } finally {
      if (original) {
        Object.defineProperty(
          HTMLTextAreaElement.prototype,
          "scrollHeight",
          original
        );
      }
    }
  });

  it("does not send whitespace-only messages", async () => {
    const user = userEvent.setup();
    const session = createSession({ backendSessionId: "claude-abc" });
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
    const session = createSession({ backendSessionId: null });
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

  it("renders local user chat messages as markdown", () => {
    const session = createSession({
      backendSessionId: "claude-abc",
      messages: [
        {
          kind: "user",
          text: "Please read:\n\n- **first**\n- `second`",
          timestamp: "2024-01-01T12:00:00Z",
        },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    const { container } = render(<ChatWindow sessionId="test-session" />);

    const userRow = container.querySelector(".evrow--user");
    expect(userRow?.querySelector(".markdown-content")).toBeInTheDocument();
    expect(userRow?.querySelector("li strong")).toHaveTextContent("first");
    expect(userRow?.querySelector("li code")).toHaveTextContent("second");
  });

  it("renders the ephemeral streaming assistant overlay", () => {
    const session = createSession({
      backendSessionId: "claude-abc",
      lifecycle: "streaming",
      messages: [
        {
          kind: "user",
          text: "Question",
          timestamp: "2024-01-01T12:00:00Z",
        },
      ],
      streamingAssistant: {
        text: "Overlay answer",
        timestamp: "2024-01-01T12:00:01Z",
      },
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByText("Overlay answer")).toBeInTheDocument();
    expect(document.querySelector(".ev-cursor")).toBeInTheDocument();
    expect(
      useChatStore.getState().sessions["test-session"].messages
    ).toHaveLength(1);
  });

  it("does not render the same streamed assistant partial twice", () => {
    const session = createSession({
      backendSessionId: "claude-abc",
      lifecycle: "streaming",
      messages: [
        {
          kind: "user",
          text: "Question",
          timestamp: "2024-01-01T12:00:00Z",
        },
        {
          kind: "assistant",
          text: "Overlay answer",
          timestamp: "2024-01-01T12:00:01Z",
          isPartial: true,
        },
      ],
      streamingAssistant: {
        text: "Overlay answer",
        timestamp: "2024-01-01T12:00:01Z",
      },
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getAllByText("Overlay answer")).toHaveLength(1);
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
      backendSessionId: "claude-abc",
      activeTurn: {
        localId: "local-turn-waiting",
        turnId: null,
        phase: "starting",
      },
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

  it("keeps showing thinking while streaming before the first text delta", () => {
    const session = createSession({
      backendSessionId: "claude-abc",
      lifecycle: "streaming",
      activeTurn: {
        localId: "local-turn-streaming",
        turnId: "root-turn-streaming",
        phase: "active",
      },
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

  it("keeps showing activity after an assistant snapshot", () => {
    const session = createSession({
      backendSessionId: "claude-abc",
      activeTurn: {
        localId: "local-turn-snapshot",
        turnId: "root-turn-snapshot",
        phase: "active",
      },
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

    expect(screen.getByText("Thinking...")).toBeInTheDocument();
  });

  it("does not show thinking indicator when session is not active", () => {
    const session = createSession({
      backendSessionId: null,
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
      backendSessionId: "claude-abc",
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
    const session = createSession({ backendSessionId: null, status: "open" });
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
      backendSessionId: "claude-abc",
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
    const session = createSession({ backendSessionId: null });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByTitle("Start session")).toBeDisabled();
    expect(mockedCommands.createLocalChatSession).not.toHaveBeenCalled();
  });

  it("enables send button when input has text", async () => {
    const user = userEvent.setup();
    const session = createSession({ backendSessionId: null });
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

  it("disables send button when session is active with empty input", () => {
    const session = createSession({ backendSessionId: "claude-abc" });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByTitle("Send message")).toBeDisabled();
  });

  // --- D) Button title attributes ---

  it("shows 'Send message' title when active, not 'Start session'", () => {
    const session = createSession({ backendSessionId: "claude-abc" });
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
    const session = createSession({ backendSessionId: null });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByTitle("Start session")).toBeInTheDocument();
    expect(screen.queryByTitle("Send message")).not.toBeInTheDocument();
  });

  it("disables composer while a session is starting", () => {
    const session = createSession({ lifecycle: "starting" });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(
      screen.queryByTestId("chat-lifecycle-label")
    ).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("Starting...")).toBeDisabled();
    expect(screen.getByTitle("Start session")).toBeDisabled();
  });

  it("keeps composer available for queued input while sending", () => {
    const session = createSession({
      backendSessionId: "claude-abc",
      lifecycle: "sending",
      activeTurn: {
        localId: "local-turn-sending",
        turnId: null,
        phase: "starting",
      },
      messages: [
        {
          kind: "user",
          text: "Question",
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
      screen.queryByTestId("chat-lifecycle-label")
    ).not.toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("Type a message to queue...")
    ).toBeEnabled();
    expect(screen.getByTitle("Send message")).toBeDisabled();
    expect(screen.getByText("Thinking...")).toBeInTheDocument();
  });

  it("keeps composer available for queued input while streaming", () => {
    const session = createSession({
      backendSessionId: "claude-abc",
      lifecycle: "streaming",
      activeTurn: {
        localId: "local-turn-overlay",
        turnId: "root-turn-overlay",
        phase: "active",
      },
      streamingAssistant: {
        text: "Streaming now",
        timestamp: "2024-01-01T12:00:01Z",
      },
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(
      screen.queryByTestId("chat-lifecycle-label")
    ).not.toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("Type a message to queue...")
    ).toBeEnabled();
    expect(screen.getByText("Streaming now")).toBeInTheDocument();
    expect(screen.getByText("Thinking...")).toBeInTheDocument();
  });

  it("disables ordinary composer sends while a user question is pending", () => {
    const questions = [
      {
        question: "Proceed?",
        header: "Confirm",
        options: [{ label: "Yes", description: "Continue" }],
        multi_select: false,
      },
    ];
    const session = createSession({
      backendSessionId: "claude-abc",
      lifecycle: "streaming",
      messages: [
        {
          kind: "user_question",
          requestId: "req-1",
          toolUseId: "tool-1",
          questions,
          originalQuestions: questions,
          status: "pending",
          timestamp: "2026-07-14T00:00:00Z",
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
      screen.getByPlaceholderText(
        "Answer Claude's question above to continue..."
      )
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Submit answers" })
    ).toBeDisabled();
  });

  it("keeps chat errors in the transcript and allows retry text after an error", async () => {
    const user = userEvent.setup();
    const session = createSession({
      lifecycle: "error",
      lifecycleError: "Claude failed",
      backendSessionId: "stale-claude-id",
      providerResumeId: "conv-retry",
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(
      screen.queryByTestId("chat-lifecycle-label")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("chat-lifecycle-error")
    ).not.toBeInTheDocument();
    const textarea = screen.getByPlaceholderText("Type a message to resume...");
    await user.type(textarea, "Retry");
    expect(screen.getByTitle("Resume session")).not.toBeDisabled();
    await user.click(screen.getByTitle("Resume session"));

    await waitFor(() => {
      expect(mockedCommands.createLocalChatSession).toHaveBeenCalled();
      expect(mockedCommands.sendLocalChatMessage).not.toHaveBeenCalled();
    });
  });

  it("shows closed resumable state", async () => {
    const user = userEvent.setup();
    const session = createSession({
      lifecycle: "closed",
      providerResumeId: "conv-resume",
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByTestId("chat-closed-dot")).toBeInTheDocument();
    expect(
      screen.queryByTestId("chat-lifecycle-label")
    ).not.toBeInTheDocument();
    const textarea = screen.getByPlaceholderText("Type a message to resume...");
    await user.type(textarea, "Resume");
    expect(screen.getByTitle("Resume session")).not.toBeDisabled();
  });

  it("disables composer while a session is resuming", () => {
    const session = createSession({
      lifecycle: "resuming",
      providerResumeId: "conv-resume",
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(
      screen.queryByTestId("chat-lifecycle-label")
    ).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("Resuming...")).toBeDisabled();
    expect(screen.getByTitle("Resume session")).toBeDisabled();
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
    // Collapsed tool bodies are not mounted until requested.
    expect(screen.queryByText("RESULT BODY")).not.toBeInTheDocument();
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
      backendSessionId: "claude-abc",
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

  it("renders permission requests emitted by the neutral permission event", async () => {
    const session = createSession({ backendSessionId: "claude-abc" });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    act(() => {
      routePermissionRequestEvent({
        request_id: "req-event",
        session_id: "claude-abc",
        tool_name: "Bash",
        tool_use_id: "tool-use-1",
        input: { command: "pwd" },
        message: "Allow running pwd?",
      });
    });

    expect(screen.getByText("Permission required")).toBeInTheDocument();
    expect(screen.getByText("Allow running pwd?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
  });

  it("resolves a permission request when Approve is clicked", async () => {
    const user = userEvent.setup();
    const { commands } = await import("../../bindings");
    (
      commands.resolvePermissionRequest as ReturnType<typeof vi.fn>
    ).mockResolvedValue({ status: "ok" });
    const session = createSession({
      backendSessionId: "claude-abc",
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

  it("rejects non-object updated input before approving a permission request", async () => {
    const user = userEvent.setup();
    const { commands } = await import("../../bindings");
    const session = createSession({
      backendSessionId: "claude-abc",
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

    const input = screen.getByDisplayValue('{"command":"ls"}');
    fireEvent.change(input, { target: { value: "[1,2,3]" } });
    await user.click(screen.getByRole("button", { name: "Approve" }));

    expect(
      await screen.findByText("Updated input must be a JSON object")
    ).toBeInTheDocument();
    expect(commands.resolvePermissionRequest).not.toHaveBeenCalled();
  });

  it("renders permission requests in chronological message order", () => {
    const session = createSession({
      backendSessionId: "claude-abc",
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

  it("fills the context bar to the input-context utilization percentage", () => {
    const session = createSession({
      backendSessionId: "claude-abc",
      model: "claude-sonnet-4.5",
      tokenUsage: { used: 100_050, max: 200_000 },
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
    expect(
      screen.getByTitle(
        "100,050 / 200,000 current request input context tokens"
      )
    ).toBeInTheDocument();
  });

  it("clamps the context bar at 100% when input context exceeds the max window", () => {
    const session = createSession({
      backendSessionId: "claude-abc",
      model: "claude-sonnet-4.5",
      tokenUsage: { used: 250_000, max: 200_000 },
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    const fill = screen.getByTestId("chat-context-fill");
    expect(fill).toHaveStyle({ width: "100%" });
    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(
      screen.getByTitle(
        "250,000 / 200,000 current request input context tokens"
      )
    ).toBeInTheDocument();
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  render,
  screen,
  act,
  fireEvent,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { savedProjects } = vi.hoisted(() => {
  const savedProjects = [
    { slug: "test-project", project_id: "project-test", path: "/test/project" },
    { slug: "old-project", project_id: "project-old", path: "/old/project" },
    { slug: "new-project", project_id: "project-new", path: "/new/project" },
  ];
  return { savedProjects };
});

import { ChatWindowManager } from "./ChatWindowManager";
import { useChatStore } from "../../stores/chatStore";
import { usePanelFocusStore } from "../../stores/panelFocusStore";
import { usePanelLayoutStore } from "../../stores/panelLayoutStore";
import type { ChatSession } from "../../stores/chatStore";
import {
  clearPersistedLocalChatSessions,
  loadPersistedLocalChatSession,
  persistLocalChatSession,
} from "../../utils/localChatPersistence";
import { commands } from "../../bindings";

// Mock scrollIntoView
Element.prototype.scrollIntoView = vi.fn();

// Mock the bindings (needed by useLocalChat + useCurrentProject inside ChatWindow)
vi.mock("../../bindings", () => ({
  commands: {
    getCurrentProject: vi.fn().mockResolvedValue({
      status: "ok",
      data: "/test/project",
    }),
    getCurrentProjectPath: vi.fn().mockResolvedValue({
      status: "ok",
      data: "/test/project",
    }),
    getProjects: vi.fn().mockResolvedValue({
      status: "ok",
      data: savedProjects,
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
            available: true,
            unavailable_reason: null,
            default_model_id: "gpt-5.5",
            default_reasoning_effort: "medium",
            reasoning_efforts: [{ id: "medium", label: "Medium" }],
            supports_resume: true,
            models: [
              {
                id: "gpt-5.5",
                label: "GPT-5.5",
                supported_reasoning_effort_ids: null,
              },
            ],
          },
        ],
      },
    }),
    createLocalChatSession: vi.fn().mockResolvedValue({ status: "ok" }),
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
    id: `session-${Date.now()}-${Math.random()}`,
    label: "Test Task",
    messages: [],
    status: "open",
    harness: "claude",
    backendSessionId: null,
    providerResumeId: null,
    ...overrides,
  };
}

describe("ChatWindowManager", () => {
  beforeEach(() => {
    localStorage.clear();
    clearPersistedLocalChatSessions();
    vi.clearAllMocks();
    vi.mocked(commands.getCurrentProject).mockResolvedValue({
      status: "ok",
      data: "/test/project",
    });
    vi.mocked(commands.getCurrentProjectPath).mockResolvedValue({
      status: "ok",
      data: "/test/project",
    });
    vi.mocked(commands.getProjects).mockResolvedValue({
      status: "ok",
      data: savedProjects,
    });
    vi.mocked(commands.createLocalChatSession).mockResolvedValue({
      status: "ok",
      data: null,
    });
    vi.mocked(commands.sendLocalChatMessage).mockResolvedValue({
      status: "ok",
      data: null,
    });
    vi.mocked(commands.closeLocalChatSession).mockResolvedValue({
      status: "ok",
      data: null,
    });
    useChatStore.setState({
      sessions: {},
      activeSessionId: null,
      paneLayout: { panes: [], activePaneId: null },
      panelOpen: false,
      localSessionSummaries: {},
    });
    usePanelFocusStore.getState().reset();
    usePanelLayoutStore.getState().reset();
  });

  it("does not render when panel is closed", () => {
    const session = createSession({ id: "s1" });
    useChatStore.setState({
      sessions: { s1: session },
      activeSessionId: "s1",
      panelOpen: false,
    });

    const { container } = render(<ChatWindowManager />);
    expect(container.innerHTML).toBe("");
  });

  it("does not render when there are no sessions", () => {
    useChatStore.setState({
      sessions: {},
      activeSessionId: null,
      panelOpen: true,
    });

    const { container } = render(<ChatWindowManager />);
    expect(container.innerHTML).toBe("");
  });

  it("renders the active session as a single header band, with no tabs", () => {
    const s1 = createSession({
      id: "s1",
      label: "New Chat",
    });

    useChatStore.setState({
      sessions: { s1 },
      activeSessionId: "s1",
      panelOpen: true,
    });

    render(<ChatWindowManager />);

    // The session label is the header title; tabs were removed.
    expect(screen.getByText("New Chat")).toBeInTheDocument();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(usePanelLayoutStore.getState().chat).toEqual({
      isPresent: true,
      renderedWidth: 384,
      isMaximized: false,
    });
  });

  it("toggles maximized width with Cmd+\\ and restores the prior normal width", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1200,
    });
    const s1 = createSession({
      id: "s1",
      label: "New Chat",
    });

    useChatStore.setState({
      sessions: { s1 },
      activeSessionId: "s1",
      panelOpen: true,
    });

    render(<ChatWindowManager />);

    const panel = screen.getByTestId("chat-window-manager");
    expect(panel).toHaveStyle({ width: "384px" });

    fireEvent.keyDown(window, { key: "\\", metaKey: true });
    expect(panel).toHaveAttribute("data-maximized", "true");
    expect(panel).toHaveStyle({ width: "1128px" });
    expect(usePanelLayoutStore.getState().chat).toEqual({
      isPresent: true,
      renderedWidth: 1128,
      isMaximized: true,
    });
    expect(localStorage.getItem("chat-window-manager-width")).toBe("384");

    fireEvent.keyDown(window, { key: "\\", metaKey: true });
    expect(panel).not.toHaveAttribute("data-maximized");
    expect(panel).toHaveStyle({ width: "384px" });
  });

  it("toggles the wide project chat view from the header control", async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1200,
    });
    const s1 = createSession({
      id: "s1",
      label: "New Chat",
    });

    useChatStore.setState({
      sessions: { s1 },
      activeSessionId: "s1",
      panelOpen: true,
    });

    render(<ChatWindowManager />);

    const panel = screen.getByTestId("chat-window-manager");
    await user.click(screen.getByRole("button", { name: "Widen chat panel" }));

    expect(panel).toHaveAttribute("data-maximized", "true");
    expect(screen.getByTestId("local-chat-mini-panel")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Collapse chat panel" })
    );

    expect(panel).not.toHaveAttribute("data-maximized");
  });

  it("shows mini thread rows with harness indicators and compact agent children in wide view", async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1200,
    });
    const s1 = createSession({
      id: "s1",
      label: "Claude Chat",
      title: "Inspect Repo",
      titleStatus: "generated",
      projectPath: "/test/project",
      messages: [
        {
          kind: "assistant",
          text: "spawning",
          timestamp: "2024-01-01T12:00:00Z",
        },
        {
          kind: "tool_call",
          toolName: "Agent",
          toolId: "agent-1",
          input: JSON.stringify({
            description: "Inspect repo",
            subagent_type: "analysis",
            receiver_agents: [
              {
                thread_id: "agent-thread-1",
                agent_nickname: "Pasteur",
                agent_role: "reviewer",
              },
            ],
          }),
          timestamp: "2024-01-01T12:00:01Z",
        },
        {
          kind: "assistant",
          text: "child output",
          timestamp: "2024-01-01T12:00:02Z",
          parentToolUseId: "agent-1",
        },
      ],
    });
    const s2 = createSession({
      id: "s2",
      label: "Codex Chat",
      harness: "codex",
      projectPath: "/test/project",
      messages: [
        {
          kind: "user",
          text: "codex saved question",
          timestamp: "2024-01-01T12:00:03Z",
        },
      ],
    });
    persistLocalChatSession(s1);
    persistLocalChatSession(s2);

    useChatStore.setState({
      sessions: { s1, s2 },
      activeSessionId: "s1",
      panelOpen: true,
    });

    render(<ChatWindowManager />);
    await user.click(screen.getByRole("button", { name: "Widen chat panel" }));

    const miniPanel = within(screen.getByTestId("local-chat-mini-panel"));
    expect(miniPanel.getByText("Inspect Repo")).toBeInTheDocument();
    expect(miniPanel.getByText("Pasteur")).toBeInTheDocument();
    expect(miniPanel.getByText("reviewer")).toBeInTheDocument();
    expect(miniPanel.getByText("Codex Chat")).toBeInTheDocument();
    expect(miniPanel.queryByText("child output")).not.toBeInTheDocument();
    expect(
      miniPanel.queryByText("codex saved question")
    ).not.toBeInTheDocument();
    expect(miniPanel.getByLabelText("Claude harness")).toBeInTheDocument();
    expect(miniPanel.getByLabelText("Codex harness")).toBeInTheDocument();
    expect(
      miniPanel.getByRole("button", {
        name: "Open spawned agent Pasteur from Inspect Repo",
      })
    ).toBeInTheDocument();
  });

  it("opens spawned agent rows as provider thread sessions", async () => {
    const user = userEvent.setup();

    const parent = createSession({
      id: "parent",
      label: "Inspect Repo",
      harness: "codex",
      model: "gpt-5.5",
      projectPath: "/test/project",
      messages: [
        {
          kind: "tool_call",
          toolName: "Agent",
          toolId: "agent-1",
          input: JSON.stringify({
            description: "Inspect repo",
            subagent_type: "analysis",
            receiver_agents: [
              {
                thread_id: "agent-thread-1",
                agent_nickname: "Pasteur",
                agent_role: "reviewer",
              },
            ],
          }),
          timestamp: "2024-01-01T12:00:01Z",
        },
      ],
    });
    persistLocalChatSession(parent);
    persistLocalChatSession(
      createSession({
        id: "stale-child",
        label: "Pasteur",
        title: "Pasteur",
        harness: "codex",
        projectPath: "/test/project",
        providerResumeId: "agent-thread-1",
      })
    );

    useChatStore.setState({
      sessions: { parent },
      activeSessionId: "parent",
      panelOpen: true,
    });

    render(<ChatWindowManager />);
    await user.click(screen.getByRole("button", { name: "Widen chat panel" }));
    const miniPanel = within(screen.getByTestId("local-chat-mini-panel"));
    expect(
      miniPanel.queryByRole("button", {
        name: "Load local chat Pasteur into active pane",
      })
    ).not.toBeInTheDocument();
    await user.click(
      miniPanel.getByRole("button", {
        name: "Open spawned agent Pasteur from Inspect Repo",
      })
    );

    await waitFor(() => {
      expect(useChatStore.getState().activeSessionId).toBe(
        "local-chat-codex-agent-thread-1"
      );
    });
    const selected =
      useChatStore.getState().sessions["local-chat-codex-agent-thread-1"];
    expect(selected).toMatchObject({
      label: "Pasteur",
      title: "Pasteur",
      harness: "codex",
      providerResumeId: "agent-thread-1",
    });
    expect(
      miniPanel.getByRole("button", {
        name: "Open spawned agent Pasteur from Inspect Repo",
      })
    ).toHaveAttribute("aria-current", "true");
    expect(selected?.messages).toEqual([]);
    expect(
      loadPersistedLocalChatSession("local-chat-codex-agent-thread-1")
    ).toBeNull();
  });

  it("keeps top-level provider sessions visible when their own outline references their provider thread", async () => {
    const user = userEvent.setup();
    const session = createSession({
      id: "real-session",
      label: "Project Pending Items Summary",
      title: "Project Pending Items Summary",
      harness: "codex",
      model: "gpt-5.5",
      projectPath: "/test/project",
      providerResumeId: "real-provider-thread",
      messages: [
        {
          kind: "tool_call",
          toolName: "Agent",
          toolId: "agent-1",
          input: JSON.stringify({
            description: "Project Pending Items Summary",
            receiver_agents: [
              {
                thread_id: "real-provider-thread",
                agent_nickname: "Project Pending Items Summary",
                agent_role: "analysis",
              },
            ],
          }),
          timestamp: "2024-01-01T12:00:01Z",
        },
      ],
    });
    persistLocalChatSession(session);

    useChatStore.setState({
      sessions: { [session.id]: session },
      activeSessionId: session.id,
      panelOpen: true,
    });

    render(<ChatWindowManager />);
    await user.click(screen.getByRole("button", { name: "Widen chat panel" }));
    const miniPanel = within(screen.getByTestId("local-chat-mini-panel"));
    expect(
      miniPanel.getByRole("button", {
        name: "Load local chat Project Pending Items Summary into active pane",
      })
    ).toBeInTheDocument();
    expect(
      miniPanel.queryByRole("button", {
        name: "Open spawned agent Project Pending Items Summary from Project Pending Items Summary",
      })
    ).not.toBeInTheDocument();
  });

  it("updates maximized width when the viewport resizes", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1200,
    });
    const s1 = createSession({ id: "s1", label: "Task A" });
    useChatStore.setState({
      sessions: { s1 },
      activeSessionId: "s1",
      panelOpen: true,
    });

    render(<ChatWindowManager />);

    const panel = screen.getByTestId("chat-window-manager");
    fireEvent.keyDown(window, { key: "\\", metaKey: true });
    expect(panel).toHaveStyle({ width: "1128px" });

    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 900,
    });
    fireEvent.resize(window);

    expect(panel).toHaveStyle({ width: "828px" });
  });

  it("ignores Cmd+\\ when the chat panel is closed or has no sessions", () => {
    const s1 = createSession({ id: "s1", label: "Task A" });
    useChatStore.setState({
      sessions: { s1 },
      activeSessionId: "s1",
      panelOpen: false,
    });

    const { rerender } = render(<ChatWindowManager />);
    fireEvent.keyDown(window, { key: "\\", metaKey: true });
    expect(screen.queryByTestId("chat-window-manager")).toBeNull();

    act(() => {
      useChatStore.setState({
        sessions: {},
        activeSessionId: null,
        panelOpen: true,
      });
    });
    rerender(<ChatWindowManager />);
    fireEvent.keyDown(window, { key: "\\", metaKey: true });
    expect(screen.queryByTestId("chat-window-manager")).toBeNull();
  });

  it("toggles maximized width with Cmd+\\ while the composer is focused", async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1200,
    });
    const s1 = createSession({
      id: "s1",
      label: "New Chat",
    });

    useChatStore.setState({
      sessions: { s1 },
      activeSessionId: "s1",
      panelOpen: true,
    });

    render(<ChatWindowManager />);

    const textarea = screen.getByTestId("local-chat-composer");
    await user.click(textarea);
    expect(textarea).toHaveFocus();

    const panel = screen.getByTestId("chat-window-manager");
    fireEvent.keyDown(textarea, { key: "\\", metaKey: true });

    expect(panel).toHaveAttribute("data-maximized", "true");
    expect(panel).toHaveStyle({ width: "1128px" });
  });

  it("manual keyboard resize exits maximized mode and stores the restored width", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1200,
    });
    const s1 = createSession({ id: "s1", label: "Task A" });
    useChatStore.setState({
      sessions: { s1 },
      activeSessionId: "s1",
      panelOpen: true,
    });

    render(<ChatWindowManager />);

    const panel = screen.getByTestId("chat-window-manager");
    fireEvent.keyDown(window, { key: "\\", metaKey: true });
    expect(panel).toHaveAttribute("data-maximized", "true");

    fireEvent.keyDown(screen.getByTestId("chat-resize-handle"), {
      key: "ArrowLeft",
    });

    expect(panel).not.toHaveAttribute("data-maximized");
    expect(panel).toHaveStyle({ width: "760px" });
    expect(localStorage.getItem("chat-window-manager-width")).toBe("760");
  });

  it("shows close panel button", () => {
    const s1 = createSession({ id: "s1", label: "Task A" });

    useChatStore.setState({
      sessions: { s1 },
      activeSessionId: "s1",
      panelOpen: true,
    });

    render(<ChatWindowManager />);

    expect(screen.getByTitle("Close chat panel")).toBeInTheDocument();
  });

  it("toggles panel when close panel button is clicked", async () => {
    const user = userEvent.setup();
    const s1 = createSession({
      id: "s1",
      label: "Task A",
      messages: [
        {
          kind: "user",
          text: "persist through close",
          timestamp: "2026-01-01T00:00:00Z",
        },
      ],
      providerResumeId: "conv-close",
      projectPath: "/test/project",
    });
    persistLocalChatSession(s1);

    useChatStore.setState({
      sessions: { s1 },
      activeSessionId: "s1",
      panelOpen: true,
    });

    render(<ChatWindowManager />);

    await user.click(screen.getByTitle("Close chat panel"));
    expect(useChatStore.getState().panelOpen).toBe(false);

    let reopened = "";
    act(() => {
      useChatStore.setState({
        sessions: {},
        activeSessionId: null,
        panelOpen: false,
      });
      reopened = useChatStore.getState().openSession("Task A", "/test/project");
    });
    expect(reopened).toBe("s1");
    expect(useChatStore.getState().sessions.s1.messages).toEqual([]);
    expect(useChatStore.getState().sessions.s1.providerResumeId).toBe(
      "conv-close"
    );
  });

  it("trash clears messages and prevents later restored session from reappearing", async () => {
    const user = userEvent.setup();
    const id = useChatStore.getState().openSession("Task A", "/test/project");
    useChatStore.getState().addMessage(id, {
      kind: "user",
      text: "delete this",
      timestamp: "2026-01-01T00:00:00Z",
    });
    useChatStore.getState().setProviderResumeId(id, "conv-delete");

    render(<ChatWindowManager />);

    await user.click(screen.getByTitle("Clear messages"));

    expect(loadPersistedLocalChatSession(id)).toBeNull();
    expect(useChatStore.getState().sessions[id].messages).toEqual([]);

    let reopened = "";
    act(() => {
      useChatStore.setState({
        sessions: {},
        activeSessionId: null,
        panelOpen: false,
      });
      reopened = useChatStore.getState().openSession("Task A", "/test/project");
    });

    expect(reopened).not.toBe(id);
    expect(screen.queryByText("delete this")).not.toBeInTheDocument();
    expect(useChatStore.getState().sessions[reopened].messages).toEqual([]);
    expect(
      useChatStore.getState().sessions[reopened].providerResumeId
    ).toBeNull();
  });

  it("manages persisted local sessions without invoking backend chat persistence", async () => {
    const user = userEvent.setup();
    const first = useChatStore
      .getState()
      .openSession("Task One", "/test/project");
    useChatStore.getState().addMessage(first, {
      kind: "user",
      text: "first saved question",
      timestamp: "2026-01-01T00:00:00Z",
    });
    const second = useChatStore
      .getState()
      .startFreshSession("Task Two", "/test/project");
    useChatStore.getState().addMessage(second, {
      kind: "assistant",
      text: "second saved answer",
      timestamp: "2026-01-02T00:00:00Z",
    });
    useChatStore.getState().setProviderResumeId(second, "conv-two");
    useChatStore.getState().focusSession(first);

    render(<ChatWindowManager />);

    await user.click(screen.getByLabelText("Widen chat panel"));
    const miniPanel = within(screen.getByTestId("local-chat-mini-panel"));
    expect(miniPanel.getByText("Task One")).toBeInTheDocument();
    expect(miniPanel.getByText("Task Two")).toBeInTheDocument();
    expect(miniPanel.getAllByLabelText("Claude harness")).toHaveLength(2);

    await user.click(
      screen.getByLabelText("Load local chat Task Two into active pane")
    );
    expect(useChatStore.getState().activeSessionId).toBe(second);
    expect(useChatStore.getState().sessions[second].providerResumeId).toBe(
      "conv-two"
    );

    await user.click(screen.getByLabelText("Delete local chat Task One"));
    expect(loadPersistedLocalChatSession(first)).toBeNull();
    expect(loadPersistedLocalChatSession(second)?.id).toBe(second);
    expect(
      miniPanel.queryByRole("button", { name: "Start fresh local chat" })
    ).not.toBeInTheDocument();
    expect(commands.createLocalChatSession).not.toHaveBeenCalled();
    expect(commands.sendLocalChatMessage).not.toHaveBeenCalled();
  });

  it("starts a fresh chat in the currently selected project instead of the active session's old project", async () => {
    vi.mocked(commands.getCurrentProjectPath).mockResolvedValue({
      status: "ok",
      data: "/new/project",
    });
    const user = userEvent.setup();
    const stale = useChatStore
      .getState()
      .openSession("Stale Project Chat", "/old/project");
    useChatStore.getState().focusSession(stale);

    render(<ChatWindowManager />);
    await waitFor(() => {
      expect(commands.getCurrentProjectPath).toHaveBeenCalled();
    });

    await user.click(screen.getByLabelText("Widen chat panel"));
    await user.click(screen.getByLabelText("Start fresh local chat"));

    await waitFor(() => {
      expect(useChatStore.getState().activeSessionId).not.toBe(stale);
    });
    const fresh = useChatStore.getState().activeSessionId;
    expect(fresh).not.toBeNull();
    expect(useChatStore.getState().sessions[fresh!]).toMatchObject({
      label: "New Chat",
      projectPath: "/new/project",
      providerResumeId: null,
    });
  });

  it("groups local chat history by project with the current project first and fallback last", async () => {
    vi.mocked(commands.getCurrentProjectPath).mockResolvedValue({
      status: "ok",
      data: "/new/project",
    });
    const user = userEvent.setup();
    const stale = useChatStore
      .getState()
      .openSession("Old Project Chat", "/old/project");
    useChatStore.getState().addMessage(stale, {
      kind: "assistant",
      text: "old project answer",
      timestamp: "2026-01-01T00:00:00Z",
    });
    const current = useChatStore
      .getState()
      .openSession("Current Project Chat", "/new/project");
    useChatStore.getState().addMessage(current, {
      kind: "user",
      text: "new project answer",
      timestamp: "2026-01-02T00:00:00Z",
    });
    const currentOlder = useChatStore
      .getState()
      .startFreshSession("Older Current Project Chat", "/new/project");
    useChatStore.getState().addMessage(currentOlder, {
      kind: "user",
      text: "older current project answer",
      timestamp: "2026-01-01T12:00:00Z",
    });
    const noProject = useChatStore
      .getState()
      .startFreshSession("No Project Chat", null);
    useChatStore.getState().addMessage(noProject, {
      kind: "assistant",
      text: "no-project answer",
      timestamp: "2026-01-03T00:00:00Z",
    });
    useChatStore.getState().focusSession(stale);

    render(<ChatWindowManager />);
    await waitFor(() => {
      expect(commands.getCurrentProjectPath).toHaveBeenCalled();
    });

    await user.click(screen.getByLabelText("Widen chat panel"));
    const miniPanel = within(screen.getByTestId("local-chat-mini-panel"));
    await waitFor(() => {
      expect(miniPanel.getAllByRole("heading", { level: 3 })).toHaveLength(3);
    });
    expect(
      miniPanel
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent)
    ).toEqual(["new-project", "old-project", "Unknown project"]);

    const currentGroup = within(
      miniPanel.getByRole("region", { name: "new-project chats" })
    );
    expect(
      currentGroup
        .getAllByRole("button", { name: /^Load local chat/ })
        .map((button) => button.getAttribute("aria-label"))
    ).toEqual([
      "Load local chat Current Project Chat into active pane",
      "Load local chat Older Current Project Chat into active pane",
    ]);

    expect(miniPanel.getByText("Current Project Chat")).toBeInTheDocument();
    expect(miniPanel.getByText("Old Project Chat")).toBeInTheDocument();
    expect(miniPanel.getByText("No Project Chat")).toBeInTheDocument();
  });

  it("keeps project load failures scoped to current-project chats", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(commands.getCurrentProjectPath).mockResolvedValue({
      status: "ok",
      data: "/new/project",
    });
    vi.mocked(commands.getProjects).mockResolvedValue({
      status: "error",
      error: { SendFailed: "project registry unavailable" },
    } as never);
    const user = userEvent.setup();
    const stale = useChatStore
      .getState()
      .openSession("Old Project Chat", "/old/project");
    useChatStore.getState().addMessage(stale, {
      kind: "assistant",
      text: "old project answer",
      timestamp: "2026-01-01T00:00:00Z",
    });
    const current = useChatStore
      .getState()
      .openSession("Current Project Chat", "/new/project");
    useChatStore.getState().addMessage(current, {
      kind: "assistant",
      text: "new project answer",
      timestamp: "2026-01-02T00:00:00Z",
    });
    useChatStore.getState().focusSession(stale);

    try {
      render(<ChatWindowManager />);
      await waitFor(() => {
        expect(commands.getProjects).toHaveBeenCalled();
      });

      await user.click(screen.getByLabelText("Widen chat panel"));
      const miniPanel = within(screen.getByTestId("local-chat-mini-panel"));

      expect(
        await miniPanel.findByText(
          "Could not load saved projects. Showing current project chats only."
        )
      ).toBeInTheDocument();
      expect(miniPanel.getByText("Current Project Chat")).toBeInTheDocument();
      expect(miniPanel.queryByText("Old Project Chat")).not.toBeInTheDocument();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("shows a mini thread selector while maximized and keeps the main chat visible", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1200,
    });
    const first = createSession({
      id: "task-one",
      label: "Task One",
      projectPath: "/test/project",
      messages: [
        {
          kind: "user",
          text: "first saved question",
          timestamp: "2026-01-01T00:00:00Z",
        },
      ],
    });
    const second = createSession({
      id: "task-two",
      label: "Task Two",
      projectPath: "/test/project",
      messages: [
        {
          kind: "assistant",
          text: "second saved answer",
          timestamp: "2026-01-02T00:00:00Z",
        },
      ],
    });
    persistLocalChatSession(first);
    persistLocalChatSession(second);
    useChatStore.setState({
      sessions: { [first.id]: first, [second.id]: second },
      activeSessionId: first.id,
      paneLayout: {
        panes: [{ id: "pane-one", sessionId: first.id }],
        activePaneId: "pane-one",
      },
      panelOpen: true,
    });

    render(<ChatWindowManager />);

    fireEvent.keyDown(window, { key: "\\", metaKey: true });

    expect(screen.getByTestId("local-chat-mini-panel")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Load local chat Task One into active pane")
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("first saved question")).toBeInTheDocument();
    });
    expect(screen.getByText("Task Two")).toBeInTheDocument();

    fireEvent.click(
      screen.getByLabelText("Load local chat Task Two into active pane")
    );

    await waitFor(() => {
      expect(useChatStore.getState().activeSessionId).toBe(second.id);
    });
    expect(screen.getByText("second saved answer")).toBeInTheDocument();
    expect(screen.getByTestId("local-chat-mini-panel")).toBeInTheDocument();
  });

  it("splits the maximized chat into two distinct session panes", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1200,
    });
    const user = userEvent.setup();
    const first = useChatStore
      .getState()
      .openSession("Task One", "/test/project");

    render(<ChatWindowManager />);
    fireEvent.keyDown(window, { key: "\\", metaKey: true });

    await user.click(screen.getByLabelText("Split chat pane"));

    await waitFor(() => {
      expect(screen.getAllByTestId("chat-pane")).toHaveLength(2);
    });
    const state = useChatStore.getState();
    const paneSessionIds = state.paneLayout.panes.map((pane) => pane.sessionId);
    expect(paneSessionIds).toHaveLength(2);
    expect(new Set(paneSessionIds).size).toBe(2);
    expect(paneSessionIds[0]).toBe(first);
    expect(state.sessions[paneSessionIds[1]]).toMatchObject({
      label: "New Chat",
      projectPath: "/test/project",
      backendSessionId: null,
    });
  });

  it("splits the maximized chat with Cmd+Option+Backslash", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1200,
    });
    useChatStore.getState().openSession("Task One", "/test/project");

    render(<ChatWindowManager />);
    fireEvent.keyDown(window, { key: "\\", metaKey: true });
    fireEvent.keyDown(window, { key: "\\", metaKey: true, altKey: true });

    await waitFor(() => {
      expect(screen.getAllByTestId("chat-pane")).toHaveLength(2);
    });
    expect(useChatStore.getState().paneLayout.panes).toHaveLength(2);
  });

  it("can split the maximized chat into more than two vertical panes", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1800,
    });
    const user = userEvent.setup();
    const first = useChatStore
      .getState()
      .openSession("Task One", "/test/project");

    render(<ChatWindowManager />);
    fireEvent.keyDown(window, { key: "\\", metaKey: true });

    for (let targetPaneCount = 2; targetPaneCount <= 3; targetPaneCount += 1) {
      const splitButtons = screen
        .getAllByLabelText("Split chat pane")
        .filter((button) => !(button as HTMLButtonElement).disabled);
      await user.click(splitButtons[splitButtons.length - 1]);
      await waitFor(() => {
        expect(screen.getAllByTestId("chat-pane")).toHaveLength(
          targetPaneCount
        );
      });
    }

    const paneSessionIds = useChatStore
      .getState()
      .paneLayout.panes.map((pane) => pane.sessionId);
    expect(paneSessionIds).toHaveLength(3);
    expect(new Set(paneSessionIds).size).toBe(3);
    expect(paneSessionIds[0]).toBe(first);
  });

  it("disables splitting when the maximized panel is too narrow for two panes", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 900,
    });
    const user = userEvent.setup();
    useChatStore.getState().openSession("Task One", "/test/project");

    render(<ChatWindowManager />);
    fireEvent.keyDown(window, { key: "\\", metaKey: true });

    const splitButton = screen.getByLabelText("Split chat pane");
    expect(splitButton).toBeDisabled();
    await user.click(splitButton);

    expect(screen.getAllByTestId("chat-pane")).toHaveLength(1);
    expect(useChatStore.getState().paneLayout.panes).toHaveLength(1);
  });

  it("keeps split pane input and backend sends independent", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1200,
    });
    const user = userEvent.setup();
    const left = createSession({
      id: "left",
      label: "Left Chat",
      backendSessionId: "backend-left",
      lifecycle: "idle",
    });
    const right = createSession({
      id: "right",
      label: "Right Chat",
      backendSessionId: "backend-right",
      lifecycle: "idle",
    });
    useChatStore.setState({
      sessions: { left, right },
      activeSessionId: "left",
      paneLayout: {
        panes: [
          { id: "pane-left", sessionId: "left" },
          { id: "pane-right", sessionId: "right" },
        ],
        activePaneId: "pane-left",
      },
      panelOpen: true,
    });

    render(<ChatWindowManager />);
    fireEvent.keyDown(window, { key: "\\", metaKey: true });

    const panes = screen.getAllByTestId("chat-pane");
    const leftComposer = within(panes[0]).getByTestId("local-chat-composer");
    const rightComposer = within(panes[1]).getByTestId("local-chat-composer");
    await user.type(leftComposer, "left message");
    await user.type(rightComposer, "right message");

    expect(leftComposer).toHaveValue("left message");
    expect(rightComposer).toHaveValue("right message");

    await user.click(leftComposer);
    await user.keyboard("{Enter}");
    await user.click(rightComposer);
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(commands.sendLocalChatMessage).toHaveBeenCalledWith(
        "backend-left",
        "left message"
      );
      expect(commands.sendLocalChatMessage).toHaveBeenCalledWith(
        "backend-right",
        "right message"
      );
    });
    expect(useChatStore.getState().sessions.left.messages).toEqual([
      expect.objectContaining({ kind: "user", text: "left message" }),
    ]);
    expect(useChatStore.getState().sessions.right.messages).toEqual([
      expect.objectContaining({ kind: "user", text: "right message" }),
    ]);
  });

  it("keeps the footer metadata row aligned when one split pane has no usage yet", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1200,
    });
    const left = createSession({
      id: "left",
      label: "Left Chat",
      backendSessionId: "backend-left",
      model: "claude-haiku",
      tokenUsage: { used: 28_000, max: 200_000 },
    });
    const right = createSession({
      id: "right",
      label: "Right Chat",
      backendSessionId: null,
    });
    useChatStore.setState({
      sessions: { left, right },
      activeSessionId: "left",
      paneLayout: {
        panes: [
          { id: "pane-left", sessionId: "left" },
          { id: "pane-right", sessionId: "right" },
        ],
        activePaneId: "pane-left",
      },
      panelOpen: true,
    });

    render(<ChatWindowManager />);
    fireEvent.keyDown(window, { key: "\\", metaKey: true });

    const panes = screen.getAllByTestId("chat-pane");
    const footerRows = panes.map((pane) => pane.querySelector(".hc-foot-meta"));
    expect(footerRows[0]).toHaveTextContent("context 14%");
    expect(footerRows[1]).toBeInTheDocument();
    expect(footerRows[1]?.textContent?.trim()).toBe("");
  });

  it("renders simultaneous streaming content in the correct split panes", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1200,
    });
    const left = createSession({
      id: "left",
      label: "Left Chat",
      backendSessionId: "backend-left",
      lifecycle: "streaming",
      messages: [
        {
          kind: "user",
          text: "left prompt",
          timestamp: "2026-01-01T00:00:00Z",
        },
      ],
      streamingAssistant: {
        text: "left streaming answer",
        timestamp: "2026-01-01T00:00:01Z",
      },
    });
    const right = createSession({
      id: "right",
      label: "Right Chat",
      backendSessionId: "backend-right",
      lifecycle: "streaming",
      messages: [
        {
          kind: "user",
          text: "right prompt",
          timestamp: "2026-01-01T00:00:00Z",
        },
      ],
      streamingAssistant: {
        text: "right streaming answer",
        timestamp: "2026-01-01T00:00:01Z",
      },
    });
    useChatStore.setState({
      sessions: { left, right },
      activeSessionId: "left",
      paneLayout: {
        panes: [
          { id: "pane-left", sessionId: "left" },
          { id: "pane-right", sessionId: "right" },
        ],
        activePaneId: "pane-left",
      },
      panelOpen: true,
    });

    render(<ChatWindowManager />);
    fireEvent.keyDown(window, { key: "\\", metaKey: true });

    const panes = screen.getAllByTestId("chat-pane");
    expect(within(panes[0]).getByText("left streaming answer")).toBeVisible();
    expect(within(panes[1]).getByText("right streaming answer")).toBeVisible();
    expect(
      within(panes[0]).queryByText("right streaming answer")
    ).not.toBeInTheDocument();
    expect(
      within(panes[1]).queryByText("left streaming answer")
    ).not.toBeInTheDocument();
  });

  it("routes mini selector choices to the selected pane without duplicating visible sessions", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1200,
    });
    const user = userEvent.setup();
    const first = useChatStore
      .getState()
      .openSession("Task One", "/test/project");
    const second = useChatStore
      .getState()
      .startFreshSessionInNewPane("Task Two", "/test/project");
    const third = "third";
    persistLocalChatSession(
      createSession({
        id: third,
        label: "Task Three",
        projectPath: "/test/project",
        messages: [
          {
            kind: "assistant",
            text: "third saved answer",
            timestamp: "2026-01-03T00:00:00Z",
          },
        ],
      })
    );
    useChatStore
      .getState()
      .focusPane(useChatStore.getState().paneLayout.panes[0].id);

    render(<ChatWindowManager />);
    fireEvent.keyDown(window, { key: "\\", metaKey: true });

    const firstPane = screen.getAllByTestId("chat-pane")[0];
    await user.click(firstPane);
    await user.click(
      await screen.findByLabelText(
        "Load local chat Task Three into active pane"
      )
    );

    let paneSessionIds = useChatStore
      .getState()
      .paneLayout.panes.map((pane) => pane.sessionId);
    expect(paneSessionIds).toEqual([third, second]);
    expect(useChatStore.getState().activeSessionId).toBe(third);

    await user.click(screen.getAllByTestId("chat-pane")[0]);
    await user.click(
      screen.getByLabelText("Load local chat Task Two into active pane")
    );

    paneSessionIds = useChatStore
      .getState()
      .paneLayout.panes.map((pane) => pane.sessionId);
    expect(paneSessionIds).toEqual([third, second]);
    expect(useChatStore.getState().activeSessionId).toBe(second);
    expect(useChatStore.getState().paneLayout.panes[0].sessionId).not.toBe(
      second
    );
    expect(useChatStore.getState().sessions[first]).toBeDefined();
  });

  it("loads mini selector choices into the pane selected by keyboard shortcut", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1200,
    });
    const first = useChatStore
      .getState()
      .openSession("Task One", "/test/project");
    const second = useChatStore
      .getState()
      .startFreshSessionInNewPane("Task Two", "/test/project");
    const third = "third";
    persistLocalChatSession(
      createSession({
        id: third,
        label: "Task Three",
        projectPath: "/test/project",
        messages: [
          {
            kind: "assistant",
            text: "third saved answer",
            timestamp: "2026-01-03T00:00:00Z",
          },
        ],
      })
    );

    render(<ChatWindowManager />);
    fireEvent.keyDown(window, { key: "\\", metaKey: true });
    await screen.findByTestId("local-chat-mini-panel");
    fireEvent.keyDown(window, { key: "2", metaKey: true, altKey: true });
    await waitFor(() => {
      expect(useChatStore.getState().activeSessionId).toBe(second);
    });

    await userEvent
      .setup()
      .click(
        await screen.findByLabelText(
          "Load local chat Task Three into active pane"
        )
      );

    expect(
      useChatStore.getState().paneLayout.panes.map((pane) => pane.sessionId)
    ).toEqual([first, third]);
    expect(useChatStore.getState().activeSessionId).toBe(third);
    expect(useChatStore.getState().sessions[second]).toBeDefined();
  });

  it("loads mini selector choices into the active pane with arrow keys and Enter", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1200,
    });
    const first = useChatStore
      .getState()
      .openSession("Task One", "/test/project");
    const second = useChatStore
      .getState()
      .startFreshSessionInNewPane("Task Two", "/test/project");
    const third = "third";
    persistLocalChatSession(
      createSession({
        id: third,
        label: "Task Three",
        projectPath: "/test/project",
        messages: [
          {
            kind: "assistant",
            text: "third saved answer",
            timestamp: "2026-01-03T00:00:00Z",
          },
        ],
      })
    );

    render(<ChatWindowManager />);
    fireEvent.keyDown(window, { key: "\\", metaKey: true });
    const miniPanel = await screen.findByTestId("local-chat-mini-panel");
    fireEvent.keyDown(window, {
      key: "™",
      code: "Digit2",
      metaKey: true,
      altKey: true,
    });
    await waitFor(() => {
      expect(useChatStore.getState().activeSessionId).toBe(second);
    });
    fireEvent.keyDown(window, {
      key: "Ó",
      code: "KeyH",
      metaKey: true,
      altKey: true,
      shiftKey: true,
    });
    await waitFor(() => {
      expect(miniPanel).toHaveFocus();
    });

    const historyButtons = screen.getAllByRole("button", {
      name: /^Load local chat/,
    });
    const targetIndex = historyButtons.findIndex(
      (button) =>
        button.getAttribute("aria-label") ===
        "Load local chat Task Three into active pane"
    );
    expect(targetIndex).toBeGreaterThanOrEqual(0);

    fireEvent.keyDown(miniPanel, { key: "Home" });
    expect(historyButtons[0]).toHaveFocus();
    for (let index = 0; index < targetIndex; index += 1) {
      fireEvent.keyDown(document.activeElement ?? miniPanel, {
        key: "ArrowDown",
      });
    }
    expect(historyButtons[targetIndex]).toHaveFocus();

    fireEvent.keyDown(historyButtons[targetIndex], { key: "Enter" });

    expect(
      useChatStore.getState().paneLayout.panes.map((pane) => pane.sessionId)
    ).toEqual([first, third]);
    expect(useChatStore.getState().activeSessionId).toBe(third);
    expect(useChatStore.getState().sessions[second]).toBeDefined();
  });

  it("removes persisted-only history rows immediately when deleted", async () => {
    const user = userEvent.setup();
    useChatStore.getState().openSession("Active Task", "/test/project");
    persistLocalChatSession(
      createSession({
        id: "history-only",
        label: "History Only",
        projectPath: "/test/project",
        messages: [
          {
            kind: "user",
            text: "delete me",
            timestamp: "2026-01-04T00:00:00Z",
          },
        ],
        createdAt: "2026-01-04T00:00:00Z",
        updatedAt: "2026-01-04T00:00:00Z",
      })
    );

    render(<ChatWindowManager />);
    await user.click(screen.getByLabelText("Widen chat panel"));

    await user.click(
      await screen.findByLabelText("Delete local chat History Only")
    );

    await waitFor(() => {
      expect(loadPersistedLocalChatSession("history-only")).toBeNull();
    });
    await waitFor(() => {
      expect(
        screen.queryByLabelText("Load local chat History Only into active pane")
      ).not.toBeInTheDocument();
    });
    expect(loadPersistedLocalChatSession("history-only")).toBeNull();
  });

  it("closes one split pane while keeping the other session intact", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1200,
    });
    const user = userEvent.setup();
    const first = useChatStore
      .getState()
      .openSession("Task One", "/test/project");
    const second = useChatStore
      .getState()
      .startFreshSessionInNewPane("Task Two", "/test/project");
    useChatStore.getState().addMessage(second, {
      kind: "assistant",
      text: "keep this pane session",
      timestamp: "2026-01-02T00:00:00Z",
    });

    render(<ChatWindowManager />);
    fireEvent.keyDown(window, { key: "\\", metaKey: true });

    const secondPane = screen.getAllByTestId("chat-pane")[1];
    await user.click(within(secondPane).getByLabelText("Close this pane"));

    expect(screen.getAllByTestId("chat-pane")).toHaveLength(1);
    expect(useChatStore.getState().sessions[second]).toMatchObject({
      messages: [
        expect.objectContaining({
          kind: "assistant",
          text: "keep this pane session",
        }),
      ],
    });
    expect(useChatStore.getState().paneLayout.panes).toEqual([
      expect.objectContaining({ sessionId: first }),
    ]);
  });

  it("uses keyboard shortcuts to focus, close, and merge split panes", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1800,
    });
    const first = useChatStore.getState().openSession("Task One");
    const second = useChatStore
      .getState()
      .startFreshSessionInNewPane("Task Two");
    const third = useChatStore
      .getState()
      .startFreshSessionInNewPane("Task Three");

    render(<ChatWindowManager />);
    fireEvent.keyDown(window, { key: "\\", metaKey: true });

    fireEvent.keyDown(window, {
      key: "¡",
      code: "Digit1",
      metaKey: true,
      altKey: true,
    });
    expect(useChatStore.getState().activeSessionId).toBe(first);

    fireEvent.keyDown(window, {
      key: "ArrowRight",
      metaKey: true,
      altKey: true,
    });
    expect(useChatStore.getState().activeSessionId).toBe(second);

    fireEvent.keyDown(window, { key: "Tab", ctrlKey: true });
    expect(useChatStore.getState().activeSessionId).toBe(third);

    fireEvent.keyDown(window, { key: "w", metaKey: true, altKey: true });
    expect(useChatStore.getState().paneLayout.panes).toHaveLength(3);

    fireEvent.keyDown(window, { key: "x", metaKey: true, altKey: true });
    expect(useChatStore.getState().paneLayout.panes).toHaveLength(3);

    fireEvent.keyDown(window, {
      key: "|",
      code: "Backslash",
      metaKey: true,
      altKey: true,
      shiftKey: true,
    });
    expect(
      useChatStore.getState().paneLayout.panes.map((pane) => pane.sessionId)
    ).toEqual([first, second]);
    expect(useChatStore.getState().sessions[third]).toBeDefined();

    fireEvent.keyDown(window, {
      key: "™",
      code: "Digit2",
      metaKey: true,
      altKey: true,
    });
    expect(useChatStore.getState().activeSessionId).toBe(second);

    fireEvent.keyDown(window, {
      key: "µ",
      code: "KeyM",
      metaKey: true,
      altKey: true,
    });
    expect(useChatStore.getState().paneLayout.panes).toEqual([
      expect.objectContaining({ sessionId: second }),
    ]);
  });

  it("does not prevent app shortcuts when chat pane shortcuts cannot run", () => {
    useChatStore.getState().openSession("Task One");

    render(<ChatWindowManager />);

    const ctrlTab = new KeyboardEvent("keydown", {
      key: "Tab",
      ctrlKey: true,
      cancelable: true,
      bubbles: true,
    });
    window.dispatchEvent(ctrlTab);
    expect(ctrlTab.defaultPrevented).toBe(false);

    const unshiftedNewChat = new KeyboardEvent("keydown", {
      key: "Dead",
      code: "KeyN",
      metaKey: true,
      altKey: true,
      cancelable: true,
      bubbles: true,
    });
    window.dispatchEvent(unshiftedNewChat);
    expect(unshiftedNewChat.defaultPrevented).toBe(false);
  });

  it("keeps the global shortcut listener stable while sessions stream", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const id = useChatStore.getState().openSession("Task One");

    render(<ChatWindowManager />);
    const keydownAdds = addSpy.mock.calls.filter(
      ([type]) => type === "keydown"
    ).length;
    const keydownRemoves = removeSpy.mock.calls.filter(
      ([type]) => type === "keydown"
    ).length;

    act(() => {
      useChatStore.getState().updateLastAssistantMessage(id, "stream");
    });

    expect(
      addSpy.mock.calls.filter(([type]) => type === "keydown")
    ).toHaveLength(keydownAdds);
    expect(
      removeSpy.mock.calls.filter(([type]) => type === "keydown")
    ).toHaveLength(keydownRemoves);

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it("uses keyboard shortcuts to open history and start fresh chats", async () => {
    const first = useChatStore
      .getState()
      .openSession("Task One", "/test/project");

    render(<ChatWindowManager />);

    fireEvent.keyDown(window, {
      key: "˙",
      code: "KeyH",
      metaKey: true,
      altKey: true,
    });
    expect(
      screen.queryByTestId("local-chat-mini-panel")
    ).not.toBeInTheDocument();

    fireEvent.keyDown(window, {
      key: "Ó",
      code: "KeyH",
      metaKey: true,
      altKey: true,
      shiftKey: true,
    });
    expect(screen.getByTestId("local-chat-mini-panel")).toBeInTheDocument();
    expect(screen.getByTestId("chat-window-manager")).toHaveAttribute(
      "data-maximized",
      "true"
    );
    // Flush the requestAnimationFrame that focuses the mini panel so it does
    // not leak into subsequent tests.
    await waitFor(() => {
      expect(screen.getByTestId("local-chat-mini-panel")).toHaveFocus();
    });

    fireEvent.keyDown(window, {
      key: "Dead",
      code: "KeyN",
      metaKey: true,
      altKey: true,
    });
    expect(useChatStore.getState().activeSessionId).toBe(first);

    fireEvent.keyDown(window, {
      key: "Dead",
      code: "KeyN",
      metaKey: true,
      altKey: true,
      shiftKey: true,
    });

    await waitFor(() => {
      expect(useChatStore.getState().activeSessionId).not.toBe(first);
    });
    const fresh = useChatStore.getState().activeSessionId;
    expect(fresh).not.toBeNull();
    expect(useChatStore.getState().sessions[fresh!]).toMatchObject({
      label: "New Chat",
      projectPath: "/test/project",
    });
  });

  it("uses shifted session shortcuts against the active split pane", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1200,
    });
    const first = useChatStore
      .getState()
      .openSession("Task One", "/test/project");
    const second = useChatStore
      .getState()
      .startFreshSessionInNewPane("Task Two", "/test/project");

    render(<ChatWindowManager />);
    fireEvent.keyDown(window, { key: "\\", metaKey: true });
    await screen.findByTestId("local-chat-mini-panel");
    fireEvent.keyDown(window, {
      key: "™",
      code: "Digit2",
      metaKey: true,
      altKey: true,
    });
    await waitFor(() => {
      expect(useChatStore.getState().activeSessionId).toBe(second);
    });

    fireEvent.keyDown(window, {
      key: "˙",
      code: "KeyH",
      metaKey: true,
      altKey: true,
    });
    expect(screen.getByTestId("local-chat-mini-panel")).not.toHaveFocus();

    fireEvent.keyDown(window, {
      key: "Ó",
      code: "KeyH",
      metaKey: true,
      altKey: true,
      shiftKey: true,
    });
    await waitFor(() => {
      expect(screen.getByTestId("local-chat-mini-panel")).toHaveFocus();
    });

    fireEvent.keyDown(window, {
      key: "Dead",
      code: "KeyN",
      metaKey: true,
      altKey: true,
    });
    expect(
      useChatStore.getState().paneLayout.panes.map((pane) => pane.sessionId)
    ).toEqual([first, second]);

    fireEvent.keyDown(window, {
      key: "Dead",
      code: "KeyN",
      metaKey: true,
      altKey: true,
      shiftKey: true,
    });

    await waitFor(() => {
      expect(useChatStore.getState().activeSessionId).not.toBe(second);
    });
    const fresh = useChatStore.getState().activeSessionId;
    expect(fresh).not.toBeNull();
    expect(
      useChatStore.getState().paneLayout.panes.map((pane) => pane.sessionId)
    ).toEqual([first, fresh]);
    expect(useChatStore.getState().sessions[second]).toBeDefined();
  });

  it("shows chat keyboard shortcut hints with Cmd+Shift+Slash", () => {
    useChatStore.getState().openSession("Task One");

    render(<ChatWindowManager />);

    fireEvent.keyDown(window, { key: "?", metaKey: true, shiftKey: true });
    const dialog = screen.getByRole("dialog", {
      name: "Chat keyboard shortcuts",
    });
    expect(within(dialog).getByText("Chat shortcuts")).toBeInTheDocument();
    expect(within(dialog).getByText("Close active pane")).toBeInTheDocument();
    expect(within(dialog).queryByText("X")).not.toBeInTheDocument();
    expect(
      within(dialog).getByText("History for active pane")
    ).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(
      screen.queryByRole("dialog", { name: "Chat keyboard shortcuts" })
    ).not.toBeInTheDocument();
    expect(useChatStore.getState().panelOpen).toBe(true);
  });

  it("toggles chat keyboard shortcut hints with Cmd+Shift+Slash", () => {
    useChatStore.getState().openSession("Task One");

    render(<ChatWindowManager />);

    fireEvent.keyDown(window, { key: "/", metaKey: true, shiftKey: true });
    expect(
      screen.getByRole("dialog", { name: "Chat keyboard shortcuts" })
    ).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "/", metaKey: true, shiftKey: true });
    expect(
      screen.queryByRole("dialog", { name: "Chat keyboard shortcuts" })
    ).not.toBeInTheDocument();
  });

  it("groups the maximized mini thread selector by project", async () => {
    vi.mocked(commands.getCurrentProjectPath).mockResolvedValue({
      status: "ok",
      data: "/new/project",
    });
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1200,
    });

    const oldProject = useChatStore
      .getState()
      .openSession("Old Project Chat", "/old/project");
    useChatStore.getState().addMessage(oldProject, {
      kind: "assistant",
      text: "old project answer",
      timestamp: "2026-01-03T00:00:00Z",
    });
    const currentOlder = useChatStore
      .getState()
      .openSession("Current Older Chat", "/new/project");
    useChatStore.getState().addMessage(currentOlder, {
      kind: "user",
      text: "older current answer",
      timestamp: "2026-01-01T00:00:00Z",
    });
    const currentNewer = useChatStore
      .getState()
      .startFreshSession("Current Newer Chat", "/new/project");
    useChatStore.getState().addMessage(currentNewer, {
      kind: "user",
      text: "newer current answer",
      timestamp: "2026-01-02T00:00:00Z",
    });
    const noProject = useChatStore
      .getState()
      .startFreshSession("No Project Chat", null);
    useChatStore.getState().addMessage(noProject, {
      kind: "assistant",
      text: "no-project answer",
      timestamp: "2026-01-04T00:00:00Z",
    });
    useChatStore.getState().focusSession(oldProject);

    render(<ChatWindowManager />);
    fireEvent.keyDown(window, { key: "\\", metaKey: true });

    const miniPanel = within(screen.getByTestId("local-chat-mini-panel"));
    await waitFor(() => {
      expect(miniPanel.getAllByRole("heading", { level: 3 })).toHaveLength(3);
    });
    expect(
      miniPanel
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent)
    ).toEqual(["new-project", "old-project", "Unknown project"]);

    const currentGroup = within(
      miniPanel.getByRole("region", { name: "new-project chats" })
    );
    expect(
      currentGroup
        .getAllByRole("button", { name: /^Load local chat/ })
        .map((button) => button.getAttribute("aria-label"))
    ).toEqual([
      "Load local chat Current Newer Chat into active pane",
      "Load local chat Current Older Chat into active pane",
    ]);
    expect(miniPanel.getByText("Old Project Chat")).toBeInTheDocument();
    expect(miniPanel.getByText("No Project Chat")).toBeInTheDocument();
  });

  it("shows chat harness indicators in the maximized mini thread selector", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1200,
    });
    const first = useChatStore
      .getState()
      .openSession("Task One", "/test/project");
    useChatStore.getState().addMessage(first, {
      kind: "user",
      text: "first saved question",
      timestamp: "2026-01-01T00:00:00Z",
    });
    const second = useChatStore
      .getState()
      .startFreshSession("New Chat", "/test/project");
    useChatStore.getState().setSessionHarness(second, "codex");
    useChatStore.getState().addMessage(second, {
      kind: "user",
      text: "no model yet",
      timestamp: "2026-01-02T00:00:00Z",
    });
    useChatStore.getState().focusSession(first);

    render(<ChatWindowManager />);

    fireEvent.keyDown(window, { key: "\\", metaKey: true });
    const miniPanel = within(screen.getByTestId("local-chat-mini-panel"));

    await waitFor(() => {
      expect(miniPanel.getByLabelText("Claude harness")).toBeInTheDocument();
    });
    expect(miniPanel.getByLabelText("Codex harness")).toBeInTheDocument();
    expect(miniPanel.queryByText("sonnet-4.5")).not.toBeInTheDocument();
  });

  it("closes a live Claude session before deleting it from history", async () => {
    const user = userEvent.setup();
    const id = useChatStore
      .getState()
      .openSession("Live Task", "/test/project");
    useChatStore.getState().setBackendSessionId(id, "live-backend-session");

    render(<ChatWindowManager />);

    await user.click(screen.getByLabelText("Widen chat panel"));
    await user.click(
      await screen.findByLabelText("Delete local chat Live Task")
    );

    expect(commands.closeLocalChatSession).toHaveBeenCalledWith(
      "live-backend-session"
    );
    expect(loadPersistedLocalChatSession(id)).toBeNull();
    expect(useChatStore.getState().sessions[id]).toBeUndefined();
  });

  it("keeps the local session and shows feedback when close fails during history delete", async () => {
    vi.mocked(commands.closeLocalChatSession).mockResolvedValueOnce({
      status: "error",
      error: { SendFailed: "pipe closed" },
    } as never);
    const user = userEvent.setup();
    const id = useChatStore
      .getState()
      .openSession("Live Task", "/test/project");
    useChatStore.getState().addMessage(id, {
      kind: "user",
      text: "keep me",
      timestamp: "2026-01-01T00:00:00Z",
    });
    useChatStore.getState().setBackendSessionId(id, "live-backend-session");

    render(<ChatWindowManager />);

    await user.click(screen.getByLabelText("Widen chat panel"));
    await user.click(
      await screen.findByLabelText("Delete local chat Live Task")
    );

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Could not delete local chat. Try again."
      );
    });
    expect(loadPersistedLocalChatSession(id)).not.toBeNull();
    expect(useChatStore.getState().sessions[id]).toBeDefined();
  });

  it("closes the panel on Escape when it is the focused glass panel", async () => {
    const user = userEvent.setup();
    const s1 = createSession({ id: "s1", label: "Task A" });

    useChatStore.setState({
      sessions: { s1 },
      activeSessionId: "s1",
      panelOpen: true,
    });

    render(<ChatWindowManager />);
    // Registered itself and became the focused panel.
    expect(usePanelFocusStore.getState().stack).toContain("chat");

    await user.keyboard("{Escape}");
    expect(useChatStore.getState().panelOpen).toBe(false);
  });

  it("drills out on close: lingers with is-closing, then unmounts when the exit animation ends", () => {
    const s1 = createSession({ id: "s1", label: "Task A" });
    useChatStore.setState({
      sessions: { s1 },
      activeSessionId: "s1",
      panelOpen: true,
    });

    render(<ChatWindowManager />);
    expect(screen.getByTestId("chat-window-manager")).not.toHaveClass(
      "is-closing"
    );

    // Close: the panel stays mounted and drills out.
    act(() => {
      useChatStore.setState({ panelOpen: false });
    });
    const panel = screen.getByTestId("chat-window-manager");
    expect(panel).toHaveClass("is-closing");

    // The exit animation finishing on the panel root unmounts it.
    fireEvent.animationEnd(panel);
    expect(screen.queryByTestId("chat-window-manager")).not.toBeInTheDocument();
    expect(usePanelLayoutStore.getState().chat.isPresent).toBe(false);
  });

  it("keeps wide geometry published until the exit animation completes", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1200,
    });
    const s1 = createSession({ id: "s1", label: "Task A" });
    useChatStore.setState({
      sessions: { s1 },
      activeSessionId: "s1",
      panelOpen: true,
    });

    render(<ChatWindowManager />);
    fireEvent.keyDown(window, { key: "\\", metaKey: true });
    const panel = screen.getByTestId("chat-window-manager");

    act(() => useChatStore.setState({ panelOpen: false }));

    expect(panel).toHaveAttribute("data-maximized", "true");
    expect(panel).toHaveStyle({ width: "1128px" });
    expect(usePanelLayoutStore.getState().chat).toEqual({
      isPresent: true,
      renderedWidth: 1128,
      isMaximized: true,
    });

    fireEvent.animationEnd(panel);

    expect(usePanelLayoutStore.getState().chat).toEqual({
      isPresent: false,
      renderedWidth: 0,
      isMaximized: false,
    });
  });

});

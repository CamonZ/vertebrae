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

const { popOutMock, savedProjects } = vi.hoisted(() => {
  const popOutMock = vi.fn<
    (
      route: string,
      label: string,
      opts?: Record<string, unknown>
    ) => Promise<{
      window: { onCloseRequested: (h: () => void) => Promise<() => void> };
      reused: boolean;
    }>
  >();
  popOutMock.mockResolvedValue({
    window: { onCloseRequested: async () => () => {} },
    reused: false,
  });
  const savedProjects = [
    { slug: "test-project", project_id: "project-test", path: "/test/project" },
    { slug: "old-project", project_id: "project-old", path: "/old/project" },
    { slug: "new-project", project_id: "project-new", path: "/new/project" },
  ];
  return { popOutMock, savedProjects };
});

vi.mock("../../utils/popOut", () => ({ popOut: popOutMock }));

import { ChatWindowManager } from "./ChatWindowManager";
import { useChatStore } from "../../stores/chatStore";
import { usePanelFocusStore } from "../../stores/panelFocusStore";
import type { ChatSession } from "../../stores/chatStore";
import {
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
    getSupportedClaudeModels: vi.fn().mockResolvedValue({
      defaultModelId: "sonnet",
      models: [
        { id: "sonnet", label: "Sonnet" },
        { id: "opus", label: "Opus" },
        { id: "haiku", label: "Haiku" },
        { id: "fable", label: "Fable" },
      ],
    }),
    createClaudeSession: vi.fn().mockResolvedValue({ status: "ok" }),
    sendClaudeMessage: vi.fn().mockResolvedValue({ status: "ok" }),
    closeClaudeSession: vi.fn().mockResolvedValue({ status: "ok" }),
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
    claudeSessionWarningEvent: {
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
    claudeSessionId: null,
    claudeConversationId: null,
    ...overrides,
  };
}

describe("ChatWindowManager", () => {
  beforeEach(() => {
    localStorage.clear();
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
    vi.mocked(commands.createClaudeSession).mockResolvedValue({
      status: "ok",
      data: null,
    });
    vi.mocked(commands.sendClaudeMessage).mockResolvedValue({
      status: "ok",
      data: null,
    });
    vi.mocked(commands.closeClaudeSession).mockResolvedValue({
      status: "ok",
      data: null,
    });
    useChatStore.setState({
      sessions: {},
      activeSessionId: null,
      panelOpen: false,
    });
    usePanelFocusStore.getState().reset();
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
      label: "Project Chat",
    });

    useChatStore.setState({
      sessions: { s1 },
      activeSessionId: "s1",
      panelOpen: true,
    });

    render(<ChatWindowManager />);

    // The session label is the header title; tabs were removed.
    expect(screen.getByText("Project Chat")).toBeInTheDocument();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
  });

  it("toggles maximized width with Cmd+\\ and restores the prior normal width", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1200,
    });
    const s1 = createSession({
      id: "s1",
      label: "Project Chat",
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
    expect(panel).toHaveStyle({ width: "1184px" });
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
      label: "Project Chat",
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
    expect(panel).toHaveStyle({ width: "1184px" });

    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 900,
    });
    fireEvent.resize(window);

    expect(panel).toHaveStyle({ width: "884px" });
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
      label: "Project Chat",
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
    expect(panel).toHaveStyle({ width: "1184px" });
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
      claudeConversationId: "conv-close",
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
    expect(useChatStore.getState().sessions.s1.messages).toEqual([
      {
        kind: "user",
        text: "persist through close",
        timestamp: "2026-01-01T00:00:00Z",
      },
    ]);
    expect(useChatStore.getState().sessions.s1.claudeConversationId).toBe(
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
    useChatStore.getState().setClaudeConversationId(id, "conv-delete");

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
      useChatStore.getState().sessions[reopened].claudeConversationId
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
    useChatStore.getState().setClaudeConversationId(second, "conv-two");
    useChatStore.getState().focusSession(first);

    render(<ChatWindowManager />);

    await user.click(screen.getByLabelText("Toggle chat history"));
    const drawer = within(screen.getByTestId("local-chat-history-drawer"));
    expect(drawer.getByText("Task One")).toBeInTheDocument();
    expect(drawer.getByText("first saved question")).toBeInTheDocument();
    expect(drawer.getByText("Task Two")).toBeInTheDocument();
    expect(drawer.getByText("second saved answer")).toBeInTheDocument();

    await user.click(screen.getByLabelText("Open local chat Task Two"));
    expect(useChatStore.getState().activeSessionId).toBe(second);
    expect(useChatStore.getState().sessions[second].claudeConversationId).toBe(
      "conv-two"
    );

    await user.click(screen.getByLabelText("Toggle chat history"));
    await user.click(screen.getByLabelText("Delete local chat Task One"));
    expect(loadPersistedLocalChatSession(first)).toBeNull();
    expect(loadPersistedLocalChatSession(second)?.id).toBe(second);

    const beforeFresh = Object.keys(useChatStore.getState().sessions);
    await user.click(
      screen.getByLabelText("Start fresh local chat from history")
    );
    const afterFresh = Object.keys(useChatStore.getState().sessions);
    expect(afterFresh).toHaveLength(beforeFresh.length + 1);
    expect(useChatStore.getState().activeSessionId).not.toBe(second);
    expect(commands.createClaudeSession).not.toHaveBeenCalled();
    expect(commands.sendClaudeMessage).not.toHaveBeenCalled();
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

    await user.click(screen.getByLabelText("Toggle chat history"));
    await user.click(
      screen.getByLabelText("Start fresh local chat from history")
    );

    await waitFor(() => {
      expect(useChatStore.getState().activeSessionId).not.toBe(stale);
    });
    const fresh = useChatStore.getState().activeSessionId;
    expect(fresh).not.toBeNull();
    expect(useChatStore.getState().sessions[fresh!]).toMatchObject({
      label: "New Chat",
      projectPath: "/new/project",
      claudeConversationId: null,
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
      kind: "assistant",
      text: "new project answer",
      timestamp: "2026-01-02T00:00:00Z",
    });
    const currentOlder = useChatStore
      .getState()
      .startFreshSession("Older Current Project Chat", "/new/project");
    useChatStore.getState().addMessage(currentOlder, {
      kind: "assistant",
      text: "older current project answer",
      timestamp: "2026-01-01T12:00:00Z",
    });
    const legacy = useChatStore
      .getState()
      .startFreshSession("Legacy Chat", null);
    useChatStore.getState().addMessage(legacy, {
      kind: "assistant",
      text: "legacy answer",
      timestamp: "2026-01-03T00:00:00Z",
    });
    useChatStore.getState().focusSession(stale);

    render(<ChatWindowManager />);
    await waitFor(() => {
      expect(commands.getCurrentProjectPath).toHaveBeenCalled();
    });

    await user.click(screen.getByLabelText("Toggle chat history"));
    const drawer = within(screen.getByTestId("local-chat-history-drawer"));
    await waitFor(() => {
      expect(drawer.getAllByRole("heading", { level: 3 })).toHaveLength(3);
    });
    expect(
      drawer
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent)
    ).toEqual(["new-project", "old-project", "Unknown project"]);

    const currentGroup = within(
      drawer.getByRole("region", { name: "new-project chats" })
    );
    expect(
      currentGroup
        .getAllByRole("button", { name: /^Open local chat/ })
        .map((button) => button.getAttribute("aria-label"))
    ).toEqual([
      "Open local chat Current Project Chat",
      "Open local chat Older Current Project Chat",
    ]);

    expect(drawer.getByText("Current Project Chat")).toBeInTheDocument();
    expect(drawer.getByText("new project answer")).toBeInTheDocument();
    expect(drawer.getByText("Old Project Chat")).toBeInTheDocument();
    expect(drawer.getByText("old project answer")).toBeInTheDocument();
    expect(drawer.getByText("Legacy Chat")).toBeInTheDocument();
    expect(drawer.getByText("legacy answer")).toBeInTheDocument();
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

      await user.click(screen.getByLabelText("Toggle chat history"));
      const drawer = within(screen.getByTestId("local-chat-history-drawer"));

      expect(
        await drawer.findByText(
          "Could not load saved projects. Showing current project chats only."
        )
      ).toBeInTheDocument();
      expect(drawer.getByText("Current Project Chat")).toBeInTheDocument();
      expect(drawer.getByText("new project answer")).toBeInTheDocument();
      expect(drawer.queryByText("Old Project Chat")).not.toBeInTheDocument();
      expect(drawer.queryByText("old project answer")).not.toBeInTheDocument();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("shows a mini thread selector while maximized and keeps the main chat visible", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1200,
    });
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
    useChatStore.getState().focusSession(first);

    render(<ChatWindowManager />);

    fireEvent.keyDown(window, { key: "\\", metaKey: true });

    expect(screen.getByTestId("local-chat-mini-panel")).toBeInTheDocument();
    expect(screen.queryByLabelText("Toggle chat history")).toBeNull();
    expect(
      screen.queryByTestId("local-chat-history-drawer")
    ).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getAllByText("first saved question")).toHaveLength(2);
    });

    await user.click(screen.getByLabelText("Open local chat Task Two"));

    expect(useChatStore.getState().activeSessionId).toBe(second);
    expect(screen.getAllByText("second saved answer")).toHaveLength(2);
    expect(screen.getByTestId("local-chat-mini-panel")).toBeInTheDocument();
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
      kind: "assistant",
      text: "older current answer",
      timestamp: "2026-01-01T00:00:00Z",
    });
    const currentNewer = useChatStore
      .getState()
      .startFreshSession("Current Newer Chat", "/new/project");
    useChatStore.getState().addMessage(currentNewer, {
      kind: "assistant",
      text: "newer current answer",
      timestamp: "2026-01-02T00:00:00Z",
    });
    const legacy = useChatStore
      .getState()
      .startFreshSession("Legacy Chat", null);
    useChatStore.getState().addMessage(legacy, {
      kind: "assistant",
      text: "legacy answer",
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
        .getAllByRole("button", { name: /^Open local chat/ })
        .map((button) => button.getAttribute("aria-label"))
    ).toEqual([
      "Open local chat Current Newer Chat",
      "Open local chat Current Older Chat",
    ]);
    expect(miniPanel.getByText("Old Project Chat")).toBeInTheDocument();
    expect(miniPanel.getByText("Legacy Chat")).toBeInTheDocument();
  });

  it("shows the chat model in the maximized mini thread selector", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1200,
    });
    const first = useChatStore
      .getState()
      .openSession("Task One", "/test/project");
    useChatStore.getState().setSessionModel(first, "claude-sonnet-4.5");
    useChatStore.getState().addMessage(first, {
      kind: "user",
      text: "first saved question",
      timestamp: "2026-01-01T00:00:00Z",
    });
    const second = useChatStore
      .getState()
      .startFreshSession("Project Chat", "/test/project");
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
      expect(miniPanel.getByText("sonnet-4.5")).toBeInTheDocument();
    });
    expect(miniPanel.getByText("Chat")).toBeInTheDocument();
    expect(miniPanel.queryByText(/Jan/)).not.toBeInTheDocument();
  });

  it("closes a live Claude session before deleting it from history", async () => {
    const user = userEvent.setup();
    const id = useChatStore
      .getState()
      .openSession("Live Task", "/test/project");
    useChatStore.getState().setClaudeSessionId(id, "live-backend-session");

    render(<ChatWindowManager />);

    await user.click(screen.getByLabelText("Toggle chat history"));
    await user.click(
      await screen.findByLabelText("Delete local chat Live Task")
    );

    expect(commands.closeClaudeSession).toHaveBeenCalledWith(
      "live-backend-session"
    );
    expect(loadPersistedLocalChatSession(id)).toBeNull();
    expect(useChatStore.getState().sessions[id]).toBeUndefined();
  });

  it("keeps the local session and shows feedback when close fails during history delete", async () => {
    vi.mocked(commands.closeClaudeSession).mockResolvedValueOnce({
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
    useChatStore.getState().setClaudeSessionId(id, "live-backend-session");

    render(<ChatWindowManager />);

    await user.click(screen.getByLabelText("Toggle chat history"));
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
  });

  // --- Detach / reattach ---

  it("does not render a detach button (detach removed from the chat panel)", () => {
    const s1 = createSession({ id: "s1", label: "Task A" });
    useChatStore.setState({
      sessions: { s1 },
      activeSessionId: "s1",
      panelOpen: true,
    });

    render(<ChatWindowManager />);

    expect(
      screen.queryByTitle("Detach into pop-out window")
    ).not.toBeInTheDocument();
  });

  it("renders the detached placeholder (not the chat history) when active session is detached", () => {
    const s1 = createSession({
      id: "s1",
      label: "Task A",
      isDetached: true,
      messages: [
        {
          kind: "user",
          text: "should-not-render",
          timestamp: "2025-01-01T00:00:00Z",
        },
      ],
    });
    useChatStore.setState({
      sessions: { s1 },
      activeSessionId: "s1",
      panelOpen: true,
    });

    render(<ChatWindowManager />);

    expect(screen.queryByText("should-not-render")).not.toBeInTheDocument();
    expect(
      screen.getByRole("status", { name: "Session detached" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reattach to panel" })
    ).toBeInTheDocument();
  });

  it("clicking reattach in the placeholder clears isDetached", async () => {
    const user = userEvent.setup();
    const s1 = createSession({
      id: "s1",
      label: "Task A",
      isDetached: true,
    });
    useChatStore.setState({
      sessions: { s1 },
      activeSessionId: "s1",
      panelOpen: true,
    });

    render(<ChatWindowManager />);

    await user.click(screen.getByRole("button", { name: "Reattach to panel" }));

    expect(useChatStore.getState().sessions["s1"].isDetached).toBe(false);
  });
});

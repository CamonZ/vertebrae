import { describe, expect, it, beforeEach, vi } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FloatingChatLauncher } from "./FloatingChatLauncher";
import { useChatStore, type ChatSession } from "../../stores/chatStore";
import {
  clearPersistedLocalChatSessions,
  loadPersistedLocalChatSession,
} from "../../utils/localChatPersistence";

const mockGetCurrentProjectPath = vi.fn();
const mockGetMainChatWorktree = vi.fn();

vi.mock("../../bindings", () => ({
  commands: {
    getMainChatWorktree: (path: string) => mockGetMainChatWorktree(path),
    getCurrentProjectPath: (...args: unknown[]) =>
      mockGetCurrentProjectPath(...args),
  },
}));

describe("FloatingChatLauncher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMainChatWorktree.mockResolvedValue(null);
    mockGetCurrentProjectPath.mockResolvedValue({
      status: "ok",
      data: "/test/project",
    });
    window.localStorage.clear();
    clearPersistedLocalChatSessions();
    useChatStore.getState().reset();
  });

  it("renders the launcher pill with an Alt-Alt keyboard hint (no text label)", () => {
    render(<FloatingChatLauncher />);

    const button = screen.getByRole("button", { name: "Open project chat" });
    expect(button).toBeInTheDocument();
    expect(button).toHaveClass("hc-launch");
    expect(button).not.toHaveTextContent("Ask sacrum");
    // Two ⌥ chips hint the double-tap shortcut.
    const keys = button.querySelectorAll("kbd.key");
    expect(keys).toHaveLength(2);
    expect(keys[0]).toHaveTextContent("⌥");
  });

  it("opens the local project chat when clicked", async () => {
    const user = userEvent.setup();
    render(<FloatingChatLauncher />);

    await user.click(screen.getByRole("button", { name: "Open project chat" }));

    await waitFor(() => expect(useChatStore.getState().panelOpen).toBe(true));
    const session = Object.values(useChatStore.getState().sessions).find(
      (s) => s.label === "New Chat"
    );
    expect(session).toBeDefined();
    expect(session?.label).toBe("New Chat");
    expect(session?.projectPath).toBe("/test/project");
  });

  it("creates and saves a main worktree association before the first message", async () => {
    const secondary = "/test/feature";
    const primary = { path: "/test/project", branch: "trunk" };
    mockGetCurrentProjectPath.mockResolvedValueOnce({
      status: "ok",
      data: secondary,
    });
    mockGetMainChatWorktree.mockResolvedValueOnce(primary);

    render(<FloatingChatLauncher />);
    fireEvent.click(screen.getByRole("button", { name: "Open project chat" }));

    await waitFor(() =>
      expect(useChatStore.getState().activeSessionId).toBeTruthy()
    );
    const { activeSessionId, sessions } = useChatStore.getState();
    const session = sessions[activeSessionId!];
    expect(mockGetMainChatWorktree).toHaveBeenCalledWith(secondary);
    expect(session.messages).toEqual([]);
    expect(session.association).toMatchObject({
      worktreePath: primary.path,
      branch: primary.branch,
    });
    expect(loadPersistedLocalChatSession(session.id)?.association).toEqual(
      session.association
    );
  });

  it("opens the panel before the project lookup completes", async () => {
    let resolveProjectPath!: (value: { status: "ok"; data: string }) => void;
    const projectPath = new Promise<{ status: "ok"; data: string }>(
      (resolve) => {
        resolveProjectPath = resolve;
      }
    );
    mockGetCurrentProjectPath.mockReturnValueOnce(projectPath);

    render(<FloatingChatLauncher />);
    fireEvent.click(screen.getByRole("button", { name: "Open project chat" }));

    await waitFor(() => expect(useChatStore.getState().panelOpen).toBe(true));

    resolveProjectPath({ status: "ok", data: "/test/project" });
    await waitFor(() =>
      expect(
        Object.values(useChatStore.getState().sessions).some(
          (session) => session.label === "New Chat"
        )
      ).toBe(true)
    );
  });

  it("opens a fresh ephemeral chat when project history already exists", async () => {
    const user = userEvent.setup();
    const id = useChatStore
      .getState()
      .openSession("Task Chat", "/test/project");
    useChatStore.getState().addMessage(id, {
      kind: "user",
      text: "still here",
      timestamp: "2026-01-01T00:00:00Z",
    });
    useChatStore.setState({
      sessions: {},
      activeSessionId: null,
      paneLayout: { panes: [], activePaneId: null },
      localSessionSummaries: {},
      panelOpen: false,
    });

    render(<FloatingChatLauncher />);

    await user.click(screen.getByRole("button", { name: "Open project chat" }));

    await waitFor(() => {
      expect(useChatStore.getState().panelOpen).toBe(true);
      expect(useChatStore.getState().activeSessionId).not.toBe(id);
    });
    const freshId = useChatStore.getState().activeSessionId!;
    expect(
      useChatStore
        .getState()
        .listLocalSessions("/test/project")
        .some((session) => session.id === id)
    ).toBe(true);
    expect(
      useChatStore
        .getState()
        .listLocalSessions("/test/project")
        .some((session) => session.id === freshId)
    ).toBe(false);

    useChatStore.getState().addMessage(freshId, {
      kind: "user",
      text: "start this chat",
      timestamp: "2026-01-02T00:00:00Z",
    });
    expect(
      useChatStore
        .getState()
        .listLocalSessions("/test/project")
        .some((session) => session.id === freshId)
    ).toBe(true);
  });

  it("reopens the active project chat with its transcript", async () => {
    const user = userEvent.setup();
    const id = useChatStore
      .getState()
      .openSession("Task Chat", "/test/project");
    useChatStore.getState().addMessage(id, {
      kind: "user",
      text: "continue this chat",
      timestamp: "2026-01-01T00:00:00Z",
    });
    useChatStore.getState().addMessage(id, {
      kind: "assistant",
      text: "previous reply",
      timestamp: "2026-01-01T00:00:01Z",
    });
    useChatStore.getState().setPanelOpen(false);

    render(<FloatingChatLauncher />);

    await user.click(screen.getByRole("button", { name: "Open project chat" }));

    await waitFor(() => {
      expect(useChatStore.getState().activeSessionId).toBe(id);
      expect(useChatStore.getState().panelOpen).toBe(true);
    });
    expect(useChatStore.getState().sessions[id]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "assistant", text: "previous reply" }),
      ])
    );
  });

  it("does not reopen an active session from another project", async () => {
    const user = userEvent.setup();
    const otherProject = useChatStore
      .getState()
      .openSession("Other Project Chat", "/other/project");
    useChatStore.getState().setPanelOpen(false);

    render(<FloatingChatLauncher />);

    await user.click(screen.getByRole("button", { name: "Open project chat" }));

    await waitFor(() => expect(useChatStore.getState().panelOpen).toBe(true));
    expect(useChatStore.getState().activeSessionId).not.toBe(otherProject);
    const activeSession =
      useChatStore.getState().sessions[
        useChatStore.getState().activeSessionId!
      ];
    expect(activeSession).toMatchObject({
      label: "New Chat",
      projectPath: "/test/project",
    });
  });

  it("does not reopen another project when current project lookup fails", async () => {
    const user = userEvent.setup();
    mockGetCurrentProjectPath.mockResolvedValueOnce({
      status: "error",
      error: { message: "no project" },
    });
    const otherProject = useChatStore
      .getState()
      .openSession("Other Project Chat", "/other/project");
    useChatStore.getState().setPanelOpen(false);

    render(<FloatingChatLauncher />);

    await user.click(screen.getByRole("button", { name: "Open project chat" }));

    await waitFor(() => expect(useChatStore.getState().panelOpen).toBe(true));
    expect(useChatStore.getState().activeSessionId).not.toBe(otherProject);
    const activeSession =
      useChatStore.getState().sessions[
        useChatStore.getState().activeSessionId!
      ];
    expect(activeSession).toMatchObject({
      label: "New Chat",
      projectPath: null,
    });
  });

  it("reuses a no-project empty chat when current project lookup fails", async () => {
    const user = userEvent.setup();
    mockGetCurrentProjectPath.mockResolvedValueOnce({
      status: "error",
      error: { message: "no project" },
    });
    const noProject = useChatStore.getState().openSession("New Chat", null);
    useChatStore.getState().setPanelOpen(false);

    render(<FloatingChatLauncher />);

    await user.click(screen.getByRole("button", { name: "Open project chat" }));

    await waitFor(() => expect(useChatStore.getState().panelOpen).toBe(true));
    expect(useChatStore.getState().activeSessionId).toBe(noProject);
  });

  it("hides itself once the panel is open (panel owns the anchor)", () => {
    useChatStore.setState({ panelOpen: true });
    render(<FloatingChatLauncher />);

    expect(
      screen.queryByRole("button", { name: "Open project chat" })
    ).not.toBeInTheDocument();
  });

  it("double-tapping Alt opens the project chat", async () => {
    render(<FloatingChatLauncher />);

    fireEvent.keyDown(window, { key: "Alt" });
    fireEvent.keyDown(window, { key: "Alt" });

    await waitFor(() => expect(useChatStore.getState().panelOpen).toBe(true));
    expect(
      Object.values(useChatStore.getState().sessions).some(
        (s) => s.label === "New Chat"
      )
    ).toBe(true);
  });

  it("a single Alt press does not open the chat", () => {
    render(<FloatingChatLauncher />);

    fireEvent.keyDown(window, { key: "Alt" });

    expect(useChatStore.getState().panelOpen).toBe(false);
  });

  it("ignores auto-repeat: a held Alt key does not count as two taps", () => {
    render(<FloatingChatLauncher />);

    fireEvent.keyDown(window, { key: "Alt" });
    fireEvent.keyDown(window, { key: "Alt", repeat: true });

    expect(useChatStore.getState().panelOpen).toBe(false);
  });

  it("double-tapping Alt while the panel is open closes it (listener stays armed)", () => {
    useChatStore.setState({ panelOpen: true });
    render(<FloatingChatLauncher />);

    fireEvent.keyDown(window, { key: "Alt" });
    fireEvent.keyDown(window, { key: "Alt" });

    expect(useChatStore.getState().panelOpen).toBe(false);
  });

  describe("attention signals", () => {
    const chat = (
      id: string,
      extra: Partial<ChatSession> = {}
    ): ChatSession => ({
      id,
      label: id,
      messages: [
        { kind: "user", text: "Go", timestamp: "2026-11-22T10:00:00.000Z" },
      ],
      status: "open",
      harness: "claude",
      backendSessionId: null,
      providerResumeId: null,
      lifecycle: "idle",
      ...extra,
    });
    const put = (...sessions: ChatSession[]) =>
      act(() =>
        useChatStore.setState({
          sessions: Object.fromEntries(sessions.map((s) => [s.id, s])),
        })
      );

    it("glows only while a counted chat is running", () => {
      render(<FloatingChatLauncher />);
      const launcher = screen.getByTestId("local-chat-launcher");
      expect(launcher).not.toHaveAttribute("data-running");

      put(chat("a", { lifecycle: "streaming" }));
      expect(launcher).toHaveAttribute("data-running", "true");

      // Discussions do not count toward the launcher.
      put(chat("d", { lifecycle: "streaming", discussion: {} as never }));
      expect(launcher).not.toHaveAttribute("data-running");

      put(chat("a"));
      expect(launcher).not.toHaveAttribute("data-running");
    });

    it("shows the flat attention dot and count only while chats need the user", () => {
      render(<FloatingChatLauncher />);
      expect(
        screen.queryByTestId("local-chat-launcher-attention")
      ).not.toBeInTheDocument();

      put(
        chat("a", { lifecycle: "error" }),
        chat("b", { lifecycle: "streaming" })
      );
      expect(
        screen.getByRole("button", { name: "Open project chat, 1 need you" })
      ).toHaveAttribute("data-running", "true");
      expect(
        screen.getByTestId("local-chat-launcher-attention")
      ).toBeInTheDocument();
    });
  });
});

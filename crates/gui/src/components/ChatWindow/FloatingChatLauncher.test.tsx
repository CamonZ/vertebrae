import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FloatingChatLauncher } from "./FloatingChatLauncher";
import { useChatStore } from "../../stores/chatStore";
import { clearPersistedLocalChatSessions } from "../../utils/localChatPersistence";

const mockGetCurrentProjectPath = vi.fn();

vi.mock("../../bindings", () => ({
  commands: {
    getCurrentProjectPath: (...args: unknown[]) =>
      mockGetCurrentProjectPath(...args),
  },
}));

describe("FloatingChatLauncher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("prompts before reopening the existing active session", async () => {
    const user = userEvent.setup();
    const id = useChatStore
      .getState()
      .openSession("Task Chat", "/test/project");
    useChatStore.getState().addMessage(id, {
      kind: "user",
      text: "still here",
      timestamp: "2026-01-01T00:00:00Z",
    });
    useChatStore.getState().setPanelOpen(false);

    render(<FloatingChatLauncher />);

    await user.click(screen.getByRole("button", { name: "Open project chat" }));

    expect(useChatStore.getState().panelOpen).toBe(false);
    const prompt = screen.getByTestId("local-chat-resume-prompt");
    expect(prompt).toHaveTextContent("continue with the last session");
    expect(prompt).toHaveTextContent("Task Chat");

    await user.click(
      screen.getByRole("link", {
        name: "continue with the last session Task Chat",
      })
    );

    expect(useChatStore.getState().panelOpen).toBe(true);
    expect(useChatStore.getState().activeSessionId).toBe(id);
    expect(useChatStore.getState().sessions[id].messages).toEqual([
      {
        kind: "user",
        text: "still here",
        timestamp: "2026-01-01T00:00:00Z",
      },
    ]);
    expect(Object.values(useChatStore.getState().sessions)).toHaveLength(1);
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
    const noProject = useChatStore
      .getState()
      .openSession("New Chat", null);
    useChatStore.getState().setPanelOpen(false);

    render(<FloatingChatLauncher />);

    await user.click(screen.getByRole("button", { name: "Open project chat" }));

    await waitFor(() => expect(useChatStore.getState().panelOpen).toBe(true));
    expect(useChatStore.getState().activeSessionId).toBe(noProject);
  });

  it("offers a same-project locally closed session as resumable", async () => {
    const user = userEvent.setup();
    const closedId = useChatStore
      .getState()
      .openSession("Task Chat", "/test/project");
    useChatStore.getState().setProviderResumeId(closedId, "conv-closed");
    useChatStore.getState().markSessionClosed(closedId);
    useChatStore.setState({
      activeSessionId: closedId,
      panelOpen: false,
    });

    render(<FloatingChatLauncher />);

    await user.click(screen.getByRole("button", { name: "Open project chat" }));

    await waitFor(() =>
      expect(screen.getByTestId("local-chat-resume-prompt")).toBeInTheDocument()
    );
    await user.click(
      screen.getByRole("link", {
        name: "continue with the last session Task Chat",
      })
    );

    await waitFor(() => expect(useChatStore.getState().panelOpen).toBe(true));
    expect(useChatStore.getState().activeSessionId).toBe(closedId);
    expect(useChatStore.getState().sessions[closedId].lifecycle).toBe("closed");
  });

  it("offers a Codex session through the same provider-neutral resume flow", async () => {
    const user = userEvent.setup();
    const codexId = useChatStore
      .getState()
      .openSession("Codex Task", "/test/project");
    useChatStore.getState().setSessionHarness(codexId, "codex");
    useChatStore.getState().addMessage(codexId, {
      kind: "user",
      text: "continue with Codex",
      timestamp: "2026-01-01T00:00:00Z",
    });
    useChatStore.getState().setPanelOpen(false);

    render(<FloatingChatLauncher />);

    await user.click(screen.getByRole("button", { name: "Open project chat" }));

    await waitFor(() =>
      expect(screen.getByTestId("local-chat-resume-prompt")).toBeInTheDocument()
    );
    expect(screen.getByTestId("local-chat-resume-prompt")).toHaveTextContent(
      "Codex Task"
    );
    await user.click(
      screen.getByRole("link", {
        name: "continue with the last session Codex Task",
      })
    );

    await waitFor(() => expect(useChatStore.getState().panelOpen).toBe(true));
    expect(useChatStore.getState().activeSessionId).toBe(codexId);
    expect(useChatStore.getState().sessions[codexId].harness).toBe("codex");
  });

  it("keeps new chat available when continuing a session fails", async () => {
    const user = userEvent.setup();
    const resumableId = useChatStore
      .getState()
      .openSession("Unavailable Task", "/test/project");
    useChatStore.getState().addMessage(resumableId, {
      kind: "user",
      text: "this session cannot load",
      timestamp: "2026-01-01T00:00:00Z",
    });
    useChatStore.getState().setPanelOpen(false);
    const selectPersistedSession =
      useChatStore.getState().selectPersistedSession;
    useChatStore.setState({
      selectPersistedSession: vi.fn().mockResolvedValue(false),
    });

    try {
      render(<FloatingChatLauncher />);

      await user.click(
        screen.getByRole("button", { name: "Open project chat" })
      );
      await user.click(
        screen.getByRole("link", {
          name: "continue with the last session Unavailable Task",
        })
      );

      expect(screen.getByRole("alert")).toHaveTextContent(
        "You can still start a new chat"
      );
      await user.click(screen.getByRole("button", { name: "new chat" }));

      await waitFor(() => expect(useChatStore.getState().panelOpen).toBe(true));
      expect(useChatStore.getState().activeSessionId).not.toBe(resumableId);
    } finally {
      useChatStore.setState({ selectPersistedSession });
    }
  });

  it("reuses the empty session when new chat is chosen repeatedly", async () => {
    const user = userEvent.setup();
    const resumableId = useChatStore
      .getState()
      .openSession("Durable Task", "/test/project");
    useChatStore.getState().addMessage(resumableId, {
      kind: "user",
      text: "durable content",
      timestamp: "2026-01-01T00:00:00Z",
    });
    useChatStore.getState().setPanelOpen(false);

    render(<FloatingChatLauncher />);

    await user.click(screen.getByRole("button", { name: "Open project chat" }));
    await user.click(screen.getByRole("button", { name: "new chat" }));
    await waitFor(() => expect(useChatStore.getState().panelOpen).toBe(true));
    const emptyId = useChatStore.getState().activeSessionId;
    expect(emptyId).not.toBe(resumableId);

    useChatStore.getState().setPanelOpen(false);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Open project chat" })
      ).toBeInTheDocument()
    );
    await user.click(screen.getByRole("button", { name: "Open project chat" }));
    await user.click(screen.getByRole("button", { name: "new chat" }));
    await waitFor(() => expect(useChatStore.getState().panelOpen).toBe(true));

    expect(useChatStore.getState().activeSessionId).toBe(emptyId);
    expect(Object.keys(useChatStore.getState().sessions)).toHaveLength(2);
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
});

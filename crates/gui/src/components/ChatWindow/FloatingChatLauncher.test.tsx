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

  it("opens the panel and records the existing active session as resumable", async () => {
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

    await waitFor(() => {
      expect(useChatStore.getState().panelOpen).toBe(true);
      expect(useChatStore.getState().pendingLocalChatResume?.candidate.id).toBe(
        id
      );
    });
    expect(
      screen.queryByTestId("local-chat-resume-prompt")
    ).not.toBeInTheDocument();
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

    await waitFor(() => {
      expect(useChatStore.getState().panelOpen).toBe(true);
      expect(useChatStore.getState().pendingLocalChatResume?.candidate.id).toBe(
        closedId
      );
    });
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

    await waitFor(() => {
      expect(useChatStore.getState().panelOpen).toBe(true);
      expect(useChatStore.getState().pendingLocalChatResume?.candidate.id).toBe(
        codexId
      );
    });
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

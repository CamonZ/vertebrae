import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { popOutMock } = vi.hoisted(() => {
  const popOutMock =
    vi.fn<
      (
        route: string,
        label: string,
        opts?: Record<string, unknown>,
      ) => Promise<{
        window: { onCloseRequested: (h: () => void) => Promise<() => void> };
        reused: boolean;
      }>
    >();
  popOutMock.mockResolvedValue({
    window: { onCloseRequested: async () => () => {} },
    reused: false,
  });
  return { popOutMock };
});

vi.mock("../../utils/popOut", () => ({ popOut: popOutMock }));

// Synchronous project so the header's "scoped to" line renders without an async
// state update (which would otherwise log act() warnings).
vi.mock("../../hooks/useCurrentProject", () => ({
  useCurrentProject: () => ({ name: "test-project", path: "/test/project" }),
}));

import { ChatWindowManager } from "./ChatWindowManager";
import { useChatStore } from "../../stores/chatStore";
import { usePanelFocusStore } from "../../stores/panelFocusStore";
import type { ChatSession } from "../../stores/chatStore";

// Mock scrollIntoView
Element.prototype.scrollIntoView = vi.fn();

// Mock the bindings (needed by useScopedChat + useCurrentProject inside ChatWindow)
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
  },
}));

function createSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: `session-${Date.now()}-${Math.random()}`,
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

describe("ChatWindowManager", () => {
  beforeEach(() => {
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
      scope: "project",
      entityId: null,
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
    const s1 = createSession({ id: "s1", label: "Task A" });

    useChatStore.setState({
      sessions: { s1 },
      activeSessionId: "s1",
      panelOpen: true,
    });

    render(<ChatWindowManager />);

    await user.click(screen.getByTitle("Close chat panel"));
    expect(useChatStore.getState().panelOpen).toBe(false);
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
    expect(
      screen.queryByTestId("chat-window-manager")
    ).not.toBeInTheDocument();
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
      screen.queryByTitle("Detach into pop-out window"),
    ).not.toBeInTheDocument();
  });

  it("renders the detached placeholder (not the chat history) when active session is detached", () => {
    const s1 = createSession({
      id: "s1",
      label: "Task A",
      isDetached: true,
      messages: [
        { kind: "user", text: "should-not-render", timestamp: "2025-01-01T00:00:00Z" },
      ],
    });
    useChatStore.setState({
      sessions: { s1 },
      activeSessionId: "s1",
      panelOpen: true,
    });

    render(<ChatWindowManager />);

    expect(screen.queryByText("should-not-render")).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Session detached" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reattach to panel" })).toBeInTheDocument();
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

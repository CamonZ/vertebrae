import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatWindowManager } from "./ChatWindowManager";
import { useChatStore } from "../../stores/chatStore";
import type { ChatSession } from "../../stores/chatStore";

// Mock scrollIntoView
Element.prototype.scrollIntoView = vi.fn();

// Mock the bindings (needed by useScopedChat inside ChatWindow)
vi.mock("../../bindings", () => ({
  commands: {
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

  it("renders tab for each session when panel is open", () => {
    const s1 = createSession({ id: "s1", label: "Task A" });
    const s2 = createSession({
      id: "s2",
      scope: "workflow",
      entityId: "wf-1",
      label: "Workflow B",
    });

    useChatStore.setState({
      sessions: { s1, s2 },
      activeSessionId: "s1",
      panelOpen: true,
    });

    render(<ChatWindowManager />);

    // Tab titles are unique (tab + breadcrumb may both show the label)
    expect(screen.getByTitle("Task: Task A")).toBeInTheDocument();
    expect(screen.getByTitle("Workflow: Workflow B")).toBeInTheDocument();
  });

  it("highlights the active tab", () => {
    const s1 = createSession({ id: "s1", label: "Task A" });
    const s2 = createSession({
      id: "s2",
      scope: "workflow",
      entityId: "wf-1",
      label: "Workflow B",
    });

    useChatStore.setState({
      sessions: { s1, s2 },
      activeSessionId: "s1",
      panelOpen: true,
    });

    render(<ChatWindowManager />);

    // The active tab (div[role=tab]) should have the selected indicator
    const tabA = screen.getByTitle("Task: Task A");
    expect(tabA.className).toContain("bg-bg-secondary");
    expect(tabA.getAttribute("aria-selected")).toBe("true");

    const tabB = screen.getByTitle("Workflow: Workflow B");
    expect(tabB.className).not.toContain("bg-bg-secondary");
    expect(tabB.getAttribute("aria-selected")).toBe("false");
  });

  it("switches active session when tab is clicked", async () => {
    const user = userEvent.setup();
    const s1 = createSession({ id: "s1", label: "Task A" });
    const s2 = createSession({
      id: "s2",
      scope: "workflow",
      entityId: "wf-1",
      label: "Workflow B",
    });

    useChatStore.setState({
      sessions: { s1, s2 },
      activeSessionId: "s1",
      panelOpen: true,
    });

    render(<ChatWindowManager />);

    await user.click(screen.getByTitle("Workflow: Workflow B"));
    expect(useChatStore.getState().activeSessionId).toBe("s2");
  });

  it("closes a session when close tab button is clicked", async () => {
    const user = userEvent.setup();
    const s1 = createSession({ id: "s1", label: "Task A" });
    const s2 = createSession({
      id: "s2",
      scope: "workflow",
      entityId: "wf-1",
      label: "Workflow B",
    });

    useChatStore.setState({
      sessions: { s1, s2 },
      activeSessionId: "s2",
      panelOpen: true,
    });

    render(<ChatWindowManager />);

    // Close tab buttons should be present
    const closeBtns = screen.getAllByTitle("Close tab");
    expect(closeBtns).toHaveLength(2);

    // Close the first tab
    await user.click(closeBtns[0]);
    expect(useChatStore.getState().sessions["s1"]).toBeUndefined();
    expect(useChatStore.getState().sessions["s2"]).toBeDefined();
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

  it("shows status dot for active claude sessions", () => {
    const s1 = createSession({
      id: "s1",
      label: "Active Chat",
      claudeSessionId: "claude-123",
    });

    useChatStore.setState({
      sessions: { s1 },
      activeSessionId: "s1",
      panelOpen: true,
    });

    render(<ChatWindowManager />);

    // The tab should contain a green dot for active session
    const tab = screen.getByTitle("Task: Active Chat");
    expect(tab.querySelector(".bg-success")).toBeInTheDocument();
  });

  it("shows closed status dot for closed sessions", () => {
    const s1 = createSession({
      id: "s1",
      label: "Closed Chat",
      status: "closed",
    });

    useChatStore.setState({
      sessions: { s1 },
      activeSessionId: "s1",
      panelOpen: true,
    });

    render(<ChatWindowManager />);

    const tab = screen.getByTitle("Task: Closed Chat");
    expect(tab.querySelector(".bg-text-muted")).toBeInTheDocument();
  });

  // --- E) Active tab indicator exclusivity ---

  it("inactive tab does not have accent bar", () => {
    const s1 = createSession({ id: "s1", label: "Task A" });
    const s2 = createSession({
      id: "s2",
      scope: "workflow",
      entityId: "wf-1",
      label: "Workflow B",
    });

    useChatStore.setState({
      sessions: { s1, s2 },
      activeSessionId: "s1",
      panelOpen: true,
    });

    render(<ChatWindowManager />);

    const activeTab = screen.getByTitle("Task: Task A");
    const inactiveTab = screen.getByTitle("Workflow: Workflow B");

    // Active tab has the accent bar
    expect(activeTab.querySelector(".bg-accent")).toBeInTheDocument();
    // Inactive tab does NOT
    expect(inactiveTab.querySelector(".bg-accent")).not.toBeInTheDocument();
  });

  // --- F) Status dot absence ---

  it("does not show status dot for open session without claude backend", () => {
    const s1 = createSession({
      id: "s1",
      label: "Idle Chat",
      status: "open",
      claudeSessionId: null,
    });

    useChatStore.setState({
      sessions: { s1 },
      activeSessionId: "s1",
      panelOpen: true,
    });

    render(<ChatWindowManager />);

    const tab = screen.getByTitle("Task: Idle Chat");
    expect(tab.querySelector(".bg-success")).not.toBeInTheDocument();
    expect(tab.querySelector(".bg-text-muted")).not.toBeInTheDocument();
  });

  // --- G) Scope icons per type ---

  it("renders correct scope icon for project", () => {
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

    const tab = screen.getByTitle("Project: Project Chat");
    // Project icon has folder path "M3 7v10..."
    const svg = tab.querySelector("svg");
    expect(svg).toBeInTheDocument();
    const path = svg!.querySelector("path");
    expect(path?.getAttribute("d")).toContain("M3 7v10");
  });

  it("renders correct scope icon for workflow", () => {
    const s1 = createSession({
      id: "s1",
      scope: "workflow",
      entityId: "wf-1",
      label: "WF Chat",
    });

    useChatStore.setState({
      sessions: { s1 },
      activeSessionId: "s1",
      panelOpen: true,
    });

    render(<ChatWindowManager />);

    const tab = screen.getByTitle("Workflow: WF Chat");
    const svg = tab.querySelector("svg");
    expect(svg).toBeInTheDocument();
    // Workflow icon has lightning bolt path "M13 10V3..."
    const path = svg!.querySelector("path");
    expect(path?.getAttribute("d")).toContain("M13 10V3");
  });

  it("renders correct scope icon for task", () => {
    const s1 = createSession({
      id: "s1",
      scope: "task",
      entityId: "t-1",
      label: "Task Chat",
    });

    useChatStore.setState({
      sessions: { s1 },
      activeSessionId: "s1",
      panelOpen: true,
    });

    render(<ChatWindowManager />);

    const tab = screen.getByTitle("Task: Task Chat");
    const svg = tab.querySelector("svg");
    expect(svg).toBeInTheDocument();
    // Task icon has clipboard path "M9 5H7..."
    const path = svg!.querySelector("path");
    expect(path?.getAttribute("d")).toContain("M9 5H7");
  });

  it("renders correct scope icon for step", () => {
    const s1 = createSession({
      id: "s1",
      scope: "step",
      entityId: "step-1",
      label: "Step Chat",
    });

    useChatStore.setState({
      sessions: { s1 },
      activeSessionId: "s1",
      panelOpen: true,
    });

    render(<ChatWindowManager />);

    const tab = screen.getByTitle("Step: Step Chat");
    const svg = tab.querySelector("svg");
    expect(svg).toBeInTheDocument();
    // Step icon has trend path "M13 7h8..."
    const path = svg!.querySelector("path");
    expect(path?.getAttribute("d")).toContain("M13 7h8");
  });
});

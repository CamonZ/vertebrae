import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OpenChatButton } from "./OpenChatButton";
import { useChatStore } from "../stores/chatStore";

// Mock the bindings (needed transitively through useScopedChat -> events)
vi.mock("../bindings", () => ({
  commands: {},
  events: {
    claudeSessionInitEvent: { listen: vi.fn(() => Promise.resolve(() => {})) },
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

describe("OpenChatButton", () => {
  beforeEach(() => {
    useChatStore.setState({
      sessions: {},
      activeSessionId: null,
      panelOpen: false,
    });
  });

  it("renders with Chat label", () => {
    render(
      <OpenChatButton scope="task" entityId="task-1" label="My Task" />
    );

    expect(screen.getByText("Chat")).toBeInTheDocument();
  });

  it("has correct title based on scope", () => {
    render(
      <OpenChatButton scope="workflow" entityId="wf-1" label="Pipeline" />
    );

    expect(screen.getByTitle("Open chat for this workflow")).toBeInTheDocument();
  });

  it("opens a session when clicked", async () => {
    const user = userEvent.setup();

    render(
      <OpenChatButton scope="task" entityId="task-123" label="Important Task" />
    );

    await user.click(screen.getByText("Chat"));

    const state = useChatStore.getState();
    expect(state.panelOpen).toBe(true);
    expect(state.activeSessionId).toBeTruthy();

    const session = Object.values(state.sessions)[0];
    expect(session.scope).toBe("task");
    expect(session.entityId).toBe("task-123");
    expect(session.label).toBe("Important Task");
  });

  it("reuses existing session for same scope+entity", async () => {
    const user = userEvent.setup();

    const { rerender } = render(
      <OpenChatButton scope="task" entityId="task-123" label="Task" />
    );

    await user.click(screen.getByText("Chat"));
    const firstSessionId = useChatStore.getState().activeSessionId;

    rerender(
      <OpenChatButton scope="task" entityId="task-123" label="Task" />
    );
    await user.click(screen.getByText("Chat"));

    expect(useChatStore.getState().activeSessionId).toBe(firstSessionId);
    expect(Object.keys(useChatStore.getState().sessions)).toHaveLength(1);
  });

  it("applies custom className", () => {
    render(
      <OpenChatButton
        scope="step"
        entityId="step-1"
        label="Step 1"
        className="custom-class"
      />
    );

    const button = screen.getByText("Chat").closest("button");
    expect(button?.className).toContain("custom-class");
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";

const { popOutMock, onCloseRequestedMock, mockWebview } = vi.hoisted(() => {
  const onCloseRequestedMock =
    vi.fn<(handler: () => void | Promise<void>) => Promise<() => void>>();
  onCloseRequestedMock.mockImplementation(async () => () => {});
  const mockWebview = {
    onCloseRequested: onCloseRequestedMock,
  };
  const popOutMock =
    vi.fn<
      (
        route: string,
        label: string,
        opts?: Record<string, unknown>
      ) => Promise<{ window: typeof mockWebview; reused: boolean }>
    >();
  popOutMock.mockResolvedValue({ window: mockWebview, reused: false });
  return { popOutMock, onCloseRequestedMock, mockWebview };
});

vi.mock("../utils/popOut", () => ({ popOut: popOutMock }));

import { useChatStore } from "./chatStore";
import { takeStashedChatSession } from "../utils/chatStash";

describe("chatStore detach / reattach", () => {
  beforeEach(() => {
    useChatStore.setState({
      sessions: {},
      activeSessionId: null,
      panelOpen: false,
    });
    localStorage.clear();
    popOutMock.mockClear();
    onCloseRequestedMock.mockClear();
    popOutMock.mockResolvedValue({ window: mockWebview, reused: false });
  });

  it("detachSession marks the session detached and stashes it for the pop-out", async () => {
    const id = useChatStore.getState().openSession("task", "t-1", "Task A");
    useChatStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        [id]: { ...s.sessions[id], claudeSessionId: "claude-xyz" },
      },
    }));

    await useChatStore.getState().detachSession(id);

    expect(useChatStore.getState().sessions[id].isDetached).toBe(true);

    // Pop-out invoked with chat-{id} label and the sessionId in the URL
    expect(popOutMock).toHaveBeenCalledTimes(1);
    const [route, label, opts] = popOutMock.mock.calls[0];
    expect(label).toBe(`chat-${id}`);
    expect(route).toContain(`sessionId=${encodeURIComponent(id)}`);
    expect(opts).toMatchObject({ title: "Task: Task A" });

    // Stashed session preserves the existing claudeSessionId so the pop-out
    // does not double-create the backend Claude session.
    const stashed = takeStashedChatSession(id);
    expect(stashed).not.toBeNull();
    expect(stashed!.claudeSessionId).toBe("claude-xyz");
    expect(stashed!.isDetached).toBe(true);
  });

  it("detachSession registers onCloseRequested to reattach when the pop-out closes", async () => {
    const id = useChatStore.getState().openSession("task", "t-1", "Task A");
    await useChatStore.getState().detachSession(id);

    expect(onCloseRequestedMock).toHaveBeenCalledTimes(1);

    // Simulate the pop-out window closing
    const closeHandler = onCloseRequestedMock.mock.calls[0][0];
    await closeHandler();

    expect(useChatStore.getState().sessions[id].isDetached).toBe(false);
    expect(useChatStore.getState().activeSessionId).toBe(id);
    expect(useChatStore.getState().panelOpen).toBe(true);
  });

  it("detachSession is a no-op when the session is already detached", async () => {
    const id = useChatStore.getState().openSession("task", "t-1", "Task A");
    await useChatStore.getState().detachSession(id);
    popOutMock.mockClear();
    onCloseRequestedMock.mockClear();

    await useChatStore.getState().detachSession(id);

    expect(popOutMock).not.toHaveBeenCalled();
  });

  it("detachSession switches activeSessionId to a remaining attached tab", async () => {
    const id1 = useChatStore.getState().openSession("task", "t-1", "Task A");
    const id2 = useChatStore.getState().openSession("task", "t-2", "Task B");
    useChatStore.setState({ activeSessionId: id2 });

    await useChatStore.getState().detachSession(id2);

    expect(useChatStore.getState().activeSessionId).toBe(id1);
  });

  it("reattachSession clears isDetached and re-focuses the tab", () => {
    const id = useChatStore.getState().openSession("task", "t-1", "Task A");
    useChatStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        [id]: { ...s.sessions[id], isDetached: true },
      },
      activeSessionId: null,
      panelOpen: false,
    }));

    useChatStore.getState().reattachSession(id);

    expect(useChatStore.getState().sessions[id].isDetached).toBe(false);
    expect(useChatStore.getState().activeSessionId).toBe(id);
    expect(useChatStore.getState().panelOpen).toBe(true);
  });

  it("does not register a second close listener when popOut reuses an existing window", async () => {
    popOutMock.mockResolvedValueOnce({ window: mockWebview, reused: true });
    const id = useChatStore.getState().openSession("task", "t-1", "Task A");

    await useChatStore.getState().detachSession(id);

    expect(onCloseRequestedMock).not.toHaveBeenCalled();
  });
});

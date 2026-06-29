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
import {
  isLocalChatSessionCleared,
  loadPersistedLocalChatSession,
  markLocalChatSessionCleared,
} from "../utils/localChatPersistence";

describe("chatStore detach / reattach", () => {
  beforeEach(() => {
    useChatStore.setState({
      sessions: {},
      activeSessionId: null,
      paneLayout: { panes: [], activePaneId: null },
      panelOpen: false,
    });
    localStorage.clear();
    popOutMock.mockClear();
    onCloseRequestedMock.mockClear();
    popOutMock.mockResolvedValue({ window: mockWebview, reused: false });
  });

  it("detachSession marks the session detached and stashes it for the pop-out", async () => {
    const id = useChatStore.getState().openSession("Task A");
    useChatStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        [id]: {
          ...s.sessions[id],
          backendSessionId: "claude-xyz",
          lifecycle: "streaming",
          streamingAssistant: {
            text: "partial",
            timestamp: "2026-01-01T00:00:00Z",
          },
        },
      },
    }));

    await useChatStore.getState().detachSession(id);

    expect(useChatStore.getState().sessions[id].isDetached).toBe(true);

    // Pop-out invoked with chat-{id} label and the sessionId in the URL
    expect(popOutMock).toHaveBeenCalledTimes(1);
    const [route, label, opts] = popOutMock.mock.calls[0];
    expect(label).toBe(`chat-${id}`);
    expect(route).toContain(`sessionId=${encodeURIComponent(id)}`);
    expect(opts).toMatchObject({ title: "Task A" });

    // Stashed session preserves the existing backendSessionId so the pop-out
    // does not double-create the backend Claude session.
    const stashed = takeStashedChatSession(id);
    expect(stashed).not.toBeNull();
    expect(stashed!.backendSessionId).toBe("claude-xyz");
    expect(stashed!.isDetached).toBe(true);
    expect(stashed!.streamingAssistant).toMatchObject({ text: "partial" });
    expect(stashed!.lifecycle).toBe("streaming");
  });

  it("detachSession registers onCloseRequested to reattach when the pop-out closes", async () => {
    const id = useChatStore.getState().openSession("Task A");
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
    const id = useChatStore.getState().openSession("Task A");
    await useChatStore.getState().detachSession(id);
    popOutMock.mockClear();
    onCloseRequestedMock.mockClear();

    await useChatStore.getState().detachSession(id);

    expect(popOutMock).not.toHaveBeenCalled();
  });

  it("detachSession switches activeSessionId to a remaining attached tab", async () => {
    const id1 = useChatStore.getState().openSession("Task A");
    const id2 = useChatStore.getState().startFreshSession("Task B");
    useChatStore.setState({ activeSessionId: id2 });

    await useChatStore.getState().detachSession(id2);

    expect(useChatStore.getState().activeSessionId).toBe(id1);
  });

  it("detachSession removes the session from split pane layout", async () => {
    const id1 = useChatStore.getState().openSession("Task A");
    const id2 = useChatStore.getState().startFreshSessionInNewPane("Task B");
    const before = useChatStore.getState().paneLayout;
    expect(before.panes.map((pane) => pane.sessionId)).toEqual([id1, id2]);

    await useChatStore.getState().detachSession(id2);

    const state = useChatStore.getState();
    expect(state.sessions[id2].isDetached).toBe(true);
    expect(state.activeSessionId).toBe(id1);
    expect(state.paneLayout.panes).toEqual([
      expect.objectContaining({ sessionId: id1 }),
    ]);
    expect(state.paneLayout.activePaneId).toBe(state.paneLayout.panes[0].id);
  });

  it("reattachSession clears isDetached and re-focuses the tab", () => {
    const id = useChatStore.getState().openSession("Task A");
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

  it("reattachSession adds a detached session without evicting visible split panes", () => {
    const first = useChatStore.getState().openSession("Task A");
    const second = useChatStore.getState().startFreshSessionInNewPane("Task B");
    const detached = "detached-task";
    useChatStore.getState().focusSession(first);
    useChatStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        [detached]: {
          id: detached,
          label: "Task C",
          messages: [],
          status: "open",
          harness: "claude",
          backendSessionId: null,
          providerResumeId: null,
          isDetached: true,
        },
      },
      activeSessionId: first,
    }));

    useChatStore.getState().reattachSession(detached);

    const state = useChatStore.getState();
    expect(state.sessions[detached].isDetached).toBe(false);
    expect(state.paneLayout.panes.map((pane) => pane.sessionId)).toEqual([
      first,
      second,
      detached,
    ]);
    expect(state.activeSessionId).toBe(detached);
  });

  it("reattachSession does not resurrect a detached session cleared elsewhere", () => {
    const id = useChatStore.getState().openSession("Task A");
    useChatStore.getState().addMessage(id, {
      kind: "user",
      text: "stale parent message",
      timestamp: "2026-01-01T00:00:00Z",
    });
    useChatStore.getState().setProviderResumeId(id, "conv-stale");
    useChatStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        [id]: { ...s.sessions[id], isDetached: true },
      },
      activeSessionId: id,
      panelOpen: false,
    }));

    markLocalChatSessionCleared(id);
    useChatStore.getState().reattachSession(id);

    expect(useChatStore.getState().sessions[id]).toBeUndefined();
    expect(useChatStore.getState().activeSessionId).toBeNull();
    expect(loadPersistedLocalChatSession(id)).toBeNull();
    expect(isLocalChatSessionCleared(id)).toBe(false);
  });

  it("does not register a second close listener when popOut reuses an existing window", async () => {
    popOutMock.mockResolvedValueOnce({ window: mockWebview, reused: true });
    const id = useChatStore.getState().openSession("Task A");

    await useChatStore.getState().detachSession(id);

    expect(onCloseRequestedMock).not.toHaveBeenCalled();
  });
});

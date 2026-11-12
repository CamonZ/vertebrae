import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_CHAT_PANES, isRunPane, useChatStore } from "./chatStore";
import { clearPersistedLocalChatSessions } from "../utils/localChatPersistence";
import { commands } from "../bindings";

const run = { taskId: "task-1", runId: "run-1" };

function layout() {
  return useChatStore.getState().paneLayout;
}

describe("chatStore run panes", () => {
  beforeEach(() => {
    vi.spyOn(commands, "discoverLocalChatChildSessions").mockResolvedValue({
      status: "ok",
      data: [],
    });
    localStorage.clear();
    clearPersistedLocalChatSessions();
    useChatStore.setState({
      sessions: {},
      activeSessionId: null,
      paneLayout: { panes: [], activePaneId: null },
      panelOpen: false,
      localSessionSummaries: {},
      spawnOutlineRevisions: {},
      spawnOutlineSignatures: {},
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("opens a run pane without creating a session and opens the panel", () => {
    const paneId = useChatStore.getState().openRunPane(run);

    const state = useChatStore.getState();
    expect(state.sessions).toEqual({});
    expect(state.localSessionSummaries).toEqual({});
    expect(state.panelOpen).toBe(true);
    expect(state.paneLayout.activePaneId).toBe(paneId);
    expect(state.paneLayout.panes).toEqual([
      {
        id: paneId,
        kind: "run",
        taskId: "task-1",
        runId: "run-1",
        focusThreadId: null,
        scrollRequest: null,
      },
    ]);
  });

  it("replaces the active local pane but keeps the last local session active", () => {
    const sessionId = useChatStore.getState().openSession("Chat", "/repo");
    const paneId = layout().activePaneId;

    const runPaneId = useChatStore.getState().openRunPane(run);

    expect(runPaneId).toBe(paneId);
    expect(layout().panes).toHaveLength(1);
    expect(isRunPane(layout().panes[0])).toBe(true);
    expect(useChatStore.getState().activeSessionId).toBe(sessionId);
  });

  it("preserves the compact session as a pane when splitting a run beside it", () => {
    const sessionId = useChatStore.getState().openSession("Chat", "/repo");
    useChatStore.setState({ paneLayout: { panes: [], activePaneId: null } });

    useChatStore.getState().openRunPane(run, { split: true });

    expect(layout().panes.map((pane) => pane.sessionId ?? pane.kind)).toEqual([
      sessionId,
      "run",
    ]);
  });

  it("focuses an already visible run pane and renews its scroll request", () => {
    const first = useChatStore.getState().openRunPane(run);
    useChatStore.getState().openSession("Chat", "/repo");
    useChatStore.getState().openRunPane(run, { split: true });

    const again = useChatStore
      .getState()
      .openRunPane(run, { scrollToThreadId: "exec-2" });
    const nonce = layout().panes.find(isRunPane)?.scrollRequest?.nonce;
    useChatStore.getState().openRunPane(run, { scrollToThreadId: "exec-2" });

    const pane = layout().panes.find(isRunPane);
    expect(again).toBe(pane?.id);
    expect(layout().panes.filter(isRunPane)).toHaveLength(1);
    expect(pane?.scrollRequest?.threadId).toBe("exec-2");
    expect(pane?.scrollRequest?.nonce).not.toBe(nonce);
    expect(first).toBeTruthy();
  });

  it("opens a subagent of the same run as a separate split pane", () => {
    useChatStore.getState().openRunPane(run);
    useChatStore
      .getState()
      .openRunPane({ ...run, focusThreadId: "sub-1" }, { split: true });

    expect(
      layout()
        .panes.filter(isRunPane)
        .map((pane) => pane.focusThreadId)
    ).toEqual([null, "sub-1"]);
  });

  it("replaces the active pane when split would exceed the pane limit", () => {
    for (let i = 0; i < MAX_CHAT_PANES; i++)
      useChatStore
        .getState()
        .openRunPane({ taskId: "t", runId: `r-${i}` }, { split: true });

    useChatStore.getState().openRunPane(run, { split: true });

    expect(layout().panes).toHaveLength(MAX_CHAT_PANES);
    expect(
      layout().panes.some((pane) => isRunPane(pane) && pane.runId === "run-1")
    ).toBe(true);
  });

  it("keeps run panes when the last local session closes", () => {
    const sessionId = useChatStore.getState().openSession("Chat", "/repo");
    useChatStore.getState().openRunPane(run, { split: true });

    useChatStore.getState().closeSession(sessionId);

    const state = useChatStore.getState();
    expect(state.panelOpen).toBe(true);
    expect(state.paneLayout.panes).toHaveLength(1);
    expect(isRunPane(state.paneLayout.panes[0])).toBe(true);
  });

  it("restores a run pane replaced by a session focus and shows the session beside it", () => {
    useChatStore.getState().openRunPane(run);
    const anchor = layout().panes.find(isRunPane)!;
    // Gate chats open through the session focus path, which replaces the
    // active pane.
    const sessionId = useChatStore.getState().openSession("Gate", "/repo");
    expect(isRunPane(layout().panes[0])).toBe(false);

    useChatStore.getState().showSessionBesideRunPane(sessionId, anchor);

    expect(layout().panes).toEqual([
      anchor,
      expect.objectContaining({ sessionId }),
    ]);
    expect(useChatStore.getState().activeSessionId).toBe(sessionId);
  });

  it("does not duplicate a session already beside the run pane", () => {
    const sessionId = useChatStore.getState().openSession("Gate", "/repo");
    useChatStore.getState().openRunPane(run, { split: true });
    const anchor = layout().panes.find(isRunPane)!;

    useChatStore.getState().showSessionBesideRunPane(sessionId, anchor);

    expect(layout().panes).toHaveLength(2);
    expect(layout().activePaneId).toBe(layout().panes[0].id);
  });

  it("focusing a run pane keeps the active local session", () => {
    const sessionId = useChatStore.getState().openSession("Chat", "/repo");
    const runPaneId = useChatStore.getState().openRunPane(run, { split: true });
    useChatStore.getState().focusPane(layout().panes[0].id);

    useChatStore.getState().focusPane(runPaneId);

    expect(layout().activePaneId).toBe(runPaneId);
    expect(useChatStore.getState().activeSessionId).toBe(sessionId);
  });
});

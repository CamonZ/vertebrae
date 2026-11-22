import { EMPTY_WORKSPACE } from "./chatWorkspace";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isRunPane, useChatStore } from "./chatStore";
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
      paneLayout: { ...EMPTY_WORKSPACE, order: [], activeId: null },
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
    expect(state.paneLayout.activeId).toBe(paneId);
    expect(state.paneLayout.order).toEqual([
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
    const paneId = layout().activeId;

    const runPaneId = useChatStore.getState().openRunPane(run);

    expect(runPaneId).toBe(paneId);
    expect(layout().order).toHaveLength(1);
    expect(isRunPane(layout().order[0])).toBe(true);
    expect(useChatStore.getState().activeSessionId).toBe(sessionId);
  });

  it("preserves the compact session as a chat when opening a run beside it", () => {
    const sessionId = useChatStore.getState().openSession("Chat", "/repo");
    useChatStore.setState({
      paneLayout: { ...EMPTY_WORKSPACE, order: [], activeId: null },
    });

    useChatStore.getState().openRunPane(run, { beside: true });

    expect(
      layout().order.map((pane) =>
        isRunPane(pane) ? pane.kind : pane.sessionId
      )
    ).toEqual([sessionId, "run"]);
  });

  it("focuses an already visible run pane and renews its scroll request", () => {
    const first = useChatStore.getState().openRunPane(run);
    useChatStore.getState().openSession("Chat", "/repo");
    useChatStore.getState().openRunPane(run, { beside: true });

    const again = useChatStore
      .getState()
      .openRunPane(run, { scrollToThreadId: "exec-2" });
    const nonce = layout().order.find(isRunPane)?.scrollRequest?.nonce;
    useChatStore.getState().openRunPane(run, { scrollToThreadId: "exec-2" });

    const pane = layout().order.find(isRunPane);
    expect(again).toBe(pane?.id);
    expect(layout().order.filter(isRunPane)).toHaveLength(1);
    expect(pane?.scrollRequest?.threadId).toBe("exec-2");
    expect(pane?.scrollRequest?.nonce).not.toBe(nonce);
    expect(first).toBeTruthy();
  });

  it("opens a subagent of the same run as a separate chat", () => {
    useChatStore.getState().openRunPane(run);
    useChatStore
      .getState()
      .openRunPane({ ...run, focusThreadId: "sub-1" }, { beside: true });

    expect(
      layout()
        .order.filter(isRunPane)
        .map((pane) => pane.focusThreadId)
    ).toEqual([null, "sub-1"]);
  });

  it("opens a run beside as a new tab however many are open", () => {
    for (let i = 0; i < 20; i++)
      useChatStore
        .getState()
        .openRunPane({ taskId: "t", runId: `r-${i}` }, { beside: true });
    const before = layout().order;

    useChatStore.getState().openRunPane(run, { beside: true });

    expect(layout().order).toHaveLength(21);
    expect(layout().order.filter((pane) => before.includes(pane))).toEqual(
      before
    );
    expect(
      layout().order.some((pane) => isRunPane(pane) && pane.runId === "run-1")
    ).toBe(true);
  });

  it("keeps run panes when the last local session closes", () => {
    const sessionId = useChatStore.getState().openSession("Chat", "/repo");
    useChatStore.getState().openRunPane(run, { beside: true });

    useChatStore.getState().closeSession(sessionId);

    const state = useChatStore.getState();
    expect(state.panelOpen).toBe(true);
    expect(state.paneLayout.order).toHaveLength(1);
    expect(isRunPane(state.paneLayout.order[0])).toBe(true);
  });

  it("restores a run pane replaced by a session focus and shows the session beside it", () => {
    useChatStore.getState().openRunPane(run);
    const anchor = layout().order.find(isRunPane)!;
    // Gate chats open through the session focus path, which replaces the
    // active pane.
    const sessionId = useChatStore.getState().openSession("Gate", "/repo");
    expect(isRunPane(layout().order[0])).toBe(false);

    useChatStore.getState().showSessionBesideRunPane(sessionId, anchor);

    expect(layout().order).toEqual([
      anchor,
      expect.objectContaining({ sessionId }),
    ]);
    expect(useChatStore.getState().activeSessionId).toBe(sessionId);
  });

  it("does not duplicate a session already beside the run pane", () => {
    const sessionId = useChatStore.getState().openSession("Gate", "/repo");
    useChatStore.getState().openRunPane(run, { beside: true });
    const anchor = layout().order.find(isRunPane)!;

    useChatStore.getState().showSessionBesideRunPane(sessionId, anchor);

    expect(layout().order).toHaveLength(2);
    expect(layout().activeId).toBe(layout().order[0].id);
  });

  it("focusing a run pane keeps the active local session", () => {
    const sessionId = useChatStore.getState().openSession("Chat", "/repo");
    const runPaneId = useChatStore
      .getState()
      .openRunPane(run, { beside: true });
    useChatStore.getState().focusPane(layout().order[0].id);

    useChatStore.getState().focusPane(runPaneId);

    expect(layout().activeId).toBe(runPaneId);
    expect(useChatStore.getState().activeSessionId).toBe(sessionId);
  });
});

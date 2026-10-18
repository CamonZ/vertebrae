import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StepExecution, TaskRun } from "../bindings";
import { commands } from "../bindings";
import { useChatStore } from "../stores/chatStore";
import { GATE_CHAT_KICKOFF } from "../utils/gateChat";
import type { HumanInputGateContext } from "../utils/humanInputGate";
import { clearPersistedLocalChatSessions } from "../utils/localChatPersistence";
import { refreshGateChat, resolveGateInChat } from "./useGateChat";
import {
  currentActiveTurnLocalId,
  currentBackendSessionId,
  doStartSession,
} from "./useLocalChat";

vi.mock("../bindings", () => ({
  commands: {
    getCurrentProjectPath: vi.fn().mockResolvedValue({
      status: "ok",
      data: "/test/project",
    }),
    createLocalChatSession: vi.fn().mockResolvedValue({ status: "ok" }),
    refreshLocalChatSessionGate: vi
      .fn()
      .mockResolvedValue({ status: "ok", data: true }),
    inferLocalChatSessionTitle: vi.fn().mockResolvedValue({
      status: "error",
      error: "unused",
    }),
  },
  events: {},
}));

const mockedCommands = vi.mocked(commands);

function context(
  overrides: Partial<HumanInputGateContext> = {}
): HumanInputGateContext {
  return {
    run: { id: "run-1" } as TaskRun,
    execution: { id: "exec-1" } as StepExecution,
    stepName: "approve",
    prompt: "Ship v2?",
    outputSchema: null,
    artifact: "approval",
    ...overrides,
  };
}

describe("resolveGateInChat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    clearPersistedLocalChatSessions();
    useChatStore.setState({
      sessions: {},
      activeSessionId: null,
      paneLayout: { panes: [], activePaneId: null },
      panelOpen: false,
      localSessionSummaries: {},
    });
  });

  it("starts a gate chat whose hidden opening turn lets the agent speak first", async () => {
    const sessionId = await resolveGateInChat(context());

    expect(sessionId).toBeTruthy();
    expect(mockedCommands.createLocalChatSession).toHaveBeenCalledTimes(1);
    expect(mockedCommands.createLocalChatSession).toHaveBeenCalledWith(
      expect.objectContaining({
        working_dir: "/test/project",
        initial_prompt: GATE_CHAT_KICKOFF,
        gate: {
          task_run_id: "run-1",
          step_name: "approve",
          execution_id: "exec-1",
          artifact: "approval",
          instructions: "Ship v2?",
          output_schema: null,
        },
      })
    );
    const session = useChatStore.getState().sessions[sessionId!];
    expect(session.messages.some((message) => message.kind === "user")).toBe(
      false
    );
    expect(session.lifecycle).toBe("streaming");
    expect(useChatStore.getState().activeSessionId).toBe(sessionId);
  });

  it("reopens the running chat without refreshing an unchanged gate", async () => {
    const first = await resolveGateInChat(context());
    const again = await resolveGateInChat(context());

    expect(again).toBe(first);
    expect(mockedCommands.createLocalChatSession).toHaveBeenCalledTimes(1);
    expect(mockedCommands.refreshLocalChatSessionGate).not.toHaveBeenCalled();
  });

  it("refreshes a live chat when the waiting execution changes", async () => {
    const first = await resolveGateInChat(context());
    const session = useChatStore.getState().sessions[first!];
    useChatStore.getState().setSessionLifecycle(first!, "idle");
    const again = await resolveGateInChat(
      context({
        execution: { id: "exec-2" } as StepExecution,
        prompt: "Ship v3?",
      })
    );

    expect(again).toBe(first);
    expect(mockedCommands.createLocalChatSession).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(mockedCommands.refreshLocalChatSessionGate).toHaveBeenCalledWith(
        session.backendSessionId,
        expect.objectContaining({
          execution_id: "exec-2",
          instructions: "Ship v3?",
        })
      )
    );
    expect(useChatStore.getState().sessions[first!].gate?.execution_id).toBe(
      "exec-2"
    );
  });

  it("does nothing for gates that cannot be resolved by artifact", async () => {
    expect(await resolveGateInChat(context({ artifact: null }))).toBeNull();
    expect(mockedCommands.createLocalChatSession).not.toHaveBeenCalled();
    expect(useChatStore.getState().sessions).toEqual({});
  });
});

describe("refreshGateChat", () => {
  const revised = {
    task_run_id: "run-1",
    step_name: "approve",
    execution_id: "exec-2",
    artifact: "approval",
    instructions: "Ship v2?",
    output_schema: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    clearPersistedLocalChatSessions();
    useChatStore.setState({
      sessions: {},
      activeSessionId: null,
      paneLayout: { panes: [], activePaneId: null },
      panelOpen: false,
      localSessionSummaries: {},
    });
  });

  async function liveGateChat(): Promise<string> {
    const sessionId = await resolveGateInChat(context());
    useChatStore.getState().setSessionLifecycle(sessionId!, "idle");
    return sessionId!;
  }

  it("delivers the refresh as its own turn and rebinds the chat", async () => {
    const sessionId = await liveGateChat();

    await refreshGateChat(sessionId, revised);

    const session = useChatStore.getState().sessions[sessionId];
    expect(mockedCommands.refreshLocalChatSessionGate).toHaveBeenCalledTimes(1);
    expect(session.gate?.execution_id).toBe("exec-2");
    expect(session.lifecycle).toBe("streaming");
    expect(session.messages.some((message) => message.kind === "user")).toBe(
      false
    );
  });

  it("settles back to idle when the chat already had that execution", async () => {
    mockedCommands.refreshLocalChatSessionGate.mockResolvedValueOnce({
      status: "ok",
      data: false,
    });
    const sessionId = await liveGateChat();

    await refreshGateChat(sessionId, revised);

    const session = useChatStore.getState().sessions[sessionId];
    expect(session.lifecycle).toBe("idle");
    expect(session.activeTurn ?? null).toBeNull();
  });

  it("waits for a busy chat to finish its turn, and merges repeats", async () => {
    const sessionId = await resolveGateInChat(context());
    expect(useChatStore.getState().sessions[sessionId!].lifecycle).toBe(
      "streaming"
    );

    const first = refreshGateChat(sessionId!, revised);
    const repeat = refreshGateChat(sessionId!, revised);
    await Promise.resolve();
    expect(mockedCommands.refreshLocalChatSessionGate).not.toHaveBeenCalled();

    useChatStore.getState().settleActiveTurn(sessionId!);
    useChatStore.getState().setSessionLifecycle(sessionId!, "idle");
    await Promise.all([first, repeat]);

    expect(mockedCommands.refreshLocalChatSessionGate).toHaveBeenCalledTimes(1);
  });

  it("drops a refresh superseded while the chat was busy", async () => {
    const sessionId = (await resolveGateInChat(context()))!;

    const stale = refreshGateChat(sessionId, revised);
    const latest = refreshGateChat(sessionId, {
      ...revised,
      execution_id: "exec-3",
    });
    useChatStore.getState().settleActiveTurn(sessionId);
    useChatStore.getState().setSessionLifecycle(sessionId, "idle");
    await Promise.all([stale, latest]);

    expect(mockedCommands.refreshLocalChatSessionGate).toHaveBeenCalledTimes(1);
    expect(mockedCommands.refreshLocalChatSessionGate).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ execution_id: "exec-3" })
    );
  });

  it("rebinds a chat with no running session in place", async () => {
    const sessionId = await liveGateChat();
    useChatStore.getState().setBackendSessionId(sessionId, null);

    await refreshGateChat(sessionId, revised);

    expect(mockedCommands.refreshLocalChatSessionGate).not.toHaveBeenCalled();
    expect(useChatStore.getState().sessions[sessionId].gate?.execution_id).toBe(
      "exec-2"
    );
  });
});

describe("starting a gate chat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    clearPersistedLocalChatSessions();
    useChatStore.setState({
      sessions: {},
      activeSessionId: null,
      paneLayout: { panes: [], activePaneId: null },
      panelOpen: false,
      localSessionSummaries: {},
    });
  });

  async function restart(phase: "rejected" | "closed") {
    const sessionId = (await resolveGateInChat(context()))!;
    const store = useChatStore.getState();
    store.setSessionLifecycle(sessionId, "idle");
    store.setBackendSessionId(sessionId, null);
    store.setGateChatStatus(sessionId, {
      phase,
      attempt: 2,
      waitingExecutionId: phase === "rejected" ? "exec-1" : null,
    });
    mockedCommands.createLocalChatSession.mockClear();
    const session = useChatStore.getState().sessions[sessionId];
    await doStartSession(
      session,
      sessionId,
      {
        setBackendSessionId: store.setBackendSessionId,
        addMessage: store.addMessage,
        setSessionTitleCandidate: store.setSessionTitleCandidate,
        setSessionLifecycle: store.setSessionLifecycle,
        beginActiveTurn: store.beginActiveTurn,
        settleActiveTurn: store.settleActiveTurn,
        getActiveTurnLocalId: currentActiveTurnLocalId,
        getBackendSessionId: currentBackendSessionId,
      },
      "Why was it rejected?"
    );
    return mockedCommands.createLocalChatSession.mock.calls[0]?.[0];
  }

  it("binds the gate while it waits for an answer", async () => {
    expect(await restart("rejected")).toHaveProperty(
      "gate.execution_id",
      "exec-1"
    );
  });

  it("resumes unbound once the gate has closed", async () => {
    const input = await restart("closed");
    expect(input).toBeDefined();
    expect(input).not.toHaveProperty("gate");
  });
});

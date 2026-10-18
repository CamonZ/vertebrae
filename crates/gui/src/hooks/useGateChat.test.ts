import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StepExecution, TaskRun } from "../bindings";
import { commands } from "../bindings";
import { useChatStore } from "../stores/chatStore";
import { GATE_CHAT_KICKOFF } from "../utils/gateChat";
import type { HumanInputGateContext } from "../utils/humanInputGate";
import { clearPersistedLocalChatSessions } from "../utils/localChatPersistence";
import { resolveGateInChat } from "./useGateChat";

vi.mock("../bindings", () => ({
  commands: {
    getCurrentProjectPath: vi.fn().mockResolvedValue({
      status: "ok",
      data: "/test/project",
    }),
    createLocalChatSession: vi.fn().mockResolvedValue({ status: "ok" }),
    refreshLocalChatSessionGate: vi.fn().mockResolvedValue({ status: "ok" }),
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
    const again = await resolveGateInChat(
      context({
        execution: { id: "exec-2" } as StepExecution,
        prompt: "Ship v3?",
      })
    );

    expect(again).toBe(first);
    expect(mockedCommands.createLocalChatSession).toHaveBeenCalledTimes(1);
    expect(mockedCommands.refreshLocalChatSessionGate).toHaveBeenCalledWith(
      session.backendSessionId,
      expect.objectContaining({
        execution_id: "exec-2",
        instructions: "Ship v3?",
      })
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

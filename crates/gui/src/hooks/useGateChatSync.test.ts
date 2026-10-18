import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StepExecution, TaskRun, TaskRunTrace } from "../bindings";
import { commands } from "../bindings";
import { useChatStore } from "../stores/chatStore";
import { clearPersistedLocalChatSessions } from "../utils/localChatPersistence";
import { resolveGateInChat } from "./useGateChat";
import { syncGateChatsForRun, useGateChatSync } from "./useGateChatSync";

const listeners = vi.hoisted(
  () => new Map<string, (event: { payload: { task_run_id: string } }) => void>()
);

vi.mock("../bindings", () => {
  const listen =
    (name: string) =>
    (handler: (event: { payload: { task_run_id: string } }) => void) => {
      listeners.set(name, handler);
      return Promise.resolve(() => listeners.delete(name));
    };
  return {
    commands: {
      getCurrentProjectPath: vi.fn().mockResolvedValue({
        status: "ok",
        data: "/test/project",
      }),
      createLocalChatSession: vi.fn().mockResolvedValue({ status: "ok" }),
      refreshLocalChatSessionGate: vi
        .fn()
        .mockResolvedValue({ status: "ok", data: true }),
      getTaskRunTrace: vi.fn(),
      inferLocalChatSessionTitle: vi.fn().mockResolvedValue({
        status: "error",
        error: "unused",
      }),
    },
    events: {
      taskRunChangedEvent: { listen: listen("run") },
      stepExecutionChangedEvent: { listen: listen("execution") },
    },
  };
});

const mockedCommands = vi.mocked(commands);

const at = (second: number) =>
  new Date(Date.UTC(2026, 9, 18, 12, 0, second)).toISOString();

function attempt(
  id: string,
  startedAt: number,
  completedAt: number | null = null
): StepExecution {
  return {
    id,
    task_run_id: "run-1",
    step_name: "approve",
    step_type: "human_input",
    started_at: at(startedAt),
    completed_at: completedAt === null ? null : at(completedAt),
    config: {
      instructions: `Ship v2? (${id})`,
      artifact: "approval",
      output_schema: null,
    },
  } as StepExecution;
}

function trace(
  status: TaskRun["status"],
  executions: StepExecution[]
): TaskRunTrace {
  const waiting = executions.find((execution) => !execution.completed_at);
  return {
    root_task_run_id: "run-1",
    task_runs: [
      {
        id: "run-1",
        status,
        latest_step_execution_id: waiting?.id ?? null,
      } as TaskRun,
    ],
    step_executions: executions,
  };
}

const rejected = trace("waiting", [
  attempt("gate-1", 0, 5),
  {
    id: "route-1",
    task_run_id: "run-1",
    step_name: "decide",
    step_type: "route",
    started_at: at(6),
    completed_at: at(7),
  },
  attempt("gate-2", 8),
]);

async function idleGateChat(): Promise<string> {
  const sessionId = await resolveGateInChat({
    run: { id: "run-1" } as TaskRun,
    execution: { id: "gate-1" } as StepExecution,
    stepName: "approve",
    prompt: "Ship v2? (gate-1)",
    outputSchema: null,
    artifact: "approval",
  });
  useChatStore.getState().setSessionLifecycle(sessionId!, "idle");
  return sessionId!;
}

describe("syncGateChatsForRun", () => {
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

  it("records the phase and leaves a chat on its current execution alone", async () => {
    const sessionId = await idleGateChat();
    mockedCommands.getTaskRunTrace.mockResolvedValue({
      status: "ok",
      data: trace("waiting", [attempt("gate-1", 0)]),
    });

    await syncGateChatsForRun("run-1");

    expect(useChatStore.getState().sessions[sessionId].gateStatus).toEqual({
      phase: "drafting",
      attempt: 1,
      waitingExecutionId: "gate-1",
    });
    expect(mockedCommands.refreshLocalChatSessionGate).not.toHaveBeenCalled();
  });

  it("injects one verdict turn on re-entry, however often the update repeats", async () => {
    const sessionId = await idleGateChat();
    const backendSessionId =
      useChatStore.getState().sessions[sessionId].backendSessionId;
    mockedCommands.getTaskRunTrace.mockResolvedValue({
      status: "ok",
      data: rejected,
    });

    await Promise.all([
      syncGateChatsForRun("run-1"),
      syncGateChatsForRun("run-1"),
    ]);
    await syncGateChatsForRun("run-1");

    expect(mockedCommands.refreshLocalChatSessionGate).toHaveBeenCalledTimes(1);
    expect(mockedCommands.refreshLocalChatSessionGate).toHaveBeenCalledWith(
      backendSessionId,
      expect.objectContaining({
        execution_id: "gate-2",
        instructions: "Ship v2? (gate-2)",
      })
    );
    const session = useChatStore.getState().sessions[sessionId];
    expect(session.gate?.execution_id).toBe("gate-2");
    expect(session.gateStatus).toMatchObject({ phase: "rejected", attempt: 2 });
  });

  it("closes the gate when the run stops, without injecting a turn", async () => {
    const sessionId = await idleGateChat();
    mockedCommands.getTaskRunTrace.mockResolvedValue({
      status: "ok",
      data: trace("stopped", [attempt("gate-1", 0)]),
    });

    await syncGateChatsForRun("run-1");

    expect(useChatStore.getState().sessions[sessionId].gateStatus).toEqual({
      phase: "closed",
      attempt: 1,
      waitingExecutionId: null,
    });
    expect(mockedCommands.refreshLocalChatSessionGate).not.toHaveBeenCalled();
  });

  it("skips runs no chat is bound to", async () => {
    await syncGateChatsForRun("run-1");

    expect(mockedCommands.getTaskRunTrace).not.toHaveBeenCalled();
  });
});

describe("useGateChatSync", () => {
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
    mockedCommands.getTaskRunTrace.mockResolvedValue({
      status: "ok",
      data: trace("waiting", [attempt("gate-1", 0)]),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("syncs a bound run once per burst of realtime updates", async () => {
    await idleGateChat();
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useGateChatSync());
    await vi.advanceTimersByTimeAsync(200);
    mockedCommands.getTaskRunTrace.mockClear();

    listeners.get("run")?.({ payload: { task_run_id: "run-1" } });
    listeners.get("execution")?.({ payload: { task_run_id: "run-1" } });
    listeners.get("run")?.({ payload: { task_run_id: "run-1" } });
    listeners.get("run")?.({ payload: { task_run_id: "run-other" } });
    await vi.advanceTimersByTimeAsync(200);

    expect(mockedCommands.getTaskRunTrace).toHaveBeenCalledTimes(1);
    expect(mockedCommands.getTaskRunTrace).toHaveBeenCalledWith("run-1");
    unmount();
  });

  it("syncs a newly bound chat without waiting for an update", async () => {
    const { unmount } = renderHook(() => useGateChatSync());

    const sessionId = await idleGateChat();
    await vi.waitFor(() =>
      expect(
        useChatStore.getState().sessions[sessionId].gateStatus?.phase
      ).toBe("drafting")
    );
    unmount();
  });
});

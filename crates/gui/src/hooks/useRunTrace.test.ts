import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor, act } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SessionLog,
  SessionLogCreatedEvent,
  SessionLogUpdatedEvent,
  StepExecution,
  TaskRunTrace,
} from "../bindings";
import {
  queryClient,
  queryKeys,
  upsertStepExecutionInQueryCache,
} from "../query";
import {
  getProjectScopeGeneration,
  resetProjectScopedStores,
} from "../stores/projectScopedStores";
import { useSessionLogStore } from "../stores/sessionLogStore";
import { useRunTrace } from "./useRunTrace";
import { useSessionLogChangeListener } from "./useSessionLogChangeListener";

const { mockGetTaskRunTrace, mockGetExecutionLogs, listeners } = vi.hoisted(
  () => ({
    mockGetTaskRunTrace: vi.fn(),
    mockGetExecutionLogs: vi.fn(),
    listeners: {} as Record<
      string,
      (event: {
        payload: SessionLogCreatedEvent | SessionLogUpdatedEvent;
      }) => void
    >,
  })
);

vi.mock("../bindings", () => ({
  commands: {
    getTaskRunTrace: (...args: unknown[]) => mockGetTaskRunTrace(...args),
    getExecutionLogs: (...args: unknown[]) => mockGetExecutionLogs(...args),
  },
  events: {
    sessionLogCreatedEvent: {
      listen: vi.fn((callback) => {
        listeners.created = callback;
        return Promise.resolve(() => {});
      }),
    },
    sessionLogUpdatedEvent: {
      listen: vi.fn((callback) => {
        listeners.updated = callback;
        return Promise.resolve(() => {});
      }),
    },
  },
}));

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client: queryClient }, children);

function execution(overrides: Partial<StepExecution> = {}): StepExecution {
  return {
    id: "exec-1",
    task_id: "task-1",
    task_run_id: "run-1",
    workflow_id: "wf-1",
    step_name: "implement",
    started_at: "2026-01-01T00:00:00.000Z",
    completed_at: null,
    status: "in_progress",
    ...overrides,
  };
}

function sessionLog(overrides: Partial<SessionLog> = {}): SessionLog {
  return {
    id: "log-1",
    step_execution_id: "exec-1",
    content: '{"type":"message"}',
    created_at: "2026-01-01T00:00:01.000Z",
    ...overrides,
  };
}

describe("useRunTrace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProjectScopedStores();
    mockGetExecutionLogs.mockResolvedValue({ status: "ok", data: [] });
  });

  it("fetches a single-run trace and seeds session logs into the session log store", async () => {
    const exec = execution();
    const log = sessionLog();
    const trace: TaskRunTrace = {
      root_task_run_id: "run-1",
      task_runs: [],
      step_executions: [exec],
      session_logs: [log],
    };
    mockGetTaskRunTrace.mockResolvedValue({ status: "ok", data: trace });

    const { result } = renderHook(() => useRunTrace("task-1", "run-1"), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(mockGetTaskRunTrace).toHaveBeenCalledWith("run-1");
    expect(result.current.stepExecutions).toEqual([exec]);
    expect(
      queryClient.getQueryData<TaskRunTrace>(
        queryKeys.executions.byRun(getProjectScopeGeneration(), "run-1")
      )?.session_logs
    ).toEqual([]);
    await waitFor(() => {
      expect(useSessionLogStore.getState().logsByExecutionId).toEqual({
        "exec-1": { logs: [log], fallbackCost: 0 },
      });
    });
    expect(result.current.logsByExecutionId).toEqual({ "exec-1": [log] });
  });

  it("updates the run trace when the server cache upserts the same run", async () => {
    const exec = execution();
    mockGetTaskRunTrace.mockResolvedValue({
      status: "ok",
      data: {
        root_task_run_id: "run-1",
        task_runs: [],
        step_executions: [exec],
        session_logs: [],
      } satisfies TaskRunTrace,
    });

    const { result } = renderHook(() => useRunTrace("task-1", "run-1"), {
      wrapper,
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      upsertStepExecutionInQueryCache(
        execution({
          id: "exec-1",
          status: "completed",
          completed_at: "2026-01-01T00:05:00.000Z",
        }),
        {
          taskId: "task-1",
          taskRunId: "run-1",
          generation: getProjectScopeGeneration(),
        }
      );
    });

    await waitFor(() => {
      expect(result.current.stepExecutions).toEqual([
        execution({
          id: "exec-1",
          status: "completed",
          completed_at: "2026-01-01T00:05:00.000Z",
        }),
      ]);
    });
  });

  it("applies log events after execution history has grown beyond the trace snapshot", async () => {
    const first = sessionLog();
    const second = sessionLog({ id: "log-2", content: "old thinking" });
    const third = sessionLog({ id: "log-3" });
    mockGetTaskRunTrace.mockResolvedValue({
      status: "ok",
      data: {
        root_task_run_id: "run-1",
        task_runs: [],
        step_executions: [execution()],
        session_logs: [first],
      } satisfies TaskRunTrace,
    });
    mockGetExecutionLogs.mockResolvedValue({
      status: "ok",
      data: [first, second, third],
    });
    const { result } = renderHook(
      () => {
        useSessionLogChangeListener();
        return useRunTrace("task-1", "run-1");
      },
      { wrapper }
    );
    await waitFor(() =>
      expect(result.current.logsByExecutionId["exec-1"]).toHaveLength(3)
    );

    const updated = { ...second, content: "new thinking" };
    const appended = sessionLog({ id: "log-4", content: "new output" });
    act(() => {
      listeners.updated({
        payload: {
          log_id: updated.id!,
          step_execution_id: "exec-1",
          session_log: updated,
        },
      });
      listeners.created({
        payload: {
          log_id: appended.id!,
          step_execution_id: "exec-1",
          session_log: appended,
        },
      });
      useSessionLogStore.getState().flushPending();
    });
    expect(result.current.logsByExecutionId["exec-1"]).toEqual([
      first,
      updated,
      third,
      appended,
    ]);
  });

  it("does not seed session logs from stale project generations", async () => {
    const log = sessionLog();
    let resolveTrace:
      | ((result: { status: "ok"; data: TaskRunTrace }) => void)
      | null = null;
    mockGetTaskRunTrace.mockReturnValue(
      new Promise((resolve) => {
        resolveTrace = resolve;
      })
    );

    const { unmount } = renderHook(() => useRunTrace("task-1", "run-1"), {
      wrapper,
    });

    await waitFor(() => expect(mockGetTaskRunTrace).toHaveBeenCalled());

    act(() => {
      unmount();
      resetProjectScopedStores();
    });
    act(() => {
      resolveTrace!({
        status: "ok",
        data: {
          root_task_run_id: "run-1",
          task_runs: [],
          step_executions: [execution()],
          session_logs: [log],
        },
      });
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(useSessionLogStore.getState().logsByExecutionId).toEqual({});
  });

  it("does not mistake another history fetch for a live row update", async () => {
    const oldLog = sessionLog({ content: "old thinking" });
    const refreshedOldLog = { ...oldLog };
    const trace = {
      root_task_run_id: "run-1",
      task_runs: [],
      step_executions: [execution()],
      session_logs: [oldLog],
    } satisfies TaskRunTrace;
    mockGetTaskRunTrace.mockResolvedValueOnce({ status: "ok", data: trace });
    mockGetTaskRunTrace.mockResolvedValueOnce({
      status: "ok",
      data: { ...trace, session_logs: [refreshedOldLog] },
    });
    let resolveHistory!: (value: unknown) => void;
    mockGetExecutionLogs.mockReturnValue(
      new Promise((resolve) => {
        resolveHistory = resolve;
      })
    );
    const { result } = renderHook(() => useRunTrace("task-1", "run-1"), {
      wrapper,
    });
    await waitFor(() => expect(mockGetExecutionLogs).toHaveBeenCalled());

    act(() => result.current.refetch());
    await waitFor(() =>
      expect(
        useSessionLogStore.getState().logsByExecutionId["exec-1"].logs[0]
      ).toBe(refreshedOldLog)
    );
    const newer = sessionLog({ content: "new thinking" });
    const extra = sessionLog({ id: "history-2" });
    await act(async () =>
      resolveHistory({ status: "ok", data: [newer, extra] })
    );
    expect(result.current.logsByExecutionId["exec-1"]).toEqual([newer, extra]);
  });

  it("preserves execution history when an overlapping older trace resolves last", async () => {
    const oldLog = sessionLog({ content: "old thinking" });
    const trace = {
      root_task_run_id: "run-1",
      task_runs: [],
      step_executions: [execution()],
      session_logs: [oldLog],
    } satisfies TaskRunTrace;
    mockGetTaskRunTrace.mockResolvedValueOnce({ status: "ok", data: trace });
    let resolveTrace!: (value: unknown) => void;
    let resolveHistory!: (value: unknown) => void;
    mockGetTaskRunTrace.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveTrace = resolve;
      })
    );
    mockGetExecutionLogs.mockReturnValue(
      new Promise((resolve) => {
        resolveHistory = resolve;
      })
    );
    const { result } = renderHook(() => useRunTrace("task-1", "run-1"), {
      wrapper,
    });
    await waitFor(() => expect(mockGetExecutionLogs).toHaveBeenCalled());

    act(() => result.current.refetch());
    await waitFor(() => expect(mockGetTaskRunTrace).toHaveBeenCalledTimes(2));
    const newer = sessionLog({ content: "new thinking" });
    const extra = sessionLog({ id: "history-2" });
    await act(async () =>
      resolveHistory({ status: "ok", data: [newer, extra] })
    );
    await act(async () =>
      resolveTrace({
        status: "ok",
        data: { ...trace, session_logs: [{ ...oldLog }] },
      })
    );
    expect(result.current.logsByExecutionId["exec-1"]).toEqual([newer, extra]);
  });

  it("preserves newer live session logs when a trace fetch resolves late", async () => {
    const fetchedDurableLog = sessionLog({
      id: "log-durable",
      content: "older fetched durable log",
      created_at: "2026-01-01T00:00:01.000Z",
    });
    const fetchedLogicalLog = sessionLog({
      id: "log-thinking-old",
      logical_key: "thinking:exec-1",
      content: "older fetched thinking log",
      created_at: "2026-01-01T00:00:02.000Z",
    });
    const liveDurableLog = sessionLog({
      id: "log-durable",
      content: "newer live durable log",
      created_at: "2026-01-01T00:00:03.000Z",
    });
    const liveLogicalLog = sessionLog({
      id: "log-thinking-live",
      logical_key: "thinking:exec-1",
      content: "newer live thinking log",
      created_at: "2026-01-01T00:00:04.000Z",
    });
    const liveAppendOnlyLog = sessionLog({
      id: "log-live-only",
      content: "live-only appended log",
      created_at: "2026-01-01T00:00:05.000Z",
    });
    let resolveTrace:
      | ((result: { status: "ok"; data: TaskRunTrace }) => void)
      | null = null;
    mockGetTaskRunTrace.mockReturnValue(
      new Promise((resolve) => {
        resolveTrace = resolve;
      })
    );

    const { result } = renderHook(() => useRunTrace("task-1", "run-1"), {
      wrapper,
    });

    await waitFor(() => expect(mockGetTaskRunTrace).toHaveBeenCalled());

    act(() => {
      useSessionLogStore.getState().upsertLog("exec-1", liveDurableLog);
      useSessionLogStore.getState().upsertLog("exec-1", liveLogicalLog);
      useSessionLogStore.getState().appendLog("exec-1", liveAppendOnlyLog);
      useSessionLogStore.getState().flushPending();
    });
    act(() => {
      resolveTrace!({
        status: "ok",
        data: {
          root_task_run_id: "run-1",
          task_runs: [],
          step_executions: [execution()],
          session_logs: [fetchedDurableLog, fetchedLogicalLog],
        },
      });
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(
      useSessionLogStore.getState().logsByExecutionId["exec-1"]?.logs
    ).toEqual([liveDurableLog, liveLogicalLog, liveAppendOnlyLog]);
  });
});

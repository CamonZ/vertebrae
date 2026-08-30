import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor, act } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionLog, StepExecution, TaskRunTrace } from "../bindings";
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

const { mockGetTaskRunTrace, mockGetExecutionLogs } = vi.hoisted(() => ({
  mockGetTaskRunTrace: vi.fn(),
  mockGetExecutionLogs: vi.fn(),
}));

vi.mock("../bindings", () => ({
  commands: {
    getTaskRunTrace: (...args: unknown[]) => mockGetTaskRunTrace(...args),
    getExecutionLogs: (...args: unknown[]) => mockGetExecutionLogs(...args),
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

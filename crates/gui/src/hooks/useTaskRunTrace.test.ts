import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const mockGetTaskRunTrace = vi.fn();

vi.mock("../bindings", () => ({
  commands: {
    getTaskRunTrace: (...args: unknown[]) => mockGetTaskRunTrace(...args),
  },
}));

import { useTaskRunTrace } from "./useTaskRunTrace";
import type { SessionLog, StepExecution, TaskRun } from "../bindings";
import {
  useExecutionStore,
  useSessionLogStore,
  useTaskRunStore,
} from "../stores";
import { resetProjectScopedStores } from "../stores/projectScopedStores";

function makeRun(id: string): TaskRun {
  return {
    id,
    task_id: "task-1",
    project_id: "p",
    user_id: null,
    status: "completed",
    started_at: "2026-01-01T00:00:00.000Z",
    ended_at: "2026-01-01T00:01:00.000Z",
    stop_requested_at: null,
    latest_step_execution_id: null,
    outcome_kind: null,
    outcome_context: null,
    parent_task_run_id: null,
    root_task_run_id: id,
    triggered_by_step_execution_id: null,
    inserted_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:01:00.000Z",
  };
}

function makeExec(id: string, taskRunId: string): StepExecution {
  return {
    id,
    task_id: "task-1",
    task_run_id: taskRunId,
    workflow_id: "wf",
    step_name: "in_progress",
    started_at: "2026-01-01T00:00:00.000Z",
    completed_at: null,
    status: "completed",
  };
}

function makeLog(id: string, executionId: string): SessionLog {
  return {
    id,
    step_execution_id: executionId,
    content: "log",
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

describe("useTaskRunTrace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProjectScopedStores();
  });

  it("does not fetch when rootTaskRunId is null", async () => {
    const { result } = renderHook(() => useTaskRunTrace(null as string | null));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(mockGetTaskRunTrace).not.toHaveBeenCalled();
    expect(result.current.trace).toBeNull();
    expect(result.current.taskRuns).toEqual([]);
    expect(result.current.executions).toEqual([]);
    expect(result.current.sessionLogs).toEqual([]);
  });

  it("fetches the trace tree and exposes runs/executions/logs", async () => {
    const trace = {
      root_task_run_id: "run-root",
      task_runs: [makeRun("run-root"), makeRun("run-child")],
      step_executions: [
        makeExec("exec-1", "run-root"),
        makeExec("exec-2", "run-child"),
      ],
      session_logs: [makeLog("log-1", "exec-1"), makeLog("log-2", "exec-2")],
    };
    mockGetTaskRunTrace.mockResolvedValue({ status: "ok", data: trace });

    const { result } = renderHook(() => useTaskRunTrace("run-root"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(mockGetTaskRunTrace).toHaveBeenCalledWith("run-root");
    expect(result.current.trace?.root_task_run_id).toBe("run-root");
    expect(result.current.taskRuns.map((r) => r.id)).toEqual([
      "run-root",
      "run-child",
    ]);
    expect(result.current.executions.map((e) => e.id)).toEqual([
      "exec-1",
      "exec-2",
    ]);
    expect(result.current.sessionLogs.map((l) => l.id)).toEqual([
      "log-1",
      "log-2",
    ]);
  });

  it("treats missing trace fields as empty arrays", async () => {
    mockGetTaskRunTrace.mockResolvedValue({
      status: "ok",
      data: { root_task_run_id: "run-root" },
    });

    const { result } = renderHook(() => useTaskRunTrace("run-root"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.taskRuns).toEqual([]);
    expect(result.current.executions).toEqual([]);
    expect(result.current.sessionLogs).toEqual([]);
  });

  it("surfaces command errors and clears the trace", async () => {
    mockGetTaskRunTrace.mockResolvedValue({
      status: "error",
      error: { message: "boom" },
    });

    const { result } = renderHook(() => useTaskRunTrace("run-root"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.error).toBe("boom");
    expect(result.current.trace).toBeNull();
  });

  it("refetches when rootTaskRunId changes", async () => {
    mockGetTaskRunTrace.mockImplementation((id: string) =>
      Promise.resolve({
        status: "ok",
        data: {
          root_task_run_id: id,
          task_runs: [makeRun(id)],
          step_executions: [],
          session_logs: [],
        },
      })
    );

    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useTaskRunTrace(id),
      { initialProps: { id: "run-a" as string | null } }
    );
    await waitFor(() =>
      expect(result.current.trace?.root_task_run_id).toBe("run-a")
    );

    rerender({ id: "run-b" });
    await waitFor(() =>
      expect(result.current.trace?.root_task_run_id).toBe("run-b")
    );

    expect(mockGetTaskRunTrace).toHaveBeenCalledTimes(2);
  });

  it("merges live executions for task runs already in the trace", async () => {
    mockGetTaskRunTrace.mockResolvedValue({
      status: "ok",
      data: {
        root_task_run_id: "run-root",
        task_runs: [makeRun("run-root"), makeRun("run-child")],
        step_executions: [makeExec("exec-1", "run-root")],
        session_logs: [],
      },
    });

    const { result } = renderHook(() => useTaskRunTrace("run-root"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      useExecutionStore
        .getState()
        .upsertExecution(makeExec("exec-live", "run-child"));
      useExecutionStore
        .getState()
        .upsertExecution(makeExec("exec-ignored", "run-outside"));
    });

    expect(result.current.executions.map((execution) => execution.id)).toEqual([
      "exec-1",
      "exec-live",
    ]);
    expect(mockGetTaskRunTrace).toHaveBeenCalledTimes(1);
  });

  it("merges live session logs for execution ids in the trace", async () => {
    mockGetTaskRunTrace.mockResolvedValue({
      status: "ok",
      data: {
        root_task_run_id: "run-root",
        task_runs: [makeRun("run-root")],
        step_executions: [makeExec("exec-1", "run-root")],
        session_logs: [makeLog("log-fetched", "exec-1")],
      },
    });

    const { result } = renderHook(() => useTaskRunTrace("run-root"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      useSessionLogStore
        .getState()
        .appendLog("exec-1", makeLog("log-live", "exec-1"));
      useSessionLogStore
        .getState()
        .appendLog("exec-outside", makeLog("log-ignored", "exec-outside"));
    });

    expect(result.current.sessionLogs.map((log) => log.id)).toEqual([
      "log-fetched",
      "log-live",
    ]);
    expect(mockGetTaskRunTrace).toHaveBeenCalledTimes(1);
  });

  it("overlays live task run updates for runs already in the trace", async () => {
    mockGetTaskRunTrace.mockResolvedValue({
      status: "ok",
      data: {
        root_task_run_id: "run-root",
        task_runs: [makeRun("run-root")],
        step_executions: [],
        session_logs: [],
      },
    });

    const { result } = renderHook(() => useTaskRunTrace("run-root"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      useTaskRunStore.getState().upsertTaskRun({
        ...makeRun("run-root"),
        status: "executing",
        latest_step_execution_id: "exec-live",
      });
      useTaskRunStore.getState().upsertTaskRun(makeRun("run-outside"));
    });

    expect(result.current.taskRuns).toHaveLength(1);
    expect(result.current.taskRuns[0]).toMatchObject({
      id: "run-root",
      status: "executing",
      latest_step_execution_id: "exec-live",
    });
    expect(mockGetTaskRunTrace).toHaveBeenCalledTimes(1);
  });

  it("refetches when a live child run appears under the current trace root", async () => {
    const rootRun = makeRun("run-root");
    const childRun = {
      ...makeRun("run-child"),
      parent_task_run_id: "run-root",
      root_task_run_id: "run-root",
    };
    mockGetTaskRunTrace
      .mockResolvedValueOnce({
        status: "ok",
        data: {
          root_task_run_id: "run-root",
          task_runs: [rootRun],
          step_executions: [],
          session_logs: [],
        },
      })
      .mockResolvedValueOnce({
        status: "ok",
        data: {
          root_task_run_id: "run-root",
          task_runs: [rootRun, childRun],
          step_executions: [],
          session_logs: [],
        },
      });

    const { result } = renderHook(() => useTaskRunTrace("run-root"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      useTaskRunStore.getState().upsertTaskRun(childRun);
    });

    await waitFor(() => expect(mockGetTaskRunTrace).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(result.current.taskRuns.map((run) => run.id)).toEqual([
        "run-root",
        "run-child",
      ])
    );
  });
});

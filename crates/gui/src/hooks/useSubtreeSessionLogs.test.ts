import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

const mockGetExecutionLogs = vi.fn();

vi.mock("../bindings", () => ({
  commands: {
    getExecutionLogs: (...args: unknown[]) => mockGetExecutionLogs(...args),
  },
}));

import { useSubtreeSessionLogs } from "./useSubtreeSessionLogs";
import type { SessionLog, StepExecution } from "../bindings";

function exec(id: string | null): StepExecution {
  return {
    id,
    task_id: "t",
    workflow_id: "wf",
    step_name: "step",
    started_at: "2026-01-01T00:00:00.000Z",
    completed_at: null,
    status: "completed",
  } as StepExecution;
}

function log(id: string, content = "{}"): SessionLog {
  return {
    id,
    execution_id: "e",
    content,
    created_at: "2026-01-01T00:00:00.000Z",
  } as SessionLog;
}

describe("useSubtreeSessionLogs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty map and skips fetching when there are no execution ids", async () => {
    const { result } = renderHook(() => useSubtreeSessionLogs([]));
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.logsByExecutionId).toEqual({});
    expect(mockGetExecutionLogs).not.toHaveBeenCalled();
  });

  it("fans out parallel fetches and indexes results by execution id", async () => {
    mockGetExecutionLogs.mockImplementation((id: string) =>
      Promise.resolve({ status: "ok", data: [log(`${id}-l1`)] })
    );
    const executions = [exec("e1"), exec("e2")];
    const { result } = renderHook(() => useSubtreeSessionLogs(executions));
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(mockGetExecutionLogs).toHaveBeenCalledTimes(2);
    expect(Object.keys(result.current.logsByExecutionId).sort()).toEqual([
      "e1",
      "e2",
    ]);
    expect(result.current.error).toBeNull();
  });

  it("filters out executions without an id", async () => {
    mockGetExecutionLogs.mockResolvedValue({ status: "ok", data: [] });
    const { result } = renderHook(() =>
      useSubtreeSessionLogs([exec("e1"), exec(null)])
    );
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(mockGetExecutionLogs).toHaveBeenCalledTimes(1);
    expect(mockGetExecutionLogs).toHaveBeenCalledWith("e1");
  });

  it("surfaces the first error message and still indexes successful results", async () => {
    mockGetExecutionLogs.mockImplementation((id: string) =>
      id === "bad"
        ? Promise.resolve({ status: "err", error: { message: "kaboom" } })
        : Promise.resolve({ status: "ok", data: [log(`${id}-l1`)] })
    );
    const { result } = renderHook(() =>
      useSubtreeSessionLogs([exec("good"), exec("bad")])
    );
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.error).toBe("kaboom");
    expect(result.current.logsByExecutionId.good).toBeDefined();
    expect(result.current.logsByExecutionId.bad).toBeUndefined();
  });

  it("refetch reissues the requests", async () => {
    mockGetExecutionLogs.mockResolvedValue({ status: "ok", data: [] });
    const { result } = renderHook(() =>
      useSubtreeSessionLogs([exec("e1")])
    );
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(mockGetExecutionLogs).toHaveBeenCalledTimes(1);
    act(() => {
      result.current.refetch();
    });
    await waitFor(() => {
      expect(mockGetExecutionLogs).toHaveBeenCalledTimes(2);
    });
    expect(mockGetExecutionLogs).toHaveBeenCalledTimes(2);
  });
});

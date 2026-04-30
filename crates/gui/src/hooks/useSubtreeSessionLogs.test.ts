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
import { useSessionLogStore } from "../stores";

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
    act(() => {
      useSessionLogStore.setState({ logsByExecutionId: {} });
    });
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

  it("merges live store appends over the fetched baseline (live wins when superset)", async () => {
    const fetched = [log("e1-fetched-1")];
    mockGetExecutionLogs.mockResolvedValue({ status: "ok", data: fetched });
    const { result } = renderHook(() => useSubtreeSessionLogs([exec("e1")]));
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.logsByExecutionId.e1).toEqual(fetched);

    const liveSuperset = [log("e1-fetched-1"), log("e1-live-2")];
    act(() => {
      useSessionLogStore.setState({
        logsByExecutionId: { e1: liveSuperset },
      });
    });
    expect(result.current.logsByExecutionId.e1).toBe(liveSuperset);
    expect(result.current.logsByExecutionId.e1).toHaveLength(2);
  });

  it("falls back to fetched baseline when live store is empty for that execution", async () => {
    const fetched = [log("e1-fetched-1")];
    mockGetExecutionLogs.mockResolvedValue({ status: "ok", data: fetched });
    const { result } = renderHook(() => useSubtreeSessionLogs([exec("e1")]));
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.logsByExecutionId.e1).toEqual(fetched);

    act(() => {
      useSessionLogStore.setState({ logsByExecutionId: { e1: [] } });
    });
    // Empty live bucket must NOT clobber the fetched baseline.
    expect(result.current.logsByExecutionId.e1).toEqual(fetched);
  });

  it("does not include executions that have neither fetched nor live logs", async () => {
    mockGetExecutionLogs.mockImplementation((id: string) =>
      id === "missing"
        ? Promise.resolve({ status: "err", error: { message: "x" } })
        : Promise.resolve({ status: "ok", data: [log(`${id}-l1`)] })
    );
    const { result } = renderHook(() =>
      useSubtreeSessionLogs([exec("present"), exec("missing")])
    );
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.logsByExecutionId.present).toBeDefined();
    expect("missing" in result.current.logsByExecutionId).toBe(false);
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

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
import { resetProjectScopedStores } from "../stores/projectScopedStores";

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
    step_execution_id: "e",
    content,
    created_at: "2026-01-01T00:00:00.000Z",
  } as SessionLog;
}

describe("useSubtreeSessionLogs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    act(() => {
      useSessionLogStore.getState().reset();
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
    expect(result.current.logBucketsByExecutionId.e1).toEqual({
      logs: fetched,
      fallbackCost: 0,
    });

    const liveSuperset = [log("e1-fetched-1"), log("e1-live-2")];
    act(() => {
      useSessionLogStore.setState({
        logsByExecutionId: {
          e1: { logs: liveSuperset, fallbackCost: 0 },
        },
      });
    });
    expect(result.current.logsByExecutionId.e1).toBe(liveSuperset);
    expect(result.current.logsByExecutionId.e1).toHaveLength(2);
  });

  it("preserves history while showing live appends and updates to existing rows", async () => {
    const fetched = [
      log("history-1"),
      log("history-2"),
      log("thinking", "old"),
    ];
    mockGetExecutionLogs.mockResolvedValue({ status: "ok", data: fetched });
    const { result } = renderHook(() => useSubtreeSessionLogs([exec("e1")]));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const updated = log("thinking", "new thinking");
    const appended = log("live", "new output");
    act(() => {
      useSessionLogStore.getState().upsertLog("e1", updated);
      useSessionLogStore.getState().appendLog("e1", appended);
      useSessionLogStore.getState().flushPending();
    });

    expect(result.current.logsByExecutionId.e1).toEqual([
      fetched[0],
      fetched[1],
      updated,
      appended,
    ]);
  });

  it("does not rerender for live logs outside the requested executions", async () => {
    mockGetExecutionLogs.mockResolvedValue({
      status: "ok",
      data: [log("e1-fetched-1")],
    });
    let renderCount = 0;
    const { result } = renderHook(() => {
      renderCount += 1;
      return useSubtreeSessionLogs([exec("e1")]);
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const settledRenderCount = renderCount;

    act(() => {
      useSessionLogStore.getState().appendLog("unrelated", log("other-live"));
    });

    expect(renderCount).toBe(settledRenderCount);

    act(() => {
      useSessionLogStore.getState().appendLog("e1", log("e1-live-2"));
    });
    await waitFor(() =>
      expect(renderCount).toBeGreaterThan(settledRenderCount)
    );
    expect(result.current.logsByExecutionId.e1).toEqual([
      log("e1-fetched-1"),
      log("e1-live-2"),
    ]);
  });

  it("clears rendered history when the shared store resets", async () => {
    const fetched = [log("e1-fetched-1")];
    mockGetExecutionLogs.mockResolvedValue({ status: "ok", data: fetched });
    const { result } = renderHook(() => useSubtreeSessionLogs([exec("e1")]));
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.logsByExecutionId.e1).toEqual(fetched);

    act(() => {
      useSessionLogStore.setState({
        logsByExecutionId: { e1: { logs: [], fallbackCost: 0 } },
      });
    });
    expect(result.current.logsByExecutionId.e1).toEqual([]);
  });

  it("keeps the complete fetched trace when the live bucket is only a retained subset", async () => {
    const fetched = [log("e1-fetched-1"), log("e1-fetched-2")];
    act(() => {
      useSessionLogStore.setState({
        logsByExecutionId: {
          e1: { logs: [log("e1-fetched-2")], fallbackCost: 0 },
        },
      });
    });
    mockGetExecutionLogs.mockResolvedValue({ status: "ok", data: fetched });
    const { result } = renderHook(() => useSubtreeSessionLogs([exec("e1")]));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

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

  it("preserves live changes by id and logical key when history resolves late", async () => {
    const oldThinking = {
      ...log("thinking-old", "old"),
      logical_key: "thinking",
    };
    useSessionLogStore.getState().setLogs("e1", [oldThinking]);
    let resolveFetch!: (value: unknown) => void;
    mockGetExecutionLogs.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      })
    );
    const { result } = renderHook(() => useSubtreeSessionLogs([exec("e1")]));
    await waitFor(() => expect(mockGetExecutionLogs).toHaveBeenCalled());

    const updated = { ...log("thinking-new", "new"), logical_key: "thinking" };
    const appended = log("live", "new output");
    act(() => {
      useSessionLogStore.getState().upsertLog("e1", updated);
      useSessionLogStore.getState().appendLog("e1", appended);
      useSessionLogStore.getState().flushPending();
      resolveFetch({ status: "ok", data: [log("history"), oldThinking] });
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.logsByExecutionId.e1).toEqual([
      log("history"),
      updated,
      appended,
    ]);
  });

  it("does not repopulate the store with an old project's pending history", async () => {
    let resolveFetch!: (value: unknown) => void;
    mockGetExecutionLogs.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFetch = resolve;
      })
    );
    mockGetExecutionLogs.mockResolvedValue({
      status: "ok",
      data: [log("new-project")],
    });
    const { result } = renderHook(() => useSubtreeSessionLogs([exec("e1")]));
    await waitFor(() => expect(mockGetExecutionLogs).toHaveBeenCalledTimes(1));

    act(() => resetProjectScopedStores());
    await waitFor(() =>
      expect(result.current.logsByExecutionId.e1).toEqual([log("new-project")])
    );
    await act(async () =>
      resolveFetch({ status: "ok", data: [log("old-project")] })
    );
    expect(result.current.logsByExecutionId.e1).toEqual([log("new-project")]);
  });

  it("does not seed an abandoned fetch after the execution selection is cleared", async () => {
    let resolveFetch!: (value: unknown) => void;
    mockGetExecutionLogs.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      })
    );
    const { result, rerender } = renderHook(
      ({ executions }) => useSubtreeSessionLogs(executions),
      {
        initialProps: { executions: [exec("e1")] },
      }
    );
    await waitFor(() => expect(mockGetExecutionLogs).toHaveBeenCalled());
    rerender({ executions: [] });
    await act(async () =>
      resolveFetch({ status: "ok", data: [log("abandoned")] })
    );
    expect(result.current.isLoading).toBe(false);
    expect(useSessionLogStore.getState().logsByExecutionId).toEqual({});
  });

  it("refetch reissues the requests", async () => {
    mockGetExecutionLogs.mockResolvedValue({ status: "ok", data: [] });
    const { result } = renderHook(() => useSubtreeSessionLogs([exec("e1")]));
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

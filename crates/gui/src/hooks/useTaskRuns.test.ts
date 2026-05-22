import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

const mockGetTaskRuns = vi.fn();

vi.mock("../bindings", () => ({
  commands: {
    getTaskRuns: (...args: unknown[]) => mockGetTaskRuns(...args),
  },
}));

import { useTaskRuns, useTaskRunsForTasks } from "./useTaskRuns";
import { useTaskRunStore } from "../stores/taskRunStore";
import { createMockTaskRun } from "../test/test-utils";
import type { TaskRun } from "../bindings";

function makeRun(overrides: Partial<TaskRun> = {}): TaskRun {
  return createMockTaskRun({
    task_id: "task-1",
    started_at: "2026-01-01T00:00:00.000Z",
    inserted_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

describe("useTaskRuns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTaskRunStore.setState({ taskRuns: [], taskRunsByTaskId: {} });
  });

  it("fetches runs and stores them by task id, sorted newest-first", async () => {
    const older = makeRun({
      id: "run-old",
      status: "completed",
      started_at: "2026-01-01T08:00:00.000Z",
    });
    const newer = makeRun({
      id: "run-new",
      status: "completed",
      started_at: "2026-01-02T08:00:00.000Z",
    });
    mockGetTaskRuns.mockResolvedValue({ status: "ok", data: [older, newer] });

    const { result } = renderHook(() => useTaskRuns("task-1"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(mockGetTaskRuns).toHaveBeenCalledWith("task-1");
    expect(result.current.runs.map((r) => r.id)).toEqual(["run-new", "run-old"]);
    expect(useTaskRunStore.getState().taskRunsByTaskId["task-1"]).toHaveLength(2);
  });

  it("classifies the most recent non-terminal run as activeRun", async () => {
    const finished = makeRun({
      id: "run-done",
      status: "completed",
      started_at: "2026-01-01T08:00:00.000Z",
    });
    const live = makeRun({
      id: "run-live",
      status: "executing",
      started_at: "2026-01-02T08:00:00.000Z",
    });
    mockGetTaskRuns.mockResolvedValue({ status: "ok", data: [finished, live] });

    const { result } = renderHook(() => useTaskRuns("task-1"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.activeRun?.id).toBe("run-live");
    expect(result.current.latestRun).toBeNull();
  });

  it("returns latestRun (terminal) only when no active run is present", async () => {
    const failed = makeRun({
      id: "run-failed",
      status: "failed",
      started_at: "2026-01-01T08:00:00.000Z",
    });
    const completed = makeRun({
      id: "run-completed",
      status: "completed",
      started_at: "2026-01-02T08:00:00.000Z",
    });
    mockGetTaskRuns.mockResolvedValue({
      status: "ok",
      data: [failed, completed],
    });

    const { result } = renderHook(() => useTaskRuns("task-1"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.activeRun).toBeNull();
    expect(result.current.latestRun?.id).toBe("run-completed");
  });

  describe("resolveRun", () => {
    it("returns the active run when no selection is provided", async () => {
      const live = makeRun({ id: "run-live", status: "executing" });
      mockGetTaskRuns.mockResolvedValue({ status: "ok", data: [live] });

      const { result } = renderHook(() => useTaskRuns("task-1"));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      const resolved = result.current.resolveRun(null);
      expect(resolved.run?.id).toBe("run-live");
      expect(resolved.source).toBe("active");
    });

    it("returns the latest terminal run when no active run exists", async () => {
      const completed = makeRun({ id: "run-completed", status: "completed" });
      mockGetTaskRuns.mockResolvedValue({ status: "ok", data: [completed] });

      const { result } = renderHook(() => useTaskRuns("task-1"));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      const resolved = result.current.resolveRun(null);
      expect(resolved.run?.id).toBe("run-completed");
      expect(resolved.source).toBe("latest");
    });

    it("returns the explicitly selected run when its id is in the list", async () => {
      const live = makeRun({ id: "run-live", status: "executing" });
      const completed = makeRun({
        id: "run-old",
        status: "completed",
        started_at: "2025-12-31T00:00:00.000Z",
      });
      mockGetTaskRuns.mockResolvedValue({
        status: "ok",
        data: [live, completed],
      });

      const { result } = renderHook(() => useTaskRuns("task-1"));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      const resolved = result.current.resolveRun("run-old");
      expect(resolved.run?.id).toBe("run-old");
      expect(resolved.source).toBe("selected");
    });

    it("falls back to active when selectedRunId does not match any run", async () => {
      const live = makeRun({ id: "run-live", status: "executing" });
      mockGetTaskRuns.mockResolvedValue({ status: "ok", data: [live] });

      const { result } = renderHook(() => useTaskRuns("task-1"));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      const resolved = result.current.resolveRun("missing");
      expect(resolved.run?.id).toBe("run-live");
      expect(resolved.source).toBe("active");
    });

    it("returns source 'none' when the task has no runs", async () => {
      mockGetTaskRuns.mockResolvedValue({ status: "ok", data: [] });

      const { result } = renderHook(() => useTaskRuns("task-1"));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      const resolved = result.current.resolveRun(null);
      expect(resolved.run).toBeNull();
      expect(resolved.source).toBe("none");
    });
  });

  it("does not fetch when taskId is null", async () => {
    const { result } = renderHook(() => useTaskRuns(null as string | null));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(mockGetTaskRuns).not.toHaveBeenCalled();
    expect(result.current.runs).toEqual([]);
    expect(result.current.activeRun).toBeNull();
    expect(result.current.latestRun).toBeNull();
  });

  it("surfaces command errors", async () => {
    mockGetTaskRuns.mockResolvedValue({
      status: "error",
      error: { message: "boom" },
    });

    const { result } = renderHook(() => useTaskRuns("task-1"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.error).toBe("boom");
  });

  it("re-renders when the store is updated by the websocket listener", async () => {
    mockGetTaskRuns.mockResolvedValue({ status: "ok", data: [] });
    const { result } = renderHook(() => useTaskRuns("task-1"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.runs).toEqual([]);

    act(() => {
      useTaskRunStore.getState().upsertTaskRun(
        makeRun({ id: "run-new", status: "executing" })
      );
    });

    expect(result.current.runs.map((r) => r.id)).toEqual(["run-new"]);
    expect(result.current.activeRun?.id).toBe("run-new");
  });
});

describe("useTaskRunsForTasks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTaskRunStore.setState({ taskRuns: [], taskRunsByTaskId: {} });
  });

  it("fetches each unique task id once and returns all runs newest-first", async () => {
    const task1Old = makeRun({
      id: "run-task-1-old",
      task_id: "task-1",
      status: "completed",
      started_at: "2026-01-01T08:00:00.000Z",
    });
    const task2New = makeRun({
      id: "run-task-2-new",
      task_id: "task-2",
      status: "completed",
      started_at: "2026-01-02T08:00:00.000Z",
    });

    mockGetTaskRuns.mockImplementation(async (taskId: string) => ({
      status: "ok",
      data: taskId === "task-1" ? [task1Old] : [task2New],
    }));

    const { result } = renderHook(() =>
      useTaskRunsForTasks(["task-2", "task-1", "task-2"])
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(mockGetTaskRuns).toHaveBeenCalledTimes(2);
    expect(mockGetTaskRuns.mock.calls.map(([taskId]) => taskId)).toEqual([
      "task-1",
      "task-2",
    ]);
    expect(result.current.runs.map((r) => r.id)).toEqual([
      "run-task-2-new",
      "run-task-1-old",
    ]);
    expect(useTaskRunStore.getState().taskRunsByTaskId["task-1"]).toEqual([
      task1Old,
    ]);
    expect(useTaskRunStore.getState().taskRunsByTaskId["task-2"]).toEqual([
      task2New,
    ]);
  });

  it("returns immediately without fetching when no task ids are provided", async () => {
    const { result } = renderHook(() => useTaskRunsForTasks([]));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(mockGetTaskRuns).not.toHaveBeenCalled();
    expect(result.current.runs).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it("keeps successful task runs while surfacing the first fetch error", async () => {
    const successfulRun = makeRun({
      id: "run-success",
      task_id: "task-success",
      status: "completed",
    });

    mockGetTaskRuns.mockImplementation(async (taskId: string) =>
      taskId === "task-fail"
        ? { status: "error", error: { message: "cannot load task runs" } }
        : { status: "ok", data: [successfulRun] }
    );

    const { result } = renderHook(() =>
      useTaskRunsForTasks(["task-fail", "task-success"])
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.error).toBe("cannot load task runs");
    expect(result.current.runs.map((r) => r.id)).toEqual(["run-success"]);
    expect(useTaskRunStore.getState().taskRunsByTaskId["task-success"]).toEqual(
      [successfulRun]
    );
  });

  it("refetches when the task id set changes", async () => {
    mockGetTaskRuns.mockResolvedValue({ status: "ok", data: [] });

    const { result, rerender } = renderHook(
      ({ taskIds }: { taskIds: string[] }) => useTaskRunsForTasks(taskIds),
      { initialProps: { taskIds: ["task-1"] } }
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mockGetTaskRuns.mock.calls.map(([taskId]) => taskId)).toEqual([
      "task-1",
    ]);

    rerender({ taskIds: ["task-1", "task-2"] });
    await waitFor(() => expect(mockGetTaskRuns).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(mockGetTaskRuns.mock.calls.map(([taskId]) => taskId)).toEqual([
      "task-1",
      "task-1",
      "task-2",
    ]);
  });
});

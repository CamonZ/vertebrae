import { renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockTaskRun } from "../test/test-utils";
import { queryClient } from "../query";
import {
  getProjectScopeGeneration,
  resetProjectScopedStores,
} from "../stores/projectScopedStores";

const mockGetTaskRuns = vi.hoisted(() => vi.fn());

vi.mock("../bindings", () => ({
  commands: { getTaskRuns: (...args: unknown[]) => mockGetTaskRuns(...args) },
}));

import {
  selectActiveTaskRun,
  useActiveTaskRunsForTasks,
  useTaskRuns,
} from "./useTaskRuns";

function QueryWrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

describe("useTaskRuns", () => {
  beforeEach(() => {
    queryClient.clear();
    resetProjectScopedStores();
    vi.clearAllMocks();
  });

  it("selects the newest active run without considering task controls", () => {
    const older = createMockTaskRun({
      id: "run-old",
      task_id: "task-1",
      status: "executing",
      started_at: "2026-01-01T00:00:00Z",
    });
    const newer = createMockTaskRun({
      id: "run-new",
      task_id: "task-1",
      status: "waiting",
      started_at: "2026-01-02T00:00:00Z",
    });

    expect(selectActiveTaskRun([older, newer])).toEqual(newer);
  });

  it("loads TaskRuns into the query-backed active-run selector", async () => {
    const taskRun = createMockTaskRun({
      id: "run-live",
      task_id: "task-live",
      status: "executing",
    });
    mockGetTaskRuns.mockResolvedValue({ status: "ok", data: [taskRun] });

    const { result } = renderHook(() => useTaskRuns("task-live"), {
      wrapper: QueryWrapper,
    });

    await waitFor(() => expect(result.current.activeRun).toEqual(taskRun));
    expect(mockGetTaskRuns).toHaveBeenCalledWith("task-live");
  });

  it("reads bulk-hydrated active runs without fetching task history", () => {
    const taskRun = createMockTaskRun({
      id: "run-bulk",
      task_id: "task-bulk",
      status: "executing",
    });
    queryClient.setQueryData(
      [
        "project",
        getProjectScopeGeneration(),
        "taskRuns",
        "byTask",
        "task-bulk",
      ],
      [taskRun]
    );

    const { result } = renderHook(
      () => useActiveTaskRunsForTasks(["task-bulk"]),
      { wrapper: QueryWrapper }
    );

    expect(result.current.activeRunsByTaskId.get("task-bulk")).toEqual(
      taskRun
    );
    expect(mockGetTaskRuns).not.toHaveBeenCalled();
  });

  it("upgrades an active snapshot to complete history for traces", async () => {
    const activeRun = createMockTaskRun({
      id: "run-active",
      task_id: "task-trace",
      status: "executing",
    });
    const completedRun = createMockTaskRun({
      id: "run-completed",
      task_id: "task-trace",
      status: "completed",
    });
    queryClient.setQueryData(
      [
        "project",
        getProjectScopeGeneration(),
        "taskRuns",
        "byTask",
        "task-trace",
      ],
      [activeRun]
    );
    mockGetTaskRuns.mockResolvedValue({
      status: "ok",
      data: [activeRun, completedRun],
    });

    const { result } = renderHook(() => useTaskRuns("task-trace"), {
      wrapper: QueryWrapper,
    });

    await waitFor(() => expect(result.current.runs).toHaveLength(2));
    expect(mockGetTaskRuns).toHaveBeenCalledWith("task-trace");
  });
});

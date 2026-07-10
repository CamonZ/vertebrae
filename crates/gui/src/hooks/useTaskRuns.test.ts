import { renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockTaskRun } from "../test/test-utils";
import { queryClient } from "../query";
import { resetProjectScopedStores } from "../stores/projectScopedStores";

const mockGetTaskRuns = vi.hoisted(() => vi.fn());

vi.mock("../bindings", () => ({
  commands: { getTaskRuns: (...args: unknown[]) => mockGetTaskRuns(...args) },
}));

import { selectActiveTaskRun, useTaskRuns } from "./useTaskRuns";

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
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";

const mockGetTaskExecutions = vi.fn();

vi.mock("../bindings", () => ({
  commands: {
    listTasks: vi.fn(async () => ({ status: "ok", data: [] })),
    getTaskExecutions: (...args: unknown[]) => mockGetTaskExecutions(...args),
  },
}));

import { useSubtreeExecutions } from "./useSubtreeExecutions";
import { useExecutionStore } from "../stores/executionStore";
import { createMockTask } from "../test/test-utils";
import type { StepExecution, Task } from "../bindings";
import {
  getProjectScopeGeneration,
  resetProjectScopedStores,
} from "../stores/projectScopedStores";
import { queryClient, queryKeys } from "../query";

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client: queryClient }, children);

function exec(overrides: Partial<StepExecution> = {}): StepExecution {
  return {
    id: `exec-${Math.random().toString(36).slice(2, 8)}`,
    task_id: "t",
    workflow_id: "wf",
    step_name: "step",
    started_at: "2026-01-01T00:00:00.000Z",
    completed_at: null,
    status: "completed",
    ...overrides,
  };
}

describe("useSubtreeExecutions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProjectScopedStores();
    useExecutionStore.setState({ executions: [], executionsByTaskId: {} });
  });

  function seedTree() {
    const tasks: Task[] = [
      createMockTask({ id: "epic", parent_id: null }),
      createMockTask({ id: "ticket-1", parent_id: "epic" }),
      createMockTask({ id: "ticket-2", parent_id: "epic" }),
      createMockTask({ id: "task-1", parent_id: "ticket-1" }),
      createMockTask({ id: "unrelated", parent_id: null }),
    ];
    queryClient.setQueryData(
      queryKeys.tasks.list(getProjectScopeGeneration(), null),
      tasks
    );
  }

  it("fans out parallel getTaskExecutions calls and merges results", async () => {
    seedTree();
    mockGetTaskExecutions.mockImplementation((taskId: string) =>
      Promise.resolve({
        status: "ok",
        data: [
          exec({
            id: `${taskId}-e1`,
            task_id: taskId,
            // Each subtree task contributes a single distinct TaskRun.
            task_run_id: `run-${taskId}`,
            cost: "0.1",
            input_tokens: 50,
            output_tokens: 25,
            duration_ms: 1000,
          }),
        ],
      })
    );

    const { result } = renderHook(() => useSubtreeExecutions("epic"), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // Subtree contains: epic, ticket-1, ticket-2, task-1 (4 tasks)
    expect(mockGetTaskExecutions).toHaveBeenCalledTimes(4);
    const calledIds = new Set(
      mockGetTaskExecutions.mock.calls.map((c) => c[0])
    );
    expect(calledIds).toEqual(
      new Set(["epic", "ticket-1", "ticket-2", "task-1"])
    );
    expect(calledIds.has("unrelated")).toBe(false);

    expect(result.current.executions).toHaveLength(4);
    expect(result.current.rollups).toEqual({
      totalRuns: 4,
      totalAttempts: 4,
      totalCost: 0.4,
      totalTokens: 4 * 75,
      rawInputTokens: 4 * 50,
      cacheReadTokens: 0,
      outputTokens: 4 * 25,
      totalWallTimeMs: 4000,
    });
  });

  it("issues all fan-out calls in parallel (not sequentially)", async () => {
    seedTree();
    let inFlight = 0;
    let maxConcurrent = 0;
    mockGetTaskExecutions.mockImplementation(async (taskId: string) => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight--;
      return {
        status: "ok",
        data: [exec({ id: `${taskId}-e`, task_id: taskId })],
      };
    });

    const { result } = renderHook(() => useSubtreeExecutions("epic"), {
      wrapper,
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(maxConcurrent).toBeGreaterThan(1);
    expect(maxConcurrent).toBe(4);
  });

  it("recomputes rollups when a global upsertExecution writes a subtree task", async () => {
    seedTree();
    mockGetTaskExecutions.mockImplementation((taskId: string) =>
      Promise.resolve({
        status: "ok",
        data: [
          exec({
            id: `${taskId}-e1`,
            task_id: taskId,
            task_run_id: `run-${taskId}`,
            cost: "0.1",
            input_tokens: 10,
            output_tokens: 0,
            duration_ms: 100,
          }),
        ],
      })
    );

    const { result } = renderHook(() => useSubtreeExecutions("epic"), {
      wrapper,
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.rollups.totalRuns).toBe(4);
    expect(result.current.rollups.totalAttempts).toBe(4);
    expect(result.current.rollups.totalCost).toBeCloseTo(0.4, 10);

    act(() => {
      useExecutionStore.getState().upsertExecution(
        exec({
          id: "new-exec",
          task_id: "task-1",
          // A retry inside an existing TaskRun must bump attempts but not runs.
          task_run_id: "run-task-1",
          cost: "1.0",
          input_tokens: 100,
          output_tokens: 200,
          duration_ms: 5000,
        })
      );
    });

    await waitFor(() => expect(result.current.rollups.totalAttempts).toBe(5));
    expect(result.current.rollups.totalRuns).toBe(4);
    expect(result.current.rollups.totalCost).toBeCloseTo(1.4, 10);
    expect(result.current.rollups.totalTokens).toBe(4 * 10 + 300);
    expect(result.current.rollups.totalWallTimeMs).toBe(400 + 5000);
  });

  it("ignores executions for tasks outside the subtree", async () => {
    seedTree();
    mockGetTaskExecutions.mockResolvedValue({ status: "ok", data: [] });

    const { result } = renderHook(() => useSubtreeExecutions("epic"), {
      wrapper,
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.executions).toHaveLength(0);

    act(() => {
      useExecutionStore
        .getState()
        .upsertExecution(
          exec({ id: "stray", task_id: "unrelated", cost: "99" })
        );
    });

    expect(result.current.executions).toHaveLength(0);
    expect(result.current.rollups.totalRuns).toBe(0);
    expect(result.current.isInSubtree("unrelated")).toBe(false);
    expect(result.current.isInSubtree("task-1")).toBe(true);
  });

  it("returns no executions and does not fetch when rootTaskId is null", async () => {
    seedTree();
    const { result } = renderHook(
      () => useSubtreeExecutions(null as string | null),
      { wrapper }
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mockGetTaskExecutions).not.toHaveBeenCalled();
    expect(result.current.executions).toEqual([]);
    expect(result.current.subtreeTaskIds).toEqual([]);
  });

  it("surfaces the first error when one fan-out call fails", async () => {
    seedTree();
    mockGetTaskExecutions.mockImplementation((taskId: string) => {
      if (taskId === "ticket-1") {
        return Promise.resolve({
          status: "error",
          error: { message: "boom" },
        });
      }
      return Promise.resolve({ status: "ok", data: [] });
    });

    const { result } = renderHook(() => useSubtreeExecutions("epic"), {
      wrapper,
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe("boom");
  });
});

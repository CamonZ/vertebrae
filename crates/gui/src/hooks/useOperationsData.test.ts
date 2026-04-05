import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useTaskStore } from "../stores/taskStore";
import { useExecutionStore } from "../stores/executionStore";
import { createMockTask, createMockStepExecution } from "../test/test-utils";

const mockListTasks = vi.fn();
const mockGetTaskExecutions = vi.fn();

vi.mock("../bindings", () => ({
  commands: {
    listTasks: (...args: unknown[]) => mockListTasks(...args),
    getTaskExecutions: (...args: unknown[]) => mockGetTaskExecutions(...args),
  },
}));

import { useOperationsData } from "./useOperationsData";

describe("useOperationsData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTaskStore.setState({ tasks: [], selectedTaskId: null, selectedTask: null, isLoading: false });
    useExecutionStore.setState({ executions: [] });
    mockListTasks.mockResolvedValue({ status: "ok", data: [] });
    mockGetTaskExecutions.mockResolvedValue({ status: "ok", data: [] });
  });

  it("derives attention items from task and execution stores", async () => {
    const failedTask = createMockTask({
      id: "t-fail",
      title: "Failed Task",
      workflow_id: "wf-1",
      started_at: "2025-01-01T00:00:00Z",
    });

    mockListTasks.mockResolvedValue({ status: "ok", data: [failedTask] });

    const { result } = renderHook(() => useOperationsData());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // Simulate a failed execution arriving via WebSocket into the execution store
    const failedExec = createMockStepExecution({
      id: "e-fail",
      task_id: "t-fail",
      status: "failed",
    });

    act(() => {
      useExecutionStore.getState().upsertExecution(failedExec);
    });

    expect(result.current.attentionItems).toHaveLength(1);
    expect(result.current.attentionItems[0].kind).toBe("failed_execution");
    expect(result.current.attentionItems[0].task.id).toBe("t-fail");
  });

  it("derives live items from task and execution stores", async () => {
    const runningTask = createMockTask({
      id: "t-run",
      title: "Running Task",
      workflow_id: "wf-1",
      step_name: "in_progress",
      started_at: "2025-01-01T00:00:00Z",
    });

    mockListTasks.mockResolvedValue({ status: "ok", data: [runningTask] });

    const { result } = renderHook(() => useOperationsData());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    const runningExec = createMockStepExecution({
      id: "e-run",
      task_id: "t-run",
      status: "in_progress",
      step_name: "in_progress",
    });

    act(() => {
      useExecutionStore.getState().upsertExecution(runningExec);
    });

    expect(result.current.liveItems).toHaveLength(1);
    expect(result.current.liveItems[0].task.id).toBe("t-run");
    expect(result.current.liveItems[0].execution.status).toBe("in_progress");
  });

  it("derives ready tasks from task store dependency data", async () => {
    const readyTask = createMockTask({
      id: "t-ready",
      title: "Ready to Start",
      started_at: null,
      completed_at: null,
      archived: false,
      dependency_ids: [],
    });

    mockListTasks.mockResolvedValue({ status: "ok", data: [readyTask] });

    const { result } = renderHook(() => useOperationsData());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.readyTasks).toHaveLength(1);
    expect(result.current.readyTasks[0].id).toBe("t-ready");
    expect(result.current.readyTasks[0].title).toBe("Ready to Start");
  });

  it("reflects new tasks upserted externally into the task store", async () => {
    mockListTasks.mockResolvedValue({ status: "ok", data: [] });

    const { result } = renderHook(() => useOperationsData());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.readyTasks).toHaveLength(0);

    // Simulate a new task arriving via WebSocket upsert
    const newTask = createMockTask({
      id: "t-ws",
      title: "WebSocket Task",
      started_at: null,
      completed_at: null,
      archived: false,
      dependency_ids: [],
    });

    act(() => {
      useTaskStore.getState().upsertTask(newTask);
    });

    expect(result.current.readyTasks).toHaveLength(1);
    expect(result.current.readyTasks[0].id).toBe("t-ws");
  });

  it("excludes tasks with unmet dependencies from ready list", async () => {
    const blocker = createMockTask({
      id: "t-blocker",
      title: "Blocker",
      started_at: "2025-01-01T00:00:00Z",
      completed_at: null,
      archived: false,
      dependency_ids: [],
    });

    const blocked = createMockTask({
      id: "t-blocked",
      title: "Blocked Task",
      started_at: null,
      completed_at: null,
      archived: false,
      dependency_ids: ["t-blocker"],
    });

    mockListTasks.mockResolvedValue({ status: "ok", data: [blocker, blocked] });

    const { result } = renderHook(() => useOperationsData());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // Only tasks with no unmet deps should be ready; blocker is started so not ready,
    // blocked has an incomplete dependency
    const readyIds = result.current.readyTasks.map((t) => t.id);
    expect(readyIds).not.toContain("t-blocked");
  });

  it("includes review-request tasks in attention items from store", async () => {
    const reviewTask = createMockTask({
      id: "t-review",
      title: "Needs Review",
      needs_human_review: true,
    });

    mockListTasks.mockResolvedValue({ status: "ok", data: [reviewTask] });

    const { result } = renderHook(() => useOperationsData());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.attentionItems).toHaveLength(1);
    expect(result.current.attentionItems[0].kind).toBe("review_request");
    expect(result.current.attentionItems[0].task.id).toBe("t-review");
    expect(result.current.attentionItems[0].task.title).toBe("Needs Review");
  });
});

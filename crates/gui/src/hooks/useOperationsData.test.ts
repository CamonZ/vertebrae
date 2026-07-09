import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { createMockTask, createMockTaskRun } from "../test/test-utils";
import type { StepExecution, TaskRun, TaskRunStatus } from "../bindings";
import { queryClient, queryKeys } from "../query";
import {
  getProjectScopeGeneration,
  resetProjectScopedStores,
} from "../stores/projectScopedStores";

const mockListTasks = vi.fn();
const mockGetTaskExecutions = vi.fn();

vi.mock("../bindings", () => ({
  commands: {
    listTasks: (...args: unknown[]) => mockListTasks(...args),
    getTaskExecutions: (...args: unknown[]) => mockGetTaskExecutions(...args),
  },
}));

import { useOperationsData } from "./useOperationsData";

function QueryWrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

function renderOperationsDataHook() {
  return renderHook(() => useOperationsData(), { wrapper: QueryWrapper });
}

function withActiveRun(
  taskId: string,
  status: TaskRunStatus,
  overrides: { runnable?: boolean; stoppable?: boolean } = {}
) {
  const activeRun: TaskRun = createMockTaskRun({
    id: `run-${taskId}`,
    task_id: taskId,
    status,
  });
  return {
    runnable: overrides.runnable ?? false,
    stoppable: overrides.stoppable ?? status === "executing",
    disabled_reason_code: null,
    disabled_reason: null,
    active_run: activeRun,
  };
}

describe("useOperationsData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProjectScopedStores();
    mockListTasks.mockResolvedValue({ status: "ok", data: [] });
    mockGetTaskExecutions.mockResolvedValue({ status: "ok", data: [] });
  });

  function seedTaskExecutions(taskId: string, executions: StepExecution[]) {
    queryClient.setQueryData(
      queryKeys.executions.byTask(getProjectScopeGeneration(), taskId),
      executions
    );
  }

  it("derives a failed_run attention item from run_controls.active_run with status=failed", async () => {
    const failedTask = createMockTask({
      id: "t-fail",
      title: "Failed Task",
      workflow_id: "wf-1",
      run_controls: withActiveRun("t-fail", "failed"),
    });

    mockListTasks.mockResolvedValue({ status: "ok", data: [failedTask] });

    const { result } = renderOperationsDataHook();

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.attentionItems).toHaveLength(1);
    expect(result.current.attentionItems[0].kind).toBe("failed_run");
    expect(result.current.attentionItems[0].task.id).toBe("t-fail");
    expect(result.current.attentionItems[0].taskRun?.status).toBe("failed");
  });

  // Testing criterion 2 of ticket 55e35cdc: a failed StepExecution inside an
  // active TaskRun is attempt-level history, not a failed-task signal.
  it("does NOT derive attention items from failed StepExecution rows", async () => {
    const taskWithoutFailedRun = createMockTask({
      id: "t-stale",
      title: "Stale failed exec",
      workflow_id: "wf-1",
      run_controls: withActiveRun("t-stale", "executing"),
    });

    mockListTasks.mockResolvedValue({
      status: "ok",
      data: [taskWithoutFailedRun],
    });

    const { result } = renderOperationsDataHook();

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    act(() => {
      seedTaskExecutions("t-stale", [
        {
          id: "exec-failed",
          task_id: "t-stale",
          task_run_id: "run-t-stale",
          workflow_id: "wf-1",
          step_name: "build",
          started_at: "2025-01-01T00:00:00Z",
          completed_at: "2025-01-01T00:01:00Z",
          status: "failed",
        },
      ]);
    });

    expect(
      result.current.attentionItems.filter((i) => i.kind === "failed_run")
    ).toHaveLength(0);
  });

  // Testing criterion 1 of ticket 55e35cdc: a waiting TaskRun must show up
  // under live operations alongside queued/executing runs.
  it("derives live items from tasks whose active_run is queued/executing/waiting", async () => {
    const queuedTask = createMockTask({
      id: "t-queued",
      title: "Queued",
      workflow_id: "wf-1",
      run_controls: withActiveRun("t-queued", "queued"),
    });
    const executingTask = createMockTask({
      id: "t-exec",
      title: "Executing",
      workflow_id: "wf-1",
      run_controls: withActiveRun("t-exec", "executing"),
    });
    const waitingTask = createMockTask({
      id: "t-wait",
      title: "Waiting",
      workflow_id: "wf-1",
      run_controls: withActiveRun("t-wait", "waiting"),
    });
    const stoppingTask = createMockTask({
      id: "t-stop",
      title: "Stopping",
      workflow_id: "wf-1",
      run_controls: withActiveRun("t-stop", "stopping", { stoppable: false }),
    });

    mockListTasks.mockResolvedValue({
      status: "ok",
      data: [queuedTask, executingTask, waitingTask, stoppingTask],
    });

    const { result } = renderOperationsDataHook();

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    const liveIds = result.current.liveItems.map((i) => i.task.id).sort();
    expect(liveIds).toEqual(["t-exec", "t-queued", "t-wait"]);
    // Stopping is intentionally excluded from Live
    expect(liveIds).not.toContain("t-stop");
  });

  it("does NOT derive live items from in_progress StepExecution rows when there is no active TaskRun", async () => {
    const idleTaskWithLegacyExec = createMockTask({
      id: "t-idle",
      title: "Idle",
      workflow_id: "wf-1",
      step_name: "in_progress",
      run_controls: null,
    });

    mockListTasks.mockResolvedValue({
      status: "ok",
      data: [idleTaskWithLegacyExec],
    });

    const { result } = renderOperationsDataHook();

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    act(() => {
      seedTaskExecutions("t-idle", [
        {
          id: "exec-running",
          task_id: "t-idle",
          task_run_id: null,
          workflow_id: "wf-1",
          step_name: "in_progress",
          started_at: "2025-01-01T00:00:00Z",
          completed_at: null,
          status: "in_progress",
        },
      ]);
    });

    expect(result.current.liveItems).toHaveLength(0);
  });

  it("derives recently completed items from by-task execution queries", async () => {
    const completedTask = createMockTask({
      id: "t-completed",
      title: "Completed Task",
      workflow_id: "wf-1",
      run_controls: withActiveRun("t-completed", "completed"),
    });
    const execution: StepExecution = {
      id: "exec-completed",
      task_id: "t-completed",
      task_run_id: "run-t-completed",
      workflow_id: "wf-1",
      step_name: "implement",
      started_at: "2025-01-01T00:00:00Z",
      completed_at: "2025-01-01T00:01:00Z",
      status: "completed",
    };

    mockListTasks.mockResolvedValue({
      status: "ok",
      data: [completedTask],
    });
    mockGetTaskExecutions.mockResolvedValue({
      status: "ok",
      data: [execution],
    });

    const { result } = renderOperationsDataHook();

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(mockGetTaskExecutions).toHaveBeenCalledWith("t-completed");
    expect(result.current.completedItems).toEqual([
      { task: completedTask, execution },
    ]);
  });

  it("keeps recently completed items from previously observed execution queries", async () => {
    const completedTask = createMockTask({
      id: "t-completed",
      title: "Completed Task",
      workflow_id: "wf-1",
      run_controls: null,
    });
    const execution: StepExecution = {
      id: "exec-completed",
      task_id: "t-completed",
      task_run_id: "run-t-completed",
      workflow_id: "wf-1",
      step_name: "implement",
      started_at: "2025-01-01T00:00:00Z",
      completed_at: "2025-01-01T00:01:00Z",
      status: "completed",
    };

    seedTaskExecutions("t-completed", [execution]);
    mockListTasks.mockResolvedValue({
      status: "ok",
      data: [completedTask],
    });
    mockGetTaskExecutions.mockResolvedValue({
      status: "ok",
      data: [execution],
    });

    const { result } = renderOperationsDataHook();

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(mockGetTaskExecutions).not.toHaveBeenCalled();
    expect(result.current.completedItems).toEqual([
      { task: completedTask, execution },
    ]);
  });

  it("refetches remembered completed executions after the query cache entry is removed", async () => {
    const activeTask = createMockTask({
      id: "t-completed",
      title: "Completed Task",
      workflow_id: "wf-1",
      run_controls: withActiveRun("t-completed", "completed"),
    });
    const idleTask = createMockTask({
      ...activeTask,
      run_controls: null,
    });
    const execution: StepExecution = {
      id: "exec-completed",
      task_id: "t-completed",
      task_run_id: "run-t-completed",
      workflow_id: "wf-1",
      step_name: "implement",
      started_at: "2025-01-01T00:00:00Z",
      completed_at: "2025-01-01T00:01:00Z",
      status: "completed",
    };

    mockListTasks.mockResolvedValue({
      status: "ok",
      data: [activeTask],
    });
    mockGetTaskExecutions.mockResolvedValue({
      status: "ok",
      data: [execution],
    });

    const firstRender = renderOperationsDataHook();

    await waitFor(() => {
      expect(firstRender.result.current.isLoading).toBe(false);
    });
    expect(firstRender.result.current.completedItems).toEqual([
      { task: activeTask, execution },
    ]);

    firstRender.unmount();
    queryClient.removeQueries({
      queryKey: queryKeys.tasks.lists(getProjectScopeGeneration()),
    });
    queryClient.removeQueries({
      queryKey: queryKeys.executions.byTask(
        getProjectScopeGeneration(),
        "t-completed"
      ),
      exact: true,
    });
    mockListTasks.mockResolvedValue({
      status: "ok",
      data: [idleTask],
    });
    mockGetTaskExecutions.mockClear();
    mockGetTaskExecutions.mockResolvedValue({
      status: "ok",
      data: [execution],
    });

    const secondRender = renderOperationsDataHook();

    await waitFor(() => {
      expect(secondRender.result.current.isLoading).toBe(false);
    });

    expect(mockGetTaskExecutions).toHaveBeenCalledWith("t-completed");
    expect(secondRender.result.current.completedItems).toEqual([
      { task: idleTask, execution },
    ]);
  });

  it("includes a task in readyTasks when run_controls.runnable is true and no active run", async () => {
    const readyTask = createMockTask({
      id: "t-ready",
      title: "Ready",
      workflow_id: "wf-1",
      run_controls: {
        runnable: true,
        stoppable: false,
        disabled_reason_code: null,
        disabled_reason: null,
        active_run: null,
      },
      dependency_ids: [],
    });

    mockListTasks.mockResolvedValue({ status: "ok", data: [readyTask] });

    const { result } = renderOperationsDataHook();

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.readyTasks.map((t) => t.id)).toEqual(["t-ready"]);
  });

  it("excludes tasks from readyTasks when run_controls.runnable is false", async () => {
    const notRunnable = createMockTask({
      id: "t-locked",
      title: "Not Runnable",
      workflow_id: "wf-1",
      run_controls: {
        runnable: false,
        stoppable: false,
        disabled_reason_code: "no_workflow",
        disabled_reason: "Workflow missing",
        active_run: null,
      },
    });

    mockListTasks.mockResolvedValue({ status: "ok", data: [notRunnable] });

    const { result } = renderOperationsDataHook();

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.readyTasks).toHaveLength(0);
  });

  it("excludes tasks with an active run from readyTasks even if started_at is unset", async () => {
    const running = createMockTask({
      id: "t-running",
      title: "Running",
      workflow_id: "wf-1",
      started_at: null,
      run_controls: withActiveRun("t-running", "executing"),
    });

    mockListTasks.mockResolvedValue({ status: "ok", data: [running] });

    const { result } = renderOperationsDataHook();

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.readyTasks).toHaveLength(0);
  });

  it("excludes tasks whose blockers have no completed_at or completed run", async () => {
    const blocker = createMockTask({
      id: "t-blocker",
      title: "Blocker",
      workflow_id: "wf-1",
      run_controls: null,
      step_name: "done",
      completed_at: null,
    });
    const blocked = createMockTask({
      id: "t-blocked",
      title: "Blocked",
      workflow_id: "wf-1",
      run_controls: {
        runnable: true,
        stoppable: false,
        disabled_reason_code: null,
        disabled_reason: null,
        active_run: null,
      },
      dependency_ids: ["t-blocker"],
    });

    mockListTasks.mockResolvedValue({
      status: "ok",
      data: [blocker, blocked],
    });

    const { result } = renderOperationsDataHook();

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.readyTasks.map((t) => t.id)).not.toContain(
      "t-blocked"
    );
  });

  it("includes a task whose blocker has a completed run", async () => {
    const blocker = createMockTask({
      id: "t-blocker",
      title: "Blocker",
      workflow_id: "wf-1",
      run_controls: withActiveRun("t-blocker", "completed"),
    });
    const blocked = createMockTask({
      id: "t-blocked",
      title: "Blocked",
      workflow_id: "wf-1",
      run_controls: {
        runnable: true,
        stoppable: false,
        disabled_reason_code: null,
        disabled_reason: null,
        active_run: null,
      },
      dependency_ids: ["t-blocker"],
    });

    mockListTasks.mockResolvedValue({
      status: "ok",
      data: [blocker, blocked],
    });

    const { result } = renderOperationsDataHook();

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.readyTasks.map((t) => t.id)).toContain("t-blocked");
  });

  it("includes a task whose blocker has completed_at even without a completed run", async () => {
    const blocker = createMockTask({
      id: "t-blocker",
      title: "Blocker",
      workflow_id: "wf-1",
      run_controls: null,
      step_name: "review",
      completed_at: "2026-01-01T00:00:00Z",
    });
    const blocked = createMockTask({
      id: "t-blocked",
      title: "Blocked",
      workflow_id: "wf-1",
      run_controls: {
        runnable: true,
        stoppable: false,
        disabled_reason_code: null,
        disabled_reason: null,
        active_run: null,
      },
      dependency_ids: ["t-blocker"],
    });

    mockListTasks.mockResolvedValue({
      status: "ok",
      data: [blocker, blocked],
    });

    const { result } = renderOperationsDataHook();

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.readyTasks.map((t) => t.id)).toContain("t-blocked");
  });
});

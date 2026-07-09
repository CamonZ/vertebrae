import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StepExecutionChangedEvent, TaskRunTrace } from "../bindings";
import { queryClient, queryKeys } from "../query";
import {
  getProjectScopeGeneration,
  resetProjectScopedStores,
} from "../stores/projectScopedStores";
import { createMockStepExecution } from "../test/test-utils";

const mockGetTaskExecutions = vi.fn();
const stepExecutionChangedListen = vi.fn();

let stepExecutionChangedHandler:
  ((event: { payload: StepExecutionChangedEvent }) => void) | null = null;

vi.mock("../bindings", () => ({
  commands: {
    getTaskExecutions: (...args: unknown[]) => mockGetTaskExecutions(...args),
  },
  events: {
    stepExecutionChangedEvent: {
      listen: (
        handler: (event: { payload: StepExecutionChangedEvent }) => void
      ) => {
        stepExecutionChangedHandler = handler;
        stepExecutionChangedListen(handler);
        return Promise.resolve(() => {});
      },
    },
  },
}));

import { useStepExecutionChangeListener } from "./useStepExecutionChangeListener";

function emitStepExecutionChanged(payload: StepExecutionChangedEvent) {
  if (!stepExecutionChangedHandler) {
    throw new Error("stepExecutionChanged handler missing");
  }
  act(() => {
    stepExecutionChangedHandler!({ payload });
  });
}

describe("useStepExecutionChangeListener", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "debug").mockImplementation(() => {});
    resetProjectScopedStores();
  });

  it("upserts execution payloads directly", async () => {
    const generation = getProjectScopeGeneration();
    const execution = createMockStepExecution({
      id: "exec-1",
      task_id: "task-1",
      task_run_id: "run-1",
      status: "in_progress",
    });
    queryClient.setQueryData(
      queryKeys.executions.byTask(generation, "task-1"),
      []
    );
    queryClient.setQueryData<TaskRunTrace>(
      queryKeys.executions.byRun(generation, "run-1"),
      {
        root_task_run_id: "run-1",
        task_runs: [],
        step_executions: [],
        session_logs: [],
      }
    );

    renderHook(() => useStepExecutionChangeListener());
    await waitFor(() => {
      expect(stepExecutionChangedListen).toHaveBeenCalledTimes(1);
    });

    emitStepExecutionChanged({
      execution_id: "exec-1",
      task_id: "task-1",
      task_run_id: "run-1",
      workflow_id: "workflow-1",
      step_name: "implement",
      status: "Running",
      change_type: "Created",
      execution,
    });

    expect(
      queryClient.getQueryData(
        queryKeys.executions.byTask(generation, "task-1")
      )
    ).toEqual([execution]);
    expect(
      queryClient.getQueryData<TaskRunTrace>(
        queryKeys.executions.byRun(generation, "run-1")
      )?.step_executions
    ).toEqual([execution]);
  });

  it("refetches task executions when the websocket payload omits execution", async () => {
    const generation = getProjectScopeGeneration();
    const execution = createMockStepExecution({
      id: "exec-fetched",
      task_id: "task-1",
      task_run_id: "run-1",
      status: "in_progress",
    });
    queryClient.setQueryData(
      queryKeys.executions.byTask(generation, "task-1"),
      []
    );
    queryClient.setQueryData<TaskRunTrace>(
      queryKeys.executions.byRun(generation, "run-1"),
      {
        root_task_run_id: "run-1",
        task_runs: [],
        step_executions: [],
        session_logs: [],
      }
    );
    mockGetTaskExecutions.mockResolvedValue({
      status: "ok",
      data: [execution],
    });

    renderHook(() => useStepExecutionChangeListener());
    await waitFor(() => {
      expect(stepExecutionChangedListen).toHaveBeenCalledTimes(1);
    });

    emitStepExecutionChanged({
      execution_id: "exec-fetched",
      task_id: "task-1",
      task_run_id: "run-1",
      workflow_id: "workflow-1",
      step_name: "implement",
      status: "Running",
      change_type: "Created",
      execution: null,
    });

    await waitFor(() => {
      expect(mockGetTaskExecutions).toHaveBeenCalledWith("task-1");
    });
    await waitFor(() => {
      expect(
        queryClient.getQueryData(
          queryKeys.executions.byTask(generation, "task-1")
        )
      ).toEqual([execution]);
      expect(
        queryClient.getQueryData<TaskRunTrace>(
          queryKeys.executions.byRun(generation, "run-1")
        )?.step_executions
      ).toEqual([execution]);
    });
  });

  it("falls back to execution.task_run_id when the event task_run_id is missing", async () => {
    const generation = getProjectScopeGeneration();
    const execution = createMockStepExecution({
      id: "exec-1",
      task_id: "task-1",
      task_run_id: "run-1",
      status: "in_progress",
    });
    queryClient.setQueryData(
      queryKeys.executions.byTask(generation, "task-1"),
      []
    );
    queryClient.setQueryData<TaskRunTrace>(
      queryKeys.executions.byRun(generation, "run-1"),
      {
        root_task_run_id: "run-1",
        task_runs: [],
        step_executions: [],
        session_logs: [],
      }
    );

    renderHook(() => useStepExecutionChangeListener());
    await waitFor(() => {
      expect(stepExecutionChangedListen).toHaveBeenCalledTimes(1);
    });

    emitStepExecutionChanged({
      execution_id: "exec-1",
      task_id: "task-1",
      task_run_id: "",
      workflow_id: "workflow-1",
      step_name: "implement",
      status: "Running",
      change_type: "Created",
      execution,
    });

    expect(
      queryClient.getQueryData<TaskRunTrace>(
        queryKeys.executions.byRun(generation, "run-1")
      )?.step_executions
    ).toEqual([execution]);
  });

  it("does not route run-less fetched executions into the event run", async () => {
    const generation = getProjectScopeGeneration();
    const execution = createMockStepExecution({
      id: "exec-runless",
      task_id: "task-1",
      task_run_id: null,
      status: "in_progress",
    });
    queryClient.setQueryData(
      queryKeys.executions.byTask(generation, "task-1"),
      []
    );
    queryClient.setQueryData<TaskRunTrace>(
      queryKeys.executions.byRun(generation, "run-event"),
      {
        root_task_run_id: "run-event",
        task_runs: [],
        step_executions: [],
        session_logs: [],
      }
    );
    mockGetTaskExecutions.mockResolvedValue({
      status: "ok",
      data: [execution],
    });

    renderHook(() => useStepExecutionChangeListener());
    await waitFor(() => {
      expect(stepExecutionChangedListen).toHaveBeenCalledTimes(1);
    });

    emitStepExecutionChanged({
      execution_id: "exec-runless",
      task_id: "task-1",
      task_run_id: "run-event",
      workflow_id: "workflow-1",
      step_name: "implement",
      status: "Running",
      change_type: "StatusChanged",
      execution: null,
    });

    await waitFor(() => {
      expect(
        queryClient.getQueryData(
          queryKeys.executions.byTask(generation, "task-1")
        )
      ).toEqual([execution]);
    });
    expect(
      queryClient.getQueryData<TaskRunTrace>(
        queryKeys.executions.byRun(generation, "run-event")
      )?.step_executions
    ).toEqual([]);
  });
});

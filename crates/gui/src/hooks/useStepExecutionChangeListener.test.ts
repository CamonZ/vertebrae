import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StepExecutionChangedEvent } from "../bindings";
import { useExecutionStore } from "../stores";
import { resetProjectScopedStores } from "../stores/projectScopedStores";
import { createMockStepExecution } from "../test/test-utils";

const mockGetTaskExecutions = vi.fn();
const stepExecutionChangedListen = vi.fn();

let stepExecutionChangedHandler:
  | ((event: { payload: StepExecutionChangedEvent }) => void)
  | null = null;

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
    const execution = createMockStepExecution({
      id: "exec-1",
      task_id: "task-1",
      task_run_id: "run-1",
      status: "in_progress",
    });

    renderHook(() => useStepExecutionChangeListener());
    await waitFor(() => {
      expect(stepExecutionChangedListen).toHaveBeenCalledTimes(1);
    });

    emitStepExecutionChanged({
      execution_id: "exec-1",
      task_id: "task-1",
      workflow_id: "workflow-1",
      step_name: "implement",
      status: "Running",
      change_type: "Created",
      execution,
    });

    expect(useExecutionStore.getState().executions).toEqual([execution]);
  });

  it("refetches task executions when the websocket payload omits execution", async () => {
    const execution = createMockStepExecution({
      id: "exec-fetched",
      task_id: "task-1",
      task_run_id: "run-1",
      status: "in_progress",
    });
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
      expect(useExecutionStore.getState().executions).toEqual([execution]);
    });
  });
});

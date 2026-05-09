import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { createMockTask, createMockTaskRun } from "../test/test-utils";

type EventCallback = (event: { payload: Record<string, unknown> }) => void;

const { mockEvents, eventListeners, emitEvent } = vi.hoisted(() => {
  const listeners: Record<string, EventCallback[]> = {};

  function createEventListener(eventName: string) {
    return {
      listen: vi.fn((callback: EventCallback) => {
        listeners[eventName] = listeners[eventName] || [];
        listeners[eventName].push(callback);
        return Promise.resolve(() => {
          const idx = listeners[eventName].indexOf(callback);
          if (idx > -1) listeners[eventName].splice(idx, 1);
        });
      }),
    };
  }

  return {
    mockEvents: {
      taskRunChangedEvent: createEventListener("taskRunChanged"),
    },
    eventListeners: listeners,
    emitEvent: (eventName: string, payload: Record<string, unknown>) => {
      const callbacks = listeners[eventName] || [];
      callbacks.forEach((callback) => callback({ payload }));
    },
  };
});

vi.mock("../bindings", () => ({
  events: mockEvents,
}));

import { useTaskRunChangeListener } from "./useTaskRunChangeListener";
import { useTaskRunStore, useTaskStore } from "../stores";

describe("useTaskRunChangeListener", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(eventListeners).forEach((key) => {
      eventListeners[key] = [];
    });
    useTaskRunStore.setState({ taskRuns: [], taskRunsByTaskId: {} });
    useTaskStore.setState({
      tasks: [],
      selectedTaskId: null,
      selectedTask: null,
      isLoading: false,
    });
  });

  it("upserts the TaskRun and replaces task run_controls from the payload", async () => {
    const task = createMockTask({ id: "task-1", run_controls: null });
    const taskRun = createMockTaskRun({
      id: "run-1",
      task_id: "task-1",
      status: "executing",
    });
    const runControls = {
      runnable: false,
      stoppable: true,
      disabled_reason_code: "active_run",
      disabled_reason: "A TaskRun is already active",
      active_run: taskRun,
    };
    useTaskStore.getState().setTasks([task]);

    renderHook(() => useTaskRunChangeListener());
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      emitEvent("taskRunChanged", {
        task_run_id: "run-1",
        task_id: "task-1",
        status: "executing",
        change_type: "Updated",
        task_run: taskRun,
        run_controls: runControls,
      });
    });

    const runState = useTaskRunStore.getState();
    expect(runState.taskRuns.map((run) => run.id)).toEqual(["run-1"]);
    expect(runState.taskRunsByTaskId["task-1"][0]).toEqual(taskRun);

    const taskState = useTaskStore.getState();
    expect(taskState.tasks[0].run_controls).toEqual(runControls);
    expect(taskState.tasks[0].run_controls?.active_run?.id).toBe("run-1");
  });

  it("replaces selectedTask controls without requiring a task refetch", async () => {
    const task = createMockTask({ id: "task-selected", run_controls: null });
    const taskRun = createMockTaskRun({
      id: "run-selected",
      task_id: "task-selected",
    });
    const runControls = {
      runnable: false,
      stoppable: true,
      disabled_reason_code: "active_run",
      disabled_reason: "A TaskRun is already active",
      active_run: taskRun,
    };
    useTaskStore.getState().setTasks([task]);
    useTaskStore.getState().selectTask("task-selected", task);

    renderHook(() => useTaskRunChangeListener());
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      emitEvent("taskRunChanged", {
        task_run_id: "run-selected",
        task_id: "task-selected",
        status: "executing",
        change_type: "Updated",
        task_run: taskRun,
        run_controls: runControls,
      });
    });

    expect(useTaskStore.getState().selectedTask?.run_controls).toEqual(
      runControls
    );
  });

  it("applies null run_controls from the payload", async () => {
    const taskRun = createMockTaskRun({
      id: "run-completed",
      task_id: "task-1",
      status: "completed",
    });
    const task = createMockTask({
      id: "task-1",
      run_controls: {
        runnable: false,
        stoppable: true,
        disabled_reason_code: "active_run",
        disabled_reason: "A TaskRun is already active",
        active_run: taskRun,
      },
    });
    useTaskStore.getState().setTasks([task]);

    renderHook(() => useTaskRunChangeListener());
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      emitEvent("taskRunChanged", {
        task_run_id: "run-completed",
        task_id: "task-1",
        status: "completed",
        change_type: "Updated",
        task_run: taskRun,
        run_controls: null,
      });
    });

    expect(useTaskStore.getState().tasks[0].run_controls).toBeNull();
    expect(useTaskRunStore.getState().taskRuns[0].status).toBe("completed");
  });

  it("still replaces task controls when the TaskRun entity is absent", async () => {
    const task = createMockTask({ id: "task-1", run_controls: null });
    const activeRun = createMockTaskRun({
      id: "run-active",
      task_id: "task-1",
    });
    const runControls = {
      runnable: false,
      stoppable: true,
      disabled_reason_code: "active_run",
      disabled_reason: "A TaskRun is already active",
      active_run: activeRun,
    };
    useTaskStore.getState().setTasks([task]);

    renderHook(() => useTaskRunChangeListener());
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      emitEvent("taskRunChanged", {
        task_run_id: "run-active",
        task_id: "task-1",
        status: "executing",
        change_type: "Updated",
        task_run: null,
        run_controls: runControls,
      });
    });

    expect(useTaskRunStore.getState().taskRuns).toEqual([]);
    expect(useTaskStore.getState().tasks[0].run_controls).toEqual(runControls);
  });

  it("does not register when disabled", async () => {
    renderHook(() => useTaskRunChangeListener({ enabled: false }));

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockEvents.taskRunChangedEvent.listen).not.toHaveBeenCalled();
  });

  it("cleans up the listener on unmount", async () => {
    const { unmount } = renderHook(() => useTaskRunChangeListener());

    await act(async () => {
      await Promise.resolve();
    });

    expect(eventListeners["taskRunChanged"]).toHaveLength(1);

    unmount();

    await act(async () => {
      await Promise.resolve();
    });

    expect(eventListeners["taskRunChanged"]).toHaveLength(0);
  });
});

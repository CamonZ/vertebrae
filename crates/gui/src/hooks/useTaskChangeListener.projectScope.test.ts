import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskChangedEvent } from "../bindings";
import { resetProjectScopedStores } from "../stores/projectScopedStores";
import { useTaskStore } from "../stores/taskStore";
import { useToastStore } from "../stores/toastStore";
import { createMockTask } from "../test/test-utils";

const mockListen = vi.fn();

vi.mock("../bindings", () => ({
  commands: {
    getTask: vi.fn(),
  },
  events: {
    taskChangedEvent: {
      listen: (...args: unknown[]) => mockListen(...args),
    },
    taskStepChangedEvent: {
      listen: vi.fn(async () => vi.fn()),
    },
    taskRunStepChangedEvent: {
      listen: vi.fn(async () => vi.fn()),
    },
  },
}));

import { useTaskChangeListener } from "./useTaskChangeListener";

describe("useTaskChangeListener project scope hygiene", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "debug").mockImplementation(() => {});
    resetProjectScopedStores();
    useToastStore.getState().clearToasts();
    mockListen.mockImplementation(async () => vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ignores task events delivered to a stale listener after project reset", async () => {
    const handlers: Array<(event: { payload: TaskChangedEvent }) => void> = [];
    mockListen.mockImplementation(async (handler) => {
      handlers.push(handler as (event: { payload: TaskChangedEvent }) => void);
      return vi.fn();
    });

    renderHook(() => useTaskChangeListener());

    await waitFor(() => {
      expect(mockListen).toHaveBeenCalledTimes(1);
    });
    const staleHandler = handlers[0];

    act(() => {
      resetProjectScopedStores();
    });

    await waitFor(() => {
      expect(mockListen).toHaveBeenCalledTimes(2);
    });
    const currentHandler = handlers[1];

    const staleTask = createMockTask({
      id: "old-project-task",
      title: "Old Project Task",
    });
    act(() => {
      staleHandler({
        payload: {
          task_id: staleTask.id,
          change_type: "Created",
          task: staleTask,
          current_step_id: null,
          workflow_id: null,
          level: null,
          archived: null,
        },
      });
    });

    expect(useTaskStore.getState().tasks).toEqual([]);

    const currentTask = createMockTask({
      id: "new-project-task",
      title: "New Project Task",
      workflow_name: "Workflow",
      current_step_id: "step-todo",
      step_name: "todo",
    });
    act(() => {
      currentHandler({
        payload: {
          task_id: currentTask.id,
          change_type: "Created",
          task: currentTask,
          current_step_id: null,
          workflow_id: null,
          level: null,
          archived: null,
        },
      });
    });

    expect(useTaskStore.getState().tasks.map((task) => task.id)).toEqual([
      "new-project-task",
    ]);
  });
});

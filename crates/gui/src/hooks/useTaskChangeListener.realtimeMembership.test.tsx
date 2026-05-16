import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  TaskChangedEvent,
  TaskRunStepChangedEvent,
  TaskStepChangedEvent,
} from "../bindings";
import { resetProjectScopedStores } from "../stores/projectScopedStores";
import { useTaskStore } from "../stores/taskStore";
import { useToastStore } from "../stores/toastStore";
import { createMockTask } from "../test/test-utils";

const mockGetTask = vi.fn();
const taskChangedListen = vi.fn();
const taskStepChangedListen = vi.fn();
const taskRunStepChangedListen = vi.fn();

let taskChangedHandler: ((event: { payload: TaskChangedEvent }) => void) | null =
  null;
let taskStepChangedHandler:
  | ((event: { payload: TaskStepChangedEvent }) => void)
  | null = null;
let taskRunStepChangedHandler:
  | ((event: { payload: TaskRunStepChangedEvent }) => void)
  | null = null;

vi.mock("../bindings", () => ({
  commands: {
    getTask: (...args: unknown[]) => mockGetTask(...args),
  },
  events: {
    taskChangedEvent: {
      listen: (handler: (event: { payload: TaskChangedEvent }) => void) => {
        taskChangedHandler = handler;
        taskChangedListen(handler);
        return Promise.resolve(() => {});
      },
    },
    taskStepChangedEvent: {
      listen: (handler: (event: { payload: TaskStepChangedEvent }) => void) => {
        taskStepChangedHandler = handler;
        taskStepChangedListen(handler);
        return Promise.resolve(() => {});
      },
    },
    taskRunStepChangedEvent: {
      listen: (
        handler: (event: { payload: TaskRunStepChangedEvent }) => void,
      ) => {
        taskRunStepChangedHandler = handler;
        taskRunStepChangedListen(handler);
        return Promise.resolve(() => {});
      },
    },
  },
}));

import { useTaskChangeListener } from "./useTaskChangeListener";

function emitTaskChanged(payload: TaskChangedEvent) {
  if (!taskChangedHandler) throw new Error("taskChanged handler missing");
  act(() => {
    taskChangedHandler!({ payload });
  });
}

function emitTaskStepChanged(payload: TaskStepChangedEvent) {
  if (!taskStepChangedHandler) throw new Error("taskStepChanged handler missing");
  act(() => {
    taskStepChangedHandler!({ payload });
  });
}

function emitTaskRunStepChanged(payload: TaskRunStepChangedEvent) {
  if (!taskRunStepChangedHandler) {
    throw new Error("taskRunStepChanged handler missing");
  }
  act(() => {
    taskRunStepChangedHandler!({ payload });
  });
}

describe("useTaskChangeListener realtime list membership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    taskChangedHandler = null;
    taskStepChangedHandler = null;
    taskRunStepChangedHandler = null;
    resetProjectScopedStores();
    useToastStore.getState().clearToasts();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("updates task row projection after a manual taskStepChangedEvent", async () => {
    const original = createMockTask({
      id: "task-step",
      workflow_id: "workflow-1",
      workflow_name: "Workflow",
      current_step_id: "step-todo",
      step_name: "todo",
    });
    const updated = {
      ...original,
      current_step_id: "step-review",
      step_name: "pending_review",
    };
    useTaskStore.getState().setActiveFilter({
      step_names: null,
      levels: null,
      tags: null,
      root_only: null,
      children_of: null,
      include_done: true,
      search: null,
      workflow_id: null,
      step_id: null,
    });
    useTaskStore.getState().setTasks([original]);
    mockGetTask.mockResolvedValue({ status: "ok", data: updated });

    renderHook(() => useTaskChangeListener());

    await waitFor(() => {
      expect(taskStepChangedListen).toHaveBeenCalledTimes(1);
    });

    emitTaskStepChanged({
      task_id: "task-step",
      from_step_id: "step-todo",
      to_step_id: "step-review",
      workflow_id: "workflow-1",
      level: "ticket",
    });

    await waitFor(() => {
      expect(useTaskStore.getState().tasks[0].step_name).toBe(
        "pending_review",
      );
    });
    expect(useTaskStore.getState().tasks[0]).toMatchObject({
      id: "task-step",
      workflow_id: "workflow-1",
      workflow_name: "Workflow",
      current_step_id: "step-review",
      step_name: "pending_review",
    });
  });

  it("updates flat and tree-derived task data after a taskRunStepChangedEvent", async () => {
    const parent = createMockTask({
      id: "parent",
      title: "Parent",
      level: "epic",
      current_step_id: "step-todo",
      step_name: "todo",
    });
    const child = createMockTask({
      id: "child",
      title: "Child",
      parent_id: "parent",
      current_step_id: "step-todo",
      step_name: "todo",
    });
    const updatedChild = {
      ...child,
      current_step_id: "step-review",
      step_name: "review",
    };
    useTaskStore.getState().setTasks([parent, child]);
    mockGetTask.mockResolvedValue({ status: "ok", data: updatedChild });

    renderHook(() => useTaskChangeListener());

    await waitFor(() => {
      expect(taskRunStepChangedListen).toHaveBeenCalledTimes(1);
    });

    emitTaskRunStepChanged({
      task_run_id: "run-1",
      task_id: "child",
      from_step_id: "step-todo",
      to_step_id: "step-review",
      status: "executing",
      level: "task",
    });

    await waitFor(() => {
      expect(
        useTaskStore.getState().tasks.find((task) => task.id === "child")
          ?.step_name,
      ).toBe("review");
    });

    const flat = useTaskStore.getState().tasks;
    const treeChild = flat
      .filter((task) => task.parent_id === "parent")
      .find((task) => task.id === "child");
    expect(treeChild?.current_step_id).toBe("step-review");
  });

  it("preserves active filters for created, updated, archived, and deleted task events", async () => {
    const visible = createMockTask({
      id: "visible",
      title: "Visible work",
      level: "ticket",
      workflow_id: "workflow-1",
      current_step_id: "step-todo",
      step_name: "todo",
    });
    useTaskStore.getState().setActiveFilter({
      step_names: ["todo"],
      levels: ["ticket"],
      tags: null,
      root_only: null,
      children_of: null,
      include_done: false,
      search: "visible",
      workflow_id: "workflow-1",
      step_id: "step-todo",
    });
    useTaskStore.getState().setTasks([visible]);

    renderHook(() => useTaskChangeListener());
    await waitFor(() => {
      expect(taskChangedListen).toHaveBeenCalledTimes(1);
    });

    const wrongSearch = createMockTask({
      id: "wrong-search",
      title: "Hidden work",
      level: "ticket",
      workflow_id: "workflow-1",
      current_step_id: "step-todo",
      step_name: "todo",
    });
    emitTaskChanged({
      task_id: "wrong-search",
      change_type: "Created",
      task: wrongSearch,
      current_step_id: "step-todo",
      workflow_id: "workflow-1",
      level: "ticket",
      archived: false,
    });
    expect(useTaskStore.getState().tasks.map((task) => task.id)).toEqual([
      "visible",
    ]);

    const movedToDone = { ...visible, step_name: "done" };
    emitTaskChanged({
      task_id: "visible",
      change_type: "Updated",
      task: movedToDone,
      current_step_id: "step-done",
      workflow_id: "workflow-1",
      level: "ticket",
      archived: false,
    });
    expect(useTaskStore.getState().tasks).toEqual([]);

    const archived = { ...visible, archived: true };
    useTaskStore.getState().setTasks([visible]);
    emitTaskChanged({
      task_id: "visible",
      change_type: "Updated",
      task: archived,
      current_step_id: "step-todo",
      workflow_id: "workflow-1",
      level: "ticket",
      archived: true,
    });
    expect(useTaskStore.getState().tasks).toEqual([]);

    useTaskStore.getState().setTasks([visible]);
    emitTaskChanged({
      task_id: "visible",
      change_type: "Deleted",
      task: null,
      current_step_id: "step-todo",
      workflow_id: "workflow-1",
      level: "ticket",
      archived: false,
    });
    expect(useTaskStore.getState().tasks).toEqual([]);
  });
});

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Task,
  TaskChangedEvent,
  TaskFilterOptions,
  TaskRunStepChangedEvent,
  TaskStepChangedEvent,
} from "../bindings";
import {
  getProjectScopeGeneration,
  resetProjectScopedStores,
} from "../stores/projectScopedStores";
import { useToastStore } from "../stores/toastStore";
import { queryClient, queryKeys } from "../query";
import { createMockTask } from "../test/test-utils";

const mockGetTask = vi.fn();
const taskChangedListen = vi.fn();
const taskStepChangedListen = vi.fn();
const taskRunStepChangedListen = vi.fn();

let taskChangedHandler:
  | ((event: { payload: TaskChangedEvent }) => void)
  | null = null;
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
        handler: (event: { payload: TaskRunStepChangedEvent }) => void
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
  if (!taskStepChangedHandler)
    throw new Error("taskStepChanged handler missing");
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

function taskFilter(
  overrides: Partial<TaskFilterOptions> = {}
): TaskFilterOptions {
  return {
    step_names: null,
    levels: null,
    tags: null,
    root_only: null,
    children_of: null,
    search: null,
    workflow_id: null,
    step_id: null,
    ...overrides,
  };
}

function seedTaskList(tasks: Task[], filter = taskFilter()) {
  queryClient.setQueryData(
    queryKeys.tasks.list(getProjectScopeGeneration(), filter),
    tasks
  );
}

function cachedTasks(filter = taskFilter()): Task[] {
  return (
    queryClient.getQueryData<Task[]>(
      queryKeys.tasks.list(getProjectScopeGeneration(), filter)
    ) ?? []
  );
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
    seedTaskList([original]);

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
      expect(cachedTasks()[0].current_step_id).toBe("step-review");
    });
    expect(cachedTasks()[0]).toMatchObject({
      id: "task-step",
      workflow_id: "workflow-1",
      workflow_name: "Workflow",
      current_step_id: "step-review",
      step_name: "todo",
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
    seedTaskList([parent, child]);

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
        cachedTasks().find((task) => task.id === "child")?.current_step_id
      ).toBe("step-review");
    });

    const flat = cachedTasks();
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
      step_type: "execute",
    });
    const filter = taskFilter({
      step_names: ["todo"],
      levels: ["ticket"],
      search: "visible",
      workflow_id: "workflow-1",
      step_id: "step-todo",
    });
    seedTaskList([visible], filter);

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
      step_type: "execute",
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
    expect(cachedTasks(filter).map((task) => task.id)).toEqual(["visible"]);

    const movedToDone = {
      ...visible,
      workflow_name: "Implementation",
      current_step_id: "step-done",
      step_name: "done",
      step_type: "execute" as const,
    };
    emitTaskChanged({
      task_id: "visible",
      change_type: "Updated",
      task: movedToDone,
      current_step_id: "step-done",
      workflow_id: "workflow-1",
      level: "ticket",
      archived: false,
    });
    expect(cachedTasks(filter)).toEqual([]);

    const archived = { ...visible, archived: true };
    seedTaskList([visible], filter);
    emitTaskChanged({
      task_id: "visible",
      change_type: "Updated",
      task: archived,
      current_step_id: "step-todo",
      workflow_id: "workflow-1",
      level: "ticket",
      archived: true,
    });
    expect(cachedTasks(filter)).toEqual([]);

    seedTaskList([visible], filter);
    emitTaskChanged({
      task_id: "visible",
      change_type: "Deleted",
      task: null,
      current_step_id: "step-todo",
      workflow_id: "workflow-1",
      level: "ticket",
      archived: false,
    });
    expect(cachedTasks(filter)).toEqual([]);
  });

  it("keeps a task visible when realtime moves it to done under the default list filter", async () => {
    const visible = createMockTask({
      id: "visible-done",
      title: "Visible done work",
      level: "ticket",
      workflow_id: "workflow-1",
      workflow_name: "Implementation",
      current_step_id: "step-todo",
      step_name: "todo",
    });
    seedTaskList([visible]);

    renderHook(() => useTaskChangeListener());
    await waitFor(() => {
      expect(taskChangedListen).toHaveBeenCalledTimes(1);
    });

    const doneTask = {
      ...visible,
      workflow_name: "Finished",
      current_step_id: "step-done",
      step_name: "done",
      step_type: "execute" as const,
    };
    emitTaskChanged({
      task_id: "visible-done",
      change_type: "Updated",
      task: doneTask,
      current_step_id: "step-done",
      workflow_id: "workflow-1",
      level: "ticket",
      archived: false,
    });

    expect(cachedTasks()).toHaveLength(1);
    expect(cachedTasks()[0]).toMatchObject({
      id: "visible-done",
      workflow_name: "Finished",
      current_step_id: "step-done",
      step_name: "done",
    });
  });

  it("does not refetch task changed events merely because location labels are missing", async () => {
    const partial = createMockTask({
      id: "needs-hydration",
      workflow_id: "workflow-1",
      workflow_name: null,
      current_step_id: "step-review",
      step_name: null,
    });
    seedTaskList([]);

    renderHook(() => useTaskChangeListener());
    await waitFor(() => {
      expect(taskChangedListen).toHaveBeenCalledTimes(1);
    });

    emitTaskChanged({
      task_id: "needs-hydration",
      change_type: "Updated",
      task: partial,
      current_step_id: "step-review",
      workflow_id: "workflow-1",
      level: "ticket",
      archived: false,
    });

    await waitFor(() => expect(cachedTasks()).toHaveLength(1));
    expect(cachedTasks()[0]).toMatchObject({
      id: "needs-hydration",
      workflow_name: null,
      step_name: null,
    });
    expect(mockGetTask).not.toHaveBeenCalled();
  });

  it("does not refetch task changed events merely because step type is missing", async () => {
    const partial = createMockTask({
      id: "needs-step-type-hydration",
      workflow_id: "workflow-1",
      workflow_name: "Implementation",
      current_step_id: "step-review",
      step_name: "review",
      step_type: null,
    });
    seedTaskList([]);

    renderHook(() => useTaskChangeListener());
    await waitFor(() => {
      expect(taskChangedListen).toHaveBeenCalledTimes(1);
    });

    emitTaskChanged({
      task_id: "needs-step-type-hydration",
      change_type: "Updated",
      task: partial,
      current_step_id: "step-review",
      workflow_id: "workflow-1",
      level: "ticket",
      archived: false,
    });

    await waitFor(() => expect(cachedTasks()).toHaveLength(1));
    expect(cachedTasks()[0]).toMatchObject({
      id: "needs-step-type-hydration",
      step_name: "review",
      step_type: null,
    });
    expect(mockGetTask).not.toHaveBeenCalled();
  });

  it("does not copy a cached embedded step_type into a new task projection", async () => {
    const cached = createMockTask({
      id: "cached-step-type",
      title: "Cached projection",
      workflow_id: "workflow-1",
      workflow_name: "Implementation",
      current_step_id: "step-review",
      step_name: "review",
      step_type: "evaluate",
    });
    seedTaskList([cached]);

    renderHook(() => useTaskChangeListener());
    await waitFor(() => {
      expect(taskChangedListen).toHaveBeenCalledTimes(1);
    });

    emitTaskChanged({
      task_id: "cached-step-type",
      change_type: "Updated",
      task: {
        ...cached,
        title: "Updated projection",
        step_type: null,
      },
      current_step_id: "step-review",
      workflow_id: "workflow-1",
      level: "ticket",
      archived: false,
    });

    expect(mockGetTask).not.toHaveBeenCalled();
    expect(cachedTasks()[0]).toMatchObject({
      id: "cached-step-type",
      title: "Updated projection",
      current_step_id: "step-review",
      step_type: null,
    });
    expect(cachedTasks()[0].step_type).toBeNull();
  });

  it("hydrates routable task payloads when empty arrays would clear cached data", async () => {
    const existing = createMockTask({
      id: "lean-empty-arrays",
      workflow_id: "workflow-1",
      workflow_name: "Implementation",
      current_step_id: "step-review",
      step_name: "review",
      tags: ["old-tag"],
      sections: [
        {
          type: "goal",
          content: "Old goal",
          order: 1,
          done: null,
          done_at: null,
        },
      ],
    });
    const leanPayload = {
      ...existing,
      title: "Lean payload",
      tags: [],
      sections: [],
    };
    const hydrated = {
      ...leanPayload,
      title: "Hydrated payload",
    };
    seedTaskList([existing]);
    mockGetTask.mockResolvedValue({ status: "ok", data: hydrated });

    renderHook(() => useTaskChangeListener());
    await waitFor(() => {
      expect(taskChangedListen).toHaveBeenCalledTimes(1);
    });

    emitTaskChanged({
      task_id: "lean-empty-arrays",
      change_type: "Updated",
      task: leanPayload,
      current_step_id: "step-review",
      workflow_id: "workflow-1",
      level: "ticket",
      archived: false,
    });

    await waitFor(() => {
      expect(mockGetTask).toHaveBeenCalledWith("lean-empty-arrays");
    });
    await waitFor(() => {
      expect(cachedTasks()[0]).toMatchObject({
        title: "Hydrated payload",
        tags: [],
        sections: [],
      });
    });
  });

  it("hydrates task changed events when payload task data is absent", async () => {
    const hydrated = createMockTask({
      id: "missing-task",
      workflow_id: "workflow-1",
      workflow_name: "Implementation",
      current_step_id: "step-review",
      step_name: "review",
    });
    seedTaskList([]);
    mockGetTask.mockResolvedValue({ status: "ok", data: hydrated });

    renderHook(() => useTaskChangeListener());
    await waitFor(() => {
      expect(taskChangedListen).toHaveBeenCalledTimes(1);
    });

    emitTaskChanged({
      task_id: "missing-task",
      change_type: "Updated",
      task: null,
      current_step_id: "step-review",
      workflow_id: "workflow-1",
      level: "ticket",
      archived: false,
    });

    await waitFor(() => {
      expect(mockGetTask).toHaveBeenCalledWith("missing-task");
    });
    expect(cachedTasks()[0]).toMatchObject({
      id: "missing-task",
      workflow_name: "Implementation",
      step_name: "review",
    });
  });
});

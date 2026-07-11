import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockTask,
  createMockTaskRun,
  createMockTaskRunControls,
} from "../test/test-utils";

type EventCallback = (event: { payload: Record<string, unknown> }) => void;

const { mockEvents, emitTaskRunChanged, resetListeners } = vi.hoisted(() => {
  let listener: EventCallback | null = null;
  return {
    mockEvents: {
      taskRunChangedEvent: {
        listen: vi.fn((callback: EventCallback) => {
          listener = callback;
          return Promise.resolve(() => {
            listener = null;
          });
        }),
      },
    },
    emitTaskRunChanged: (payload: Record<string, unknown>) =>
      listener?.({ payload }),
    resetListeners: () => {
      listener = null;
    },
  };
});

vi.mock("../bindings", () => ({
  events: mockEvents,
}));

import { useTaskRunChangeListener } from "./useTaskRunChangeListener";
import { queryClient, queryKeys, upsertTaskInQueryCache } from "../query";
import { getProjectScopeGeneration } from "../stores/projectScopedStores";
import type { Task, TaskRun } from "../bindings";

function cachedTask(taskId: string): Task | undefined {
  return queryClient.getQueryData(
    queryKeys.tasks.detail(getProjectScopeGeneration(), taskId)
  );
}

function cachedRuns(taskId: string): TaskRun[] | undefined {
  return queryClient.getQueryData(
    queryKeys.taskRuns.byTask(getProjectScopeGeneration(), taskId)
  );
}

describe("useTaskRunChangeListener", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    queryClient.clear();
    resetListeners();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function mountListener() {
    renderHook(() => useTaskRunChangeListener());
    await act(async () => {
      await Promise.resolve();
    });
  }

  it("upserts the run query and refreshes server-derived controls for present payloads", async () => {
    const task = createMockTask({ id: "task-1", run_controls: null });
    const taskRun = createMockTaskRun({ id: "run-1", task_id: task.id });
    const controls = createMockTaskRunControls(taskRun);
    upsertTaskInQueryCache(task);
    await mountListener();

    act(() => {
      emitTaskRunChanged({
        task_run_id: taskRun.id,
        task_id: task.id,
        status: taskRun.status,
        change_type: "Updated",
        task_run: taskRun,
        run_controls: { kind: "present", controls },
      });
    });

    expect(cachedRuns(task.id)).toEqual([taskRun]);
    expect(cachedTask(task.id)?.run_controls).toEqual(controls);
  });

  it("keeps cached controls and preserves the run when controls are malformed", async () => {
    const previousRun = createMockTaskRun({ id: "run-old", task_id: "task-1" });
    const task = createMockTask({
      id: "task-1",
      run_controls: createMockTaskRunControls(previousRun),
    });
    const taskRun = createMockTaskRun({
      id: "run-live",
      task_id: task.id,
      status: "executing",
    });
    upsertTaskInQueryCache(task);
    await mountListener();

    act(() => {
      emitTaskRunChanged({
        task_run_id: taskRun.id,
        task_id: task.id,
        status: taskRun.status,
        change_type: "Updated",
        task_run: taskRun,
        run_controls: { kind: "malformed" },
      });
    });

    expect(cachedRuns(task.id)).toEqual([taskRun]);
    expect(cachedTask(task.id)?.run_controls).toEqual(task.run_controls);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Missing valid run_controls projection")
    );
  });

  it("does not erase task state when the controls projection is missing", async () => {
    const task = createMockTask({ id: "task-deleted" });
    const taskRun = createMockTaskRun({ id: "run-deleted", task_id: task.id });
    upsertTaskInQueryCache(task);
    queryClient.setQueryData(
      queryKeys.taskRuns.byTask(getProjectScopeGeneration(), task.id),
      [taskRun]
    );
    await mountListener();

    act(() => {
      emitTaskRunChanged({
        task_run_id: taskRun.id,
        task_id: task.id,
        status: taskRun.status,
        change_type: "Updated",
        task_run: taskRun,
        run_controls: { kind: "deleted" },
      });
    });

    expect(cachedTask(task.id)).toEqual(task);
    expect(cachedRuns(task.id)).toEqual([taskRun]);
  });
});

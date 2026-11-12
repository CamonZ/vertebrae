import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { createMockTask, createMockTaskRun } from "../test/test-utils";
import { queryClient, queryKeys } from "../query";
import { getProjectScopeGeneration } from "../stores/projectScopedStores";
import type { Task, TaskRun } from "../bindings";
import {
  isCompletedRun,
  runMatchesQuery,
  useHistoryRuns,
} from "./useHistoryRuns";

const mocks = vi.hoisted(() => ({ tasks: [] as Task[] }));

vi.mock("./useTasks", () => ({
  useTasks: () => ({ tasks: mocks.tasks }),
}));

vi.mock("../bindings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../bindings")>();
  return {
    ...actual,
    commands: {
      ...actual.commands,
      getTaskRuns: vi.fn(async (taskId: string) => ({
        status: "ok",
        data: runsByTask[taskId] ?? [],
      })),
    },
  };
});

let runsByTask: Record<string, TaskRun[]> = {};

function seed(taskId: string, runs: TaskRun[]) {
  runsByTask[taskId] = runs;
  queryClient.setQueryData(
    queryKeys.taskRuns.byTask(getProjectScopeGeneration(), taskId),
    runs
  );
}

describe("useHistoryRuns", () => {
  beforeEach(() => {
    queryClient.clear();
    runsByTask = {};
    mocks.tasks = [
      createMockTask({
        id: "task-a",
        title: "Build parser",
        workflow_id: "wf",
        workflow_name: "Delivery",
      }),
      createMockTask({ id: "task-b", title: "No workflow" }),
      createMockTask({
        id: "task-c",
        title: "Done",
        workflow_id: "wf",
        completed_at: "2026-01-01T00:00:00Z",
      }),
    ];
    seed("task-a", [
      createMockTaskRun({ id: "run-active", task_id: "task-a" }),
      createMockTaskRun({
        id: "run-failed",
        task_id: "task-a",
        status: "failed",
      }),
      createMockTaskRun({
        id: "run-done",
        task_id: "task-a",
        status: "completed",
      }),
    ]);
    seed("task-c", [
      createMockTaskRun({ id: "run-c", task_id: "task-c", status: "failed" }),
    ]);
  });

  it("hides completed and stopped runs and completed tasks unless shown", () => {
    const { result } = renderHook(() =>
      useHistoryRuns({ enabled: true, showCompleted: false, searchQuery: "" })
    );

    expect(result.current.rows.map((row) => row.id)).toEqual([
      "run-active",
      "run-failed",
    ]);
    expect(result.current.rows[0].label).toBe("Delivery run");
    expect(result.current.hiddenCompletedCount).toBe(1);
  });

  it("includes completed history when shown", () => {
    const { result } = renderHook(() =>
      useHistoryRuns({ enabled: true, showCompleted: true, searchQuery: "" })
    );

    expect(result.current.rows.map((row) => row.id).sort()).toEqual([
      "run-active",
      "run-c",
      "run-done",
      "run-failed",
    ]);
  });

  it("lists nothing outside the current project", () => {
    const { result } = renderHook(() =>
      useHistoryRuns({ enabled: false, showCompleted: true, searchQuery: "" })
    );
    expect(result.current.rows).toEqual([]);
  });

  it("filters by run id prefix", () => {
    const { result } = renderHook(() =>
      useHistoryRuns({
        enabled: true,
        showCompleted: false,
        searchQuery: "RUN-FAI",
      })
    );
    expect(result.current.rows.map((row) => row.id)).toEqual(["run-failed"]);
  });
});

describe("run history helpers", () => {
  it("treats completed and stopped runs as completed history", () => {
    expect(isCompletedRun({ status: "completed" })).toBe(true);
    expect(isCompletedRun({ status: "stopped" })).toBe(true);
    expect(isCompletedRun({ status: "failed" })).toBe(false);
    expect(isCompletedRun({ status: "waiting" })).toBe(false);
  });

  it("matches task title, task id and run id", () => {
    const run = { id: "abc12345-run", task_id: "def67890-task" };
    expect(runMatchesQuery(run, { title: "Fix parser" }, "parser")).toBe(true);
    expect(runMatchesQuery(run, { title: "Fix" }, "def678")).toBe(true);
    expect(runMatchesQuery(run, { title: "Fix" }, "abc1")).toBe(true);
    expect(runMatchesQuery(run, { title: "Fix" }, "zzz")).toBe(false);
  });
});

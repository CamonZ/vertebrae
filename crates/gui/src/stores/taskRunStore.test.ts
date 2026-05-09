import { describe, it, expect, beforeEach } from "vitest";
import { useTaskRunStore } from "./taskRunStore";
import { createMockTaskRun } from "../test/test-utils";

describe("taskRunStore", () => {
  beforeEach(() => {
    useTaskRunStore.setState({
      taskRuns: [],
      taskRunsByTaskId: {},
    });
  });

  it("has empty TaskRun state initially", () => {
    const state = useTaskRunStore.getState();
    expect(state.taskRuns).toEqual([]);
    expect(state.taskRunsByTaskId).toEqual({});
  });

  it("sets TaskRuns and indexes them by task_id", () => {
    const runs = [
      createMockTaskRun({ id: "run-1", task_id: "task-1" }),
      createMockTaskRun({ id: "run-2", task_id: "task-1" }),
      createMockTaskRun({ id: "run-3", task_id: "task-2" }),
    ];

    useTaskRunStore.getState().setTaskRuns(runs);

    const state = useTaskRunStore.getState();
    expect(state.taskRuns.map((run) => run.id)).toEqual([
      "run-1",
      "run-2",
      "run-3",
    ]);
    expect(state.taskRunsByTaskId["task-1"].map((run) => run.id)).toEqual([
      "run-1",
      "run-2",
    ]);
    expect(state.taskRunsByTaskId["task-2"].map((run) => run.id)).toEqual([
      "run-3",
    ]);
  });

  it("upserts a new TaskRun into the list and task bucket", () => {
    const run = createMockTaskRun({ id: "run-new", task_id: "task-A" });

    useTaskRunStore.getState().upsertTaskRun(run);

    const state = useTaskRunStore.getState();
    expect(state.taskRuns).toEqual([run]);
    expect(state.taskRunsByTaskId["task-A"]).toEqual([run]);
  });

  it("updates an existing TaskRun in both indexes", () => {
    const original = createMockTaskRun({
      id: "run-1",
      task_id: "task-A",
      status: "queued",
    });
    const updated = createMockTaskRun({
      id: "run-1",
      task_id: "task-A",
      status: "waiting",
      latest_step_execution_id: "exec-1",
    });
    useTaskRunStore.getState().setTaskRuns([original]);

    useTaskRunStore.getState().upsertTaskRun(updated);

    const state = useTaskRunStore.getState();
    expect(state.taskRuns).toHaveLength(1);
    expect(state.taskRuns[0].status).toBe("waiting");
    expect(state.taskRuns[0].latest_step_execution_id).toBe("exec-1");
    expect(state.taskRunsByTaskId["task-A"][0].status).toBe("waiting");
  });

  it("moves a TaskRun between task buckets when task_id changes", () => {
    const original = createMockTaskRun({ id: "run-1", task_id: "task-old" });
    const moved = createMockTaskRun({ id: "run-1", task_id: "task-new" });
    useTaskRunStore.getState().setTaskRuns([original]);

    useTaskRunStore.getState().upsertTaskRun(moved);

    const state = useTaskRunStore.getState();
    expect(state.taskRuns[0].task_id).toBe("task-new");
    expect(state.taskRunsByTaskId).not.toHaveProperty("task-old");
    expect(state.taskRunsByTaskId["task-new"][0].id).toBe("run-1");
  });

  it("sets and clears per-task TaskRun buckets", () => {
    const run = createMockTaskRun({ id: "run-bucket", task_id: "task-B" });

    useTaskRunStore.getState().setTaskRunsForTask("task-B", [run]);
    expect(useTaskRunStore.getState().taskRuns).toEqual([run]);
    expect(useTaskRunStore.getState().taskRunsByTaskId["task-B"]).toEqual([
      run,
    ]);

    useTaskRunStore.getState().clearTaskRunsForTask("task-B");
    expect(useTaskRunStore.getState().taskRuns).toEqual([]);
    expect(useTaskRunStore.getState().taskRunsByTaskId).not.toHaveProperty(
      "task-B"
    );
  });
});

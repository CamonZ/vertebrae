import { describe, expect, it } from "vitest";
import type { TaskRun } from "../bindings";
import { deriveRunControlsState, deriveRunStateChip, isTaskDone } from "./runState";

const activeRun = { id: "run-1", task_id: "task-1", status: "executing" } as TaskRun;

describe("query-backed run state", () => {
  it("derives chips and controls from the supplied query run", () => {
    expect(deriveRunStateChip(activeRun)).toMatchObject({ status: "executing" });
    expect(deriveRunControlsState({ runnable: true, stoppable: true, disabled_reason_code: null, disabled_reason: null, active_run: null }, { activeRun })).toMatchObject({ hasActiveRun: true, runDisabled: true });
  });

  it("uses the supplied query run to determine completion", () => {
    expect(isTaskDone({ completed_at: null }, { ...activeRun, status: "completed" })).toBe(true);
  });
});

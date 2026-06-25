import { describe, expect, it } from "vitest";
import type { TaskRun, TaskRunControls, TaskRunStatus } from "../bindings";
import {
  deriveHearthRunChipState,
  deriveRunControlsState,
  deriveRunStateChip,
  getRunChipStyles,
  isActiveRunStatus,
  isTaskDone,
  taskRunStatusToHearthRunState,
} from "./runState";

function makeRun(status: TaskRunStatus, overrides?: Partial<TaskRun>): TaskRun {
  return {
    id: "run-1",
    task_id: "task-1",
    project_id: "project-1",
    user_id: null,
    status,
    started_at: "2025-01-01T00:00:00Z",
    ended_at: null,
    stop_requested_at: null,
    latest_step_execution_id: null,
    outcome_kind: null,
    outcome_context: null,
    parent_task_run_id: null,
    root_task_run_id: null,
    triggered_by_step_execution_id: null,
    inserted_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeControls(
  overrides: Partial<TaskRunControls> & { active_run?: TaskRun | null } = {}
): TaskRunControls {
  return {
    runnable: false,
    stoppable: false,
    disabled_reason_code: null,
    disabled_reason: null,
    active_run: null,
    ...overrides,
  };
}

describe("isActiveRunStatus", () => {
  it("returns true for queued/executing/waiting/stopping", () => {
    expect(isActiveRunStatus("queued")).toBe(true);
    expect(isActiveRunStatus("executing")).toBe(true);
    expect(isActiveRunStatus("waiting")).toBe(true);
    expect(isActiveRunStatus("stopping")).toBe(true);
  });

  it("returns false for terminal and missing statuses", () => {
    expect(isActiveRunStatus("stopped")).toBe(false);
    expect(isActiveRunStatus("completed")).toBe(false);
    expect(isActiveRunStatus("failed")).toBe(false);
    expect(isActiveRunStatus(null)).toBe(false);
    expect(isActiveRunStatus(undefined)).toBe(false);
  });
});

describe("isTaskDone", () => {
  it("uses completed_at or completed TaskRun status, not step_name labels", () => {
    expect(
      isTaskDone({ completed_at: "2026-01-01T00:00:00Z", run_controls: null })
    ).toBe(true);
    expect(
      isTaskDone({
        completed_at: null,
        run_controls: makeControls({ active_run: makeRun("completed") }),
      })
    ).toBe(true);
    expect(
      isTaskDone({
        completed_at: null,
        run_controls: makeControls({ active_run: makeRun("executing") }),
      })
    ).toBe(false);
  });
});

describe("deriveRunStateChip", () => {
  it("returns null when run_controls is missing", () => {
    expect(deriveRunStateChip({ run_controls: null })).toBeNull();
    expect(deriveRunStateChip({ run_controls: undefined })).toBeNull();
  });

  it("returns null when there is no active_run", () => {
    expect(
      deriveRunStateChip({ run_controls: makeControls({ active_run: null }) })
    ).toBeNull();
  });

  it("returns Running chip for executing runs", () => {
    const chip = deriveRunStateChip({
      run_controls: makeControls({ active_run: makeRun("executing") }),
    });
    expect(chip).toEqual({
      label: "Running",
      status: "executing",
      isActive: true,
      tone: "success",
    });
  });

  it.each<[TaskRunStatus, string, "info" | "success" | "muted"]>([
    ["queued", "Queued", "info"],
    ["executing", "Running", "success"],
    ["waiting", "Waiting", "info"],
    ["stopping", "Stopping", "muted"],
  ])("emits chip for active status %s", (status, label, tone) => {
    const chip = deriveRunStateChip({
      run_controls: makeControls({ active_run: makeRun(status) }),
    });
    expect(chip).not.toBeNull();
    expect(chip!.label).toBe(label);
    expect(chip!.tone).toBe(tone);
    expect(chip!.isActive).toBe(true);
  });

  it("styles queued and generic waiting chips as solid sky blue", () => {
    expect(
      getRunChipStyles({
        label: "Queued",
        status: "queued",
        isActive: true,
        tone: "info",
      })
    ).toMatchObject({
      bg: "bg-sky-400/10",
      text: "text-sky-300",
      dot: "bg-sky-400",
      pulse: false,
    });
  });

  it("hides terminal statuses by default but exposes them when includeTerminal is true", () => {
    const controls = makeControls({ active_run: makeRun("completed") });
    expect(deriveRunStateChip({ run_controls: controls })).toBeNull();

    const chip = deriveRunStateChip(
      { run_controls: controls },
      { includeTerminal: true }
    );
    expect(chip).toEqual({
      label: "Completed",
      status: "completed",
      isActive: false,
      tone: "success",
    });
  });

  it("exposes failed and stopped tones when includeTerminal is true", () => {
    expect(
      deriveRunStateChip(
        {
          run_controls: makeControls({ active_run: makeRun("failed") }),
        },
        { includeTerminal: true }
      )
    ).toMatchObject({ label: "Failed", tone: "error", isActive: false });

    expect(
      deriveRunStateChip(
        {
          run_controls: makeControls({ active_run: makeRun("stopped") }),
        },
        { includeTerminal: true }
      )
    ).toMatchObject({ label: "Stopped", tone: "muted", isActive: false });
  });
});

describe("deriveHearthRunChipState", () => {
  it("maps TaskRunStatus values to v2 Hearth run chip states", () => {
    expect(taskRunStatusToHearthRunState("executing")).toBe("running");
    expect(taskRunStatusToHearthRunState("queued")).toBe("queued");
    expect(taskRunStatusToHearthRunState("waiting")).toBe("waiting");
  });

  it("hides terminal run states by default and exposes them when requested", () => {
    expect(deriveHearthRunChipState("completed")).toBeNull();
    expect(deriveHearthRunChipState("stopped")).toBeNull();
    expect(deriveHearthRunChipState("failed")).toBeNull();

    expect(
      deriveHearthRunChipState("failed", { includeTerminal: true })
    ).toMatchObject({
      state: "failed",
      status: "failed",
      label: "Failed",
      isActive: false,
      tone: "error",
    });
  });
});

describe("deriveRunControlsState", () => {
  it("returns safe defaults when controls are missing", () => {
    const state = deriveRunControlsState(null);
    expect(state).toEqual({
      activeRun: null,
      hasActiveRun: false,
      runnable: false,
      stoppable: false,
      isStopping: false,
      showStop: false,
      runDisabled: true,
      stopDisabled: true,
    });
  });

  it("disables Run when there is no workflow", () => {
    const state = deriveRunControlsState(makeControls({ runnable: true }), {
      hasWorkflow: false,
    });
    expect(state.runDisabled).toBe(true);
    expect(state.showStop).toBe(false);
  });

  it("enables Run when runnable and no active run", () => {
    const state = deriveRunControlsState(
      makeControls({ runnable: true, active_run: null })
    );
    expect(state.runDisabled).toBe(false);
    expect(state.showStop).toBe(false);
    expect(state.hasActiveRun).toBe(false);
  });

  it("enables Stop and disables Run while a run is executing and stoppable", () => {
    const state = deriveRunControlsState(
      makeControls({
        runnable: false,
        stoppable: true,
        active_run: makeRun("executing"),
      })
    );
    expect(state.runDisabled).toBe(true);
    expect(state.showStop).toBe(true);
    expect(state.stopDisabled).toBe(false);
    expect(state.hasActiveRun).toBe(true);
  });

  it("treats waiting runs as active stoppable work", () => {
    const state = deriveRunControlsState(
      makeControls({
        runnable: false,
        stoppable: true,
        active_run: makeRun("waiting"),
      })
    );
    expect(state.hasActiveRun).toBe(true);
    expect(state.showStop).toBe(true);
    expect(state.stopDisabled).toBe(false);
  });

  it("disables both Run and Stop while the active run is stopping", () => {
    const state = deriveRunControlsState(
      makeControls({
        runnable: false,
        stoppable: false,
        active_run: makeRun("stopping"),
      })
    );
    expect(state.runDisabled).toBe(true);
    expect(state.showStop).toBe(true);
    expect(state.stopDisabled).toBe(true);
    expect(state.isStopping).toBe(true);
  });

  it("hides Stop after the active run reaches a terminal status", () => {
    const state = deriveRunControlsState(
      makeControls({
        runnable: true,
        stoppable: false,
        active_run: makeRun("completed"),
      })
    );
    expect(state.hasActiveRun).toBe(false);
    expect(state.showStop).toBe(false);
    expect(state.runDisabled).toBe(false);
  });
});

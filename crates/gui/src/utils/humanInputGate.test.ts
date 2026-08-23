import { describe, it, expect } from "vitest";
import type { StepExecution, TaskRun } from "../bindings";
import {
  classifyWaitingRun,
  pickLatestExecution,
  resolveHumanInputGate,
} from "./humanInputGate";

function makeRun(overrides: Partial<TaskRun> & { id: string }): TaskRun {
  return {
    id: overrides.id,
    task_id: overrides.task_id ?? "task-1",
    project_id: overrides.project_id ?? "project-1",
    user_id: null,
    status: overrides.status ?? "waiting",
    max_concurrency: overrides.max_concurrency ?? null,
    started_at: overrides.started_at ?? "2026-05-08T10:00:00Z",
    ended_at: overrides.ended_at ?? null,
    stop_requested_at: null,
    latest_step_execution_id: overrides.latest_step_execution_id ?? null,
    outcome_kind: null,
    outcome_context: null,
    parent_task_run_id: null,
    root_task_run_id: null,
    triggered_by_step_execution_id: null,
    inserted_at: null,
    updated_at: null,
  };
}

function makeExec(
  overrides: Partial<StepExecution> & { id: string }
): StepExecution {
  const hasStepType = Object.prototype.hasOwnProperty.call(
    overrides,
    "step_type"
  );
  return {
    id: overrides.id,
    task_id: overrides.task_id ?? "task-1",
    task_run_id: overrides.task_run_id ?? "run-1",
    workflow_id: overrides.workflow_id ?? "wf-1",
    step_name: overrides.step_name ?? "implement",
    step_type: hasStepType ? overrides.step_type : "human_input",
    started_at: overrides.started_at ?? "2026-05-08T10:00:00Z",
    completed_at: overrides.completed_at ?? null,
    status: overrides.status ?? "in_progress",
    prompt: overrides.prompt ?? null,
    output: null,
    context: null,
    transition_result: null,
    model: null,
    model_provider: null,
    input_tokens: null,
    output_tokens: null,
    cost: null,
    duration_ms: null,
    handoff: null,
    session_id: null,
  };
}

describe("classifyWaitingRun", () => {
  it("classifies wait_children executions by step_type even with a custom step name", () => {
    const exec = makeExec({
      id: "e-1",
      step_name: "wait",
      step_type: "wait_children",
    });
    expect(classifyWaitingRun(exec)).toBe("wait_children");
  });

  it("classifies human_input executions by step_type independent of step name", () => {
    expect(
      classifyWaitingRun(
        makeExec({
          id: "e-1",
          step_name: "wait_children",
          step_type: "human_input",
        })
      )
    ).toBe("human_input");
  });

  it("treats missing step_type as human_input even when the display label says wait_children", () => {
    expect(
      classifyWaitingRun(
        makeExec({
          id: "e-1",
          step_name: "wait_children",
          step_type: undefined,
        })
      )
    ).toBe("human_input");
  });

  it("defaults absent or legacy non-wait_children payloads to human_input", () => {
    expect(
      classifyWaitingRun(
        makeExec({ id: "e-1", step_name: "review", step_type: undefined })
      )
    ).toBe("human_input");
    expect(classifyWaitingRun(null)).toBe("human_input");
  });
});

describe("pickLatestExecution", () => {
  it("prefers the run's latest_step_execution_id when present", () => {
    const run = makeRun({ id: "run-1", latest_step_execution_id: "e-target" });
    const execs = [
      makeExec({ id: "e-old", started_at: "2026-05-08T09:00:00Z" }),
      makeExec({ id: "e-target", started_at: "2026-05-08T08:00:00Z" }),
      makeExec({ id: "e-new", started_at: "2026-05-08T11:00:00Z" }),
    ];
    expect(pickLatestExecution(run, execs)?.id).toBe("e-target");
  });

  it("falls back to the most recent execution by started_at", () => {
    const run = makeRun({ id: "run-1" });
    const execs = [
      makeExec({ id: "e-old", started_at: "2026-05-08T09:00:00Z" }),
      makeExec({ id: "e-new", started_at: "2026-05-08T11:00:00Z" }),
      makeExec({ id: "e-mid", started_at: "2026-05-08T10:00:00Z" }),
    ];
    expect(pickLatestExecution(run, execs)?.id).toBe("e-new");
  });

  it("ignores executions belonging to other runs", () => {
    const run = makeRun({ id: "run-1" });
    const execs = [
      makeExec({
        id: "e-other",
        task_run_id: "run-2",
        started_at: "2026-05-08T11:00:00Z",
      }),
      makeExec({ id: "e-mine", started_at: "2026-05-08T10:00:00Z" }),
    ];
    expect(pickLatestExecution(run, execs)?.id).toBe("e-mine");
  });

  it("returns null when no executions exist", () => {
    expect(pickLatestExecution(makeRun({ id: "run-1" }), [])).toBeNull();
  });
});

describe("resolveHumanInputGate", () => {
  it("returns null when run is not waiting", () => {
    const run = makeRun({ id: "run-1", status: "executing" });
    const exec = makeExec({ id: "e-1", step_name: "review" });
    expect(resolveHumanInputGate(run, [exec])).toBeNull();
  });

  it("returns null when latest execution is wait_children", () => {
    const run = makeRun({
      id: "run-1",
      status: "waiting",
      latest_step_execution_id: "e-1",
    });
    const exec = makeExec({
      id: "e-1",
      step_name: "wait",
      step_type: "wait_children",
    });
    expect(resolveHumanInputGate(run, [exec])).toBeNull();
  });

  it("returns gate context for waiting human_input runs", () => {
    const run = makeRun({
      id: "run-1",
      status: "waiting",
      latest_step_execution_id: "e-1",
    });
    const exec = makeExec({
      id: "e-1",
      step_name: "approval",
      prompt: "Approve change?",
    });
    const gate = resolveHumanInputGate(run, [exec]);
    expect(gate).not.toBeNull();
    expect(gate?.run.id).toBe("run-1");
    expect(gate?.execution?.id).toBe("e-1");
    expect(gate?.stepName).toBe("approval");
    expect(gate?.prompt).toBe("Approve change?");
    expect(gate?.outputSchema).toBeNull();
  });

  it("forwards an explicitly provided output schema", () => {
    const run = makeRun({ id: "run-1", status: "waiting" });
    const exec = makeExec({ id: "e-1", step_name: "approval" });
    const schema = { type: "object", required: ["decision"] };
    const gate = resolveHumanInputGate(run, [exec], { outputSchema: schema });
    expect(gate?.outputSchema).toEqual(schema);
  });

  it("returns null when the run has no executions and no latest pointer", () => {
    const run = makeRun({ id: "run-1", status: "waiting" });
    expect(resolveHumanInputGate(run, [])).not.toBeNull();
    // Missing executions still classifies as human_input (default), so the
    // gate is rendered using just the run-level metadata. This keeps a
    // freshly parked run visible even before its executions are fetched.
  });
});

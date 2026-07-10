import { describe, expect, it } from "vitest";
import type {
  PipelineStep,
  PipelineSummary,
  PipelineWorkflow,
  Task,
  TaskRun,
  TaskRunStatus,
} from "../../bindings";
import {
  formatElapsed,
  miniPipeline,
  runtimeSince,
  splitRunConsole,
} from "./runConsoleData";

/* ── fixtures ──────────────────────────────────────────────────── */

function makeRun(
  status: TaskRunStatus,
  overrides: Partial<TaskRun> = {}
): TaskRun {
  return {
    id: "run-" + status,
    task_id: "t",
    project_id: "p",
    user_id: null,
    status,
    started_at: "2024-01-01T00:00:00Z",
    ended_at: null,
    stop_requested_at: null,
    latest_step_execution_id: null,
    inserted_at: "2024-01-01T00:00:00Z",
    ...overrides,
  } as TaskRun;
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-id-0001",
    title: "A task",
    description: null,
    level: "task",
    priority: null,
    tags: [],
    workflow_id: "wf-build",
    current_step_id: null,
    workflow_name: "Build",
    step_name: null,
    step_type: null,
    run_controls: null,
    archived: false,
    worktree: null,
    rejection_reason: null,
    parent_id: null,
    dependency_ids: [],
    sections: [],
    code_refs: [],
    created_at: null,
    updated_at: null,
    started_at: null,
    completed_at: null,
    ...overrides,
  } as Task;
}

function withRun(task: Task, run: TaskRun | null): Task {
  return {
    ...task,
    run_controls: {
      runnable: false,
      stoppable: true,
      disabled_reason_code: null,
      disabled_reason: null,
      active_run: run,
    },
  };
}

function makeStep(
  id: string,
  order: number,
  overrides: Partial<PipelineStep> = {}
): PipelineStep {
  return {
    id,
    name: id,
    workflow_id: "wf-build",
    goal: null,
    step_order: order,
    step_type: "execute",
    is_final: false,
    transitions_to: [],
    task_counts: { epic: 0, ticket: 0, task: 0 },
    pipeline_counts: { epic: 0, ticket: 0, task: 0, active: 0 },
    active_count: 0,
    ...overrides,
  } as PipelineStep;
}

const SUMMARY: PipelineSummary = {
  workflows: [
    {
      id: "wf-build",
      name: "Build",
      description: null,
      initial_step_id: "s1",
      kanban_column: null,
      is_default: false,
      is_final: false,
      display_order: 0,
      workflow_steps: [
        makeStep("s1", 0),
        makeStep("s2", 1),
        makeStep("s3", 2, { is_final: true }),
      ],
      transitions: [],
    } as PipelineWorkflow,
  ],
};

/* ── splitRunConsole ───────────────────────────────────────────── */

describe("splitRunConsole", () => {
  it("buckets active runs into Running and workflow tasks into Ready", () => {
    const idle = withRun(makeTask({ id: "ready-1" }), null);
    const queued = withRun(makeTask({ id: "ready-2" }), null);
    const running = withRun(
      makeTask({ id: "running-1" }),
      makeRun("executing")
    );
    const waiting = withRun(makeTask({ id: "running-2" }), makeRun("waiting"));

    const { running: run, ready } = splitRunConsole([
      idle,
      queued,
      running,
      waiting,
    ], new Map([[running.id, running.run_controls!.active_run!], [waiting.id, waiting.run_controls!.active_run!]]));

    expect(run.map((r) => r.task.id).sort()).toEqual([
      "running-1",
      "running-2",
    ]);
    expect(ready.map((r) => r.task.id).sort()).toEqual(["ready-1", "ready-2"]);
  });

  it("drops tasks with no workflow from Ready", () => {
    const noWorkflow = makeTask({ id: "no-wf", workflow_id: null });
    const { running, ready } = splitRunConsole([noWorkflow], new Map());
    expect(running).toHaveLength(0);
    expect(ready).toHaveLength(0);
  });

  it("surfaces the active run's start time on Running rows", () => {
    const running = withRun(
      makeTask({ id: "running-1" }),
      makeRun("executing", { started_at: "2024-06-01T12:00:00Z" })
    );
    const { running: rows } = splitRunConsole([running], new Map([[running.id, running.run_controls!.active_run!]]));
    expect(rows[0]?.startedAt).toBe("2024-06-01T12:00:00Z");
  });

  it("treats stopping runs as still active (Running)", () => {
    const stopping = withRun(
      makeTask({ id: "stopping-1" }),
      makeRun("stopping")
    );
    const { running, ready } = splitRunConsole([stopping], new Map([[stopping.id, stopping.run_controls!.active_run!]]));
    expect(running.map((r) => r.task.id)).toEqual(["stopping-1"]);
    expect(ready).toHaveLength(0);
  });
});

/* ── miniPipeline ──────────────────────────────────────────────── */

describe("miniPipeline", () => {
  it("marks the current step `current` (static) for a parked task", () => {
    // A Ready task sits at its current step but is not running — it must not
    // pulse, so the current segment is `current`, never `running`.
    const task = makeTask({ current_step_id: "s2" });
    const segs = miniPipeline(task, SUMMARY);
    expect(segs.map((s) => s.state)).toEqual(["done", "current", "queued"]);
    // kind is the real backend step type (all execute here) — no synthetic
    // entry/final.
    expect(segs.map((s) => s.kind)).toEqual(["execute", "execute", "execute"]);
  });

  it("marks the current step `running` only when the run is active", () => {
    const task = makeTask({ current_step_id: "s2" });
    const segs = miniPipeline(task, SUMMARY, true);
    expect(segs.map((s) => s.state)).toEqual(["done", "running", "queued"]);
  });

  it("marks every segment queued when the task has no current step", () => {
    const task = makeTask({ current_step_id: null });
    const segs = miniPipeline(task, SUMMARY);
    expect(segs.map((s) => s.state)).toEqual(["queued", "queued", "queued"]);
  });

  it("returns empty for a task with no workflow or unknown workflow", () => {
    expect(miniPipeline(makeTask({ workflow_id: null }), SUMMARY)).toEqual([]);
    expect(miniPipeline(makeTask({ workflow_id: "nope" }), SUMMARY)).toEqual(
      []
    );
    expect(miniPipeline(makeTask(), null)).toEqual([]);
  });
});

/* ── runtime formatting ────────────────────────────────────────── */

describe("formatElapsed / runtimeSince", () => {
  it("formats spans compactly", () => {
    expect(formatElapsed(5_000)).toBe("5s");
    expect(formatElapsed(125_000)).toBe("2m 5s");
    expect(formatElapsed(3_725_000)).toBe("1h 2m");
    expect(formatElapsed(-100)).toBe("0s");
  });

  it("computes elapsed since an ISO start, null-safe", () => {
    const start = "2024-01-01T00:00:00Z";
    const now = Date.parse(start) + 90_000;
    expect(runtimeSince(start, now)).toBe("1m 30s");
    expect(runtimeSince(null, now)).toBeNull();
    expect(runtimeSince("not-a-date", now)).toBeNull();
  });
});

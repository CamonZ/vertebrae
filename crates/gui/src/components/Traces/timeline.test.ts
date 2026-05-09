import { describe, it, expect } from "vitest";
import {
  buildTimelineProjection,
  buildTimelineProjectionFromProjection,
} from "./timeline";
import { projectTaskRunTrace } from "./taskRunTrace";
import type {
  SessionLog,
  StepExecution,
  Task,
  TaskRun,
  TaskRunStatus,
} from "../../bindings";

const makeRun = (
  overrides: Partial<TaskRun> & { id: string; task_id: string }
): TaskRun => ({
  id: overrides.id,
  task_id: overrides.task_id,
  project_id: "p-1",
  user_id: null,
  status: (overrides.status ?? "completed") as TaskRunStatus,
  started_at: overrides.started_at ?? "2024-01-01T00:00:00.000Z",
  ended_at: overrides.ended_at ?? null,
  stop_requested_at: null,
  latest_step_execution_id: null,
  outcome_kind: null,
  outcome_context: null,
  parent_task_run_id: overrides.parent_task_run_id ?? null,
  root_task_run_id: overrides.root_task_run_id ?? null,
  triggered_by_step_execution_id:
    overrides.triggered_by_step_execution_id ?? null,
  inserted_at: "2024-01-01T00:00:00.000Z",
  updated_at: "2024-01-01T00:00:00.000Z",
});

const makeTask = (overrides: Partial<Task> & { id: string }): Task => ({
  id: overrides.id,
  title: overrides.title ?? `task-${overrides.id}`,
  description: null,
  level: overrides.level ?? "ticket",
  priority: null,
  tags: [],
  workflow_id: overrides.workflow_id ?? "wf-1",
  current_step_id: null,
  workflow_name: "Implementation",
  step_name: null,
  needs_human_review: null,
  archived: false,
  worktree: null,
  review_comment: null,
  revision_feedback: null,
  rejection_reason: null,
  parent_id: overrides.parent_id ?? null,
  dependency_ids: [],
  created_at: "2024-01-01T00:00:00.000Z",
  updated_at: "2024-01-01T00:00:00.000Z",
  started_at: null,
  completed_at: null,
});

const makeExec = (
  overrides: Partial<StepExecution> & { id: string; task_id: string }
): StepExecution => ({
  id: overrides.id,
  task_id: overrides.task_id,
  task_run_id: overrides.task_run_id ?? null,
  workflow_id: overrides.workflow_id ?? "wf-1",
  step_name: overrides.step_name ?? "implement",
  started_at: overrides.started_at,
  completed_at: overrides.completed_at ?? null,
  status: overrides.status ?? "completed",
  prompt: null,
  output: null,
  context: null,
  transition_result: null,
  model: overrides.model ?? "claude-opus-4",
  model_provider: "anthropic",
  input_tokens: null,
  output_tokens: null,
  cost: null,
  duration_ms: null,
  handoff: null,
  session_id: null,
});

const makeLog = (
  execId: string,
  content: object,
  createdAt: string,
  idx: number
): SessionLog => ({
  id: `log-${execId}-${idx}`,
  step_execution_id: execId,
  content: JSON.stringify(content),
  created_at: createdAt,
});

describe("buildTimelineProjection", () => {
  it("returns empty projection with null bounds when there are no events", () => {
    const proj = buildTimelineProjection(
      "t-root",
      [],
      [makeTask({ id: "t-root" })],
      {}
    );
    expect(proj.minMs).toBeNull();
    expect(proj.maxMs).toBeNull();
    expect(proj.spanMs).toBe(0);
    expect(proj.thresholds).toEqual([]);
    expect(proj.tools).toEqual([]);
    expect(proj.main).toEqual([]);
    expect(proj.delegations).toEqual([]);
  });

  it("normalizes x positions to [0, 1] over the min/max timestamp range", () => {
    const tasks = [makeTask({ id: "t-root" })];
    const t0 = "2024-01-01T10:00:00.000Z";
    const t1 = "2024-01-01T10:00:30.000Z"; // mid
    const t2 = "2024-01-01T10:01:00.000Z"; // end
    const exec = makeExec({
      id: "e1",
      task_id: "t-root",
      step_name: "plan",
      started_at: t0,
      completed_at: t2,
    });
    const logs: Record<string, SessionLog[]> = {
      e1: [
        makeLog(
          "e1",
          {
            type: "assistant",
            message: { content: [{ type: "text", text: "thinking" }] },
          },
          t1,
          0
        ),
      ],
    };
    const proj = buildTimelineProjection("t-root", [exec], tasks, logs);
    expect(proj.minMs).toBe(Date.parse(t0));
    expect(proj.maxMs).toBe(Date.parse(t2));
    expect(proj.spanMs).toBe(60_000);

    // execution_start at t0 → x=0
    const startMarker = proj.thresholds.find(
      (m) => m.kind === "execution_start"
    );
    expect(startMarker).toBeDefined();
    expect(startMarker!.x).toBeCloseTo(0, 5);

    // thinking at t1 → x=0.5
    expect(proj.main).toHaveLength(1);
    expect(proj.main[0].x).toBeCloseTo(0.5, 5);
    expect(proj.main[0].rowIndex).toBe(0);
  });

  it("emits a transition threshold when consecutive executions on the same task differ in step", () => {
    const tasks = [makeTask({ id: "t-root" })];
    const e1 = makeExec({
      id: "e1",
      task_id: "t-root",
      step_name: "plan",
      started_at: "2024-01-01T10:00:00.000Z",
    });
    const e2 = makeExec({
      id: "e2",
      task_id: "t-root",
      step_name: "implement",
      started_at: "2024-01-01T10:05:00.000Z",
    });
    const proj = buildTimelineProjection("t-root", [e1, e2], tasks, {});
    const transitions = proj.thresholds.filter((m) => m.kind === "transition");
    expect(transitions).toHaveLength(1);
    expect(transitions[0].fromStep).toBe("plan");
    expect(transitions[0].toStep).toBe("implement");
    expect(transitions[0].x).toBeCloseTo(1, 5);
  });

  it("classifies same-step retry and model-fallback markers", () => {
    const tasks = [makeTask({ id: "t-root" })];
    const e1 = makeExec({
      id: "e1",
      task_id: "t-root",
      step_name: "implement",
      started_at: "2024-01-01T10:00:00.000Z",
      model: "claude-opus-4",
    });
    const e2 = makeExec({
      id: "e2",
      task_id: "t-root",
      step_name: "implement",
      started_at: "2024-01-01T10:05:00.000Z",
      model: "claude-sonnet-4",
    });
    const proj = buildTimelineProjection("t-root", [e1, e2], tasks, {});
    expect(proj.thresholds.some((m) => m.kind === "retry")).toBe(true);
    expect(proj.thresholds.some((m) => m.kind === "model_fallback")).toBe(true);
  });

  it("emits TOOL markers for tool_use and tool_result", () => {
    const tasks = [makeTask({ id: "t-root" })];
    const exec = makeExec({
      id: "e1",
      task_id: "t-root",
      started_at: "2024-01-01T10:00:00.000Z",
    });
    const logs: Record<string, SessionLog[]> = {
      e1: [
        makeLog(
          "e1",
          {
            type: "assistant",
            message: {
              content: [
                { type: "tool_use", id: "tu-1", name: "Bash", input: {} },
              ],
            },
          },
          "2024-01-01T10:00:10.000Z",
          0
        ),
        makeLog(
          "e1",
          {
            type: "user",
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "tu-1",
                  content: "ok",
                  is_error: false,
                },
              ],
            },
          },
          "2024-01-01T10:00:20.000Z",
          1
        ),
      ],
    };
    const proj = buildTimelineProjection("t-root", [exec], tasks, logs);
    const tools = proj.tools;
    expect(tools.map((t) => t.kind)).toEqual(["tool_use", "tool_result"]);
    expect(tools[0].toolName).toBe("Bash");
    expect(tools[0].toolId).toBe("tu-1");
    expect(tools[1].toolId).toBe("tu-1");
  });

  it("builds depth-ordered MAIN rows and emits a delegation edge between parent and child", () => {
    const tasks = [
      makeTask({ id: "t-root" }),
      makeTask({ id: "t-child", parent_id: "t-root" }),
    ];
    const parentExec = makeExec({
      id: "ep",
      task_id: "t-root",
      started_at: "2024-01-01T10:00:00.000Z",
    });
    const childExec = makeExec({
      id: "ec",
      task_id: "t-child",
      started_at: "2024-01-01T10:01:00.000Z",
    });
    const proj = buildTimelineProjection(
      "t-root",
      [parentExec, childExec],
      tasks,
      {}
    );
    expect(proj.mainRows).toHaveLength(2);
    expect(proj.mainRows[0].taskId).toBe("t-root");
    expect(proj.mainRows[0].depth).toBe(0);
    expect(proj.mainRows[1].taskId).toBe("t-child");
    expect(proj.mainRows[1].depth).toBe(1);

    expect(proj.delegations).toHaveLength(1);
    const edge = proj.delegations[0];
    expect(edge.parentTaskId).toBe("t-root");
    expect(edge.childTaskId).toBe("t-child");
    expect(edge.parentRowIndex).toBe(0);
    expect(edge.childRowIndex).toBe(1);
    expect(edge.x).toBeCloseTo(1, 5);
    // Legacy delegation edges aren't keyed on TaskRun lineage.
    expect(edge.parentTaskRunId).toBeNull();
    expect(edge.childTaskRunId).toBeNull();
  });
});

describe("buildTimelineProjectionFromProjection", () => {
  it("builds rows per TaskRun and emits run-keyed delegation edges", () => {
    const tasks = [
      makeTask({ id: "t-root" }),
      makeTask({ id: "t-child" }),
    ];
    const runs = [
      makeRun({
        id: "r-root",
        task_id: "t-root",
        started_at: "2024-01-01T10:00:00Z",
      }),
      makeRun({
        id: "r-child",
        task_id: "t-child",
        parent_task_run_id: "r-root",
        triggered_by_step_execution_id: "ep",
        started_at: "2024-01-01T10:00:50Z",
      }),
    ];
    const executions = [
      makeExec({
        id: "ep",
        task_id: "t-root",
        task_run_id: "r-root",
        started_at: "2024-01-01T10:00:00Z",
      }),
      makeExec({
        id: "ec",
        task_id: "t-child",
        task_run_id: "r-child",
        started_at: "2024-01-01T10:01:00Z",
      }),
    ];

    const proj = buildTimelineProjectionFromProjection(
      projectTaskRunTrace(runs, executions, tasks),
      {}
    );

    expect(proj.mainRows).toHaveLength(2);
    expect(proj.mainRows[0]).toMatchObject({
      rowKey: "r-root",
      taskRunId: "r-root",
      depth: 0,
      index: 0,
    });
    expect(proj.mainRows[1]).toMatchObject({
      rowKey: "r-child",
      taskRunId: "r-child",
      depth: 1,
      index: 1,
    });

    expect(proj.delegations).toHaveLength(1);
    const edge = proj.delegations[0];
    expect(edge.parentTaskRunId).toBe("r-root");
    expect(edge.childTaskRunId).toBe("r-child");
    expect(edge.parentRowIndex).toBe(0);
    expect(edge.childRowIndex).toBe(1);
    // Anchor x is at the child's first execution time (the "end" of the
    // observed range here).
    expect(edge.x).toBeCloseTo(1, 5);
  });

  it("buckets thinking markers into mainByRow keyed on the execution's TaskRun, not its task", () => {
    const tasks = [
      makeTask({ id: "t-root" }),
      makeTask({ id: "t-child" }),
    ];
    const runs = [
      makeRun({
        id: "r-root",
        task_id: "t-root",
        started_at: "2024-01-01T10:00:00Z",
      }),
      makeRun({
        id: "r-child",
        task_id: "t-child",
        parent_task_run_id: "r-root",
        started_at: "2024-01-01T10:00:30Z",
      }),
    ];
    const executions = [
      makeExec({
        id: "ep",
        task_id: "t-root",
        task_run_id: "r-root",
        started_at: "2024-01-01T10:00:00Z",
      }),
      makeExec({
        id: "ec",
        task_id: "t-child",
        task_run_id: "r-child",
        started_at: "2024-01-01T10:01:00Z",
      }),
    ];
    const logs: Record<string, SessionLog[]> = {
      ep: [
        makeLog(
          "ep",
          {
            type: "assistant",
            message: { content: [{ type: "text", text: "parent thinking" }] },
          },
          "2024-01-01T10:00:15Z",
          0
        ),
      ],
      ec: [
        makeLog(
          "ec",
          {
            type: "assistant",
            message: { content: [{ type: "text", text: "child thinking" }] },
          },
          "2024-01-01T10:01:30Z",
          0
        ),
      ],
    };
    const proj = buildTimelineProjectionFromProjection(
      projectTaskRunTrace(runs, executions, tasks),
      logs
    );

    expect(proj.mainByRow).toHaveLength(2);
    expect(proj.mainByRow[0].map((m) => m.executionId)).toEqual(["ep"]);
    expect(proj.mainByRow[1].map((m) => m.executionId)).toEqual(["ec"]);
    expect(proj.main).toHaveLength(2);
    // Each main marker carries the rowIndex matching its bucket.
    expect(proj.main.find((m) => m.executionId === "ep")?.rowIndex).toBe(0);
    expect(proj.main.find((m) => m.executionId === "ec")?.rowIndex).toBe(1);
  });

  it("emits model_fallback per-run only (no cross-run fallback) and at the new exec's x", () => {
    const tasks = [
      makeTask({ id: "t-root" }),
      makeTask({ id: "t-child" }),
    ];
    const runs = [
      makeRun({
        id: "r-root",
        task_id: "t-root",
        started_at: "2024-01-01T10:00:00Z",
      }),
      makeRun({
        id: "r-child",
        task_id: "t-child",
        parent_task_run_id: "r-root",
        started_at: "2024-01-01T10:01:00Z",
      }),
    ];
    const executions = [
      // r-root: opus → sonnet (model_fallback expected within this run).
      makeExec({
        id: "p1",
        task_id: "t-root",
        task_run_id: "r-root",
        started_at: "2024-01-01T10:00:00Z",
        model: "claude-opus-4",
      }),
      makeExec({
        id: "p2",
        task_id: "t-root",
        task_run_id: "r-root",
        started_at: "2024-01-01T10:00:30Z",
        model: "claude-sonnet-4",
      }),
      // r-child: only one exec on a different model → no fallback.
      makeExec({
        id: "c1",
        task_id: "t-child",
        task_run_id: "r-child",
        started_at: "2024-01-01T10:01:00Z",
        model: "claude-haiku-4",
      }),
    ];
    const proj = buildTimelineProjectionFromProjection(
      projectTaskRunTrace(runs, executions, tasks),
      {}
    );
    const fallbacks = proj.thresholds.filter((m) => m.kind === "model_fallback");
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0].executionId).toBe("p2");
    // p2 is at the midpoint of [10:00:00, 10:01:00] → x = 0.5.
    expect(fallbacks[0].x).toBeCloseTo(0.5, 5);
    expect(fallbacks[0].label).toBe("claude-opus-4 → claude-sonnet-4");
  });

  it("anchors run-aware delegation x at the child's first execution and binds row indices to the projection order", () => {
    const tasks = [
      makeTask({ id: "t-root" }),
      makeTask({ id: "t-child" }),
    ];
    const runs = [
      makeRun({
        id: "r-root",
        task_id: "t-root",
        started_at: "2024-01-01T10:00:00Z",
      }),
      makeRun({
        id: "r-child",
        task_id: "t-child",
        parent_task_run_id: "r-root",
        triggered_by_step_execution_id: "ep",
        started_at: "2024-01-01T10:00:10Z",
      }),
    ];
    const executions = [
      makeExec({
        id: "ep",
        task_id: "t-root",
        task_run_id: "r-root",
        started_at: "2024-01-01T10:00:00Z",
      }),
      makeExec({
        // Child first execution at 25% through the [10:00:00, 10:01:00] span.
        id: "ec",
        task_id: "t-child",
        task_run_id: "r-child",
        started_at: "2024-01-01T10:00:15Z",
      }),
      makeExec({
        id: "ep2",
        task_id: "t-root",
        task_run_id: "r-root",
        started_at: "2024-01-01T10:01:00Z",
      }),
    ];
    const proj = buildTimelineProjectionFromProjection(
      projectTaskRunTrace(runs, executions, tasks),
      {}
    );
    expect(proj.delegations).toHaveLength(1);
    const edge = proj.delegations[0];
    expect(edge.parentTaskRunId).toBe("r-root");
    expect(edge.childTaskRunId).toBe("r-child");
    expect(edge.parentRowIndex).toBe(0);
    expect(edge.childRowIndex).toBe(1);
    expect(edge.x).toBeCloseTo(0.25, 5);
  });

  it("keeps a failed retry inside the same run row instead of fanning out", () => {
    const tasks = [makeTask({ id: "t-root" })];
    const runs = [
      makeRun({
        id: "r-root",
        task_id: "t-root",
        status: "executing",
        started_at: "2024-01-01T10:00:00Z",
      }),
    ];
    const e1 = makeExec({
      id: "e1",
      task_id: "t-root",
      task_run_id: "r-root",
      step_name: "implement",
      started_at: "2024-01-01T10:00:00Z",
      status: "failed",
    });
    const e2 = makeExec({
      id: "e2",
      task_id: "t-root",
      task_run_id: "r-root",
      step_name: "implement",
      started_at: "2024-01-01T10:01:00Z",
      status: "in_progress",
    });
    const proj = buildTimelineProjectionFromProjection(
      projectTaskRunTrace(runs, [e1, e2], tasks),
      {}
    );

    // Single row keyed on the run; both executions live there.
    expect(proj.mainRows).toHaveLength(1);
    expect(proj.mainRows[0].taskRunId).toBe("r-root");
    // No cross-task delegation edge — both executions belong to the same run.
    expect(proj.delegations).toEqual([]);
    // Same-step retry threshold still surfaces inside the run.
    expect(proj.thresholds.some((m) => m.kind === "retry")).toBe(true);
  });
});

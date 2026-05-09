import { describe, it, expect } from "vitest";
import {
  computeCorridorLayout,
  computeCorridorLayoutFromProjection,
  DEFAULT_CORRIDOR_LAYOUT,
} from "./corridor";
import { projectTaskRunTrace } from "./taskRunTrace";
import type {
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
  workflow_id: "wf-1",
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
  workflow_id: "wf-1",
  step_name: overrides.step_name ?? "implement",
  started_at: overrides.started_at,
  completed_at: overrides.completed_at ?? null,
  status: overrides.status ?? "completed",
  prompt: null,
  output: null,
  context: null,
  transition_result: null,
  model: "claude-opus-4",
  model_provider: "anthropic",
  input_tokens: null,
  output_tokens: null,
  cost: null,
  duration_ms: null,
  handoff: null,
  session_id: null,
});

describe("computeCorridorLayout", () => {
  it("places executions in DFS-ordered columns and time-ordered rows", () => {
    const tasks = [
      makeTask({ id: "root", title: "Root" }),
      makeTask({ id: "child", title: "Child", parent_id: "root" }),
    ];
    const executions = [
      makeExec({ id: "e1", task_id: "root", started_at: "2024-01-01T00:00:00Z" }),
      makeExec({ id: "e2", task_id: "root", started_at: "2024-01-01T00:00:30Z" }),
      makeExec({ id: "e3", task_id: "child", started_at: "2024-01-01T00:00:15Z" }),
    ];

    const layout = computeCorridorLayout("root", executions, tasks);

    expect(layout.lanes.map((l) => l.taskId)).toEqual(["root", "child"]);
    expect(layout.nodes).toHaveLength(3);

    const e1 = layout.nodes.find((n) => n.executionId === "e1");
    const e2 = layout.nodes.find((n) => n.executionId === "e2");
    const e3 = layout.nodes.find((n) => n.executionId === "e3");

    const { columnSpacing, rowSpacing, padding } = DEFAULT_CORRIDOR_LAYOUT;

    expect(e1).toMatchObject({
      column: 0,
      row: 0,
      x: padding,
      y: padding,
    });
    expect(e2).toMatchObject({
      column: 0,
      row: 1,
      x: padding,
      y: padding + rowSpacing,
    });
    expect(e3).toMatchObject({
      column: 1,
      row: 0,
      x: padding + columnSpacing,
      y: padding,
    });
  });

  it("emits transition edges between consecutive executions of the same task", () => {
    const tasks = [makeTask({ id: "root" })];
    const executions = [
      makeExec({ id: "e1", task_id: "root", started_at: "2024-01-01T00:00:00Z" }),
      makeExec({ id: "e2", task_id: "root", started_at: "2024-01-01T00:00:30Z" }),
      makeExec({ id: "e3", task_id: "root", started_at: "2024-01-01T00:01:00Z" }),
    ];

    const layout = computeCorridorLayout("root", executions, tasks);
    const transitions = layout.edges.filter((e) => e.kind === "transition");

    expect(transitions).toHaveLength(2);
    expect(transitions[0]).toMatchObject({
      kind: "transition",
      fromNodeId: "n-e1",
      toNodeId: "n-e2",
    });
    expect(transitions[1]).toMatchObject({
      kind: "transition",
      fromNodeId: "n-e2",
      toNodeId: "n-e3",
    });
  });

  it("emits a delegation edge from the parent's most recent execution to the child's first execution", () => {
    const tasks = [
      makeTask({ id: "root" }),
      makeTask({ id: "child", parent_id: "root" }),
    ];
    const executions = [
      makeExec({ id: "p1", task_id: "root", started_at: "2024-01-01T00:00:00Z" }),
      makeExec({ id: "p2", task_id: "root", started_at: "2024-01-01T00:00:20Z" }),
      makeExec({ id: "c1", task_id: "child", started_at: "2024-01-01T00:00:30Z" }),
      makeExec({ id: "c2", task_id: "child", started_at: "2024-01-01T00:00:45Z" }),
    ];

    const layout = computeCorridorLayout("root", executions, tasks);
    const delegations = layout.edges.filter((e) => e.kind === "delegation");

    expect(delegations).toHaveLength(1);
    expect(delegations[0]).toMatchObject({
      kind: "delegation",
      fromNodeId: "n-p2",
      toNodeId: "n-c1",
    });
  });

  it("classifies node status: failed, active, done", () => {
    const tasks = [makeTask({ id: "root" })];
    const executions = [
      makeExec({
        id: "e-done",
        task_id: "root",
        started_at: "2024-01-01T00:00:00Z",
        status: "completed",
      }),
      makeExec({
        id: "e-active",
        task_id: "root",
        started_at: "2024-01-01T00:00:10Z",
        status: "in_progress",
      }),
      makeExec({
        id: "e-failed",
        task_id: "root",
        started_at: "2024-01-01T00:00:20Z",
        status: "failed",
      }),
      makeExec({
        id: "e-rejected",
        task_id: "root",
        started_at: "2024-01-01T00:00:30Z",
        status: "completed",
        step_name: "reject_review",
      }),
    ];

    const layout = computeCorridorLayout("root", executions, tasks);
    const byId = new Map(layout.nodes.map((n) => [n.executionId, n]));

    expect(byId.get("e-done")?.status).toBe("done");
    expect(byId.get("e-active")?.status).toBe("active");
    expect(byId.get("e-failed")?.status).toBe("failed");
    expect(byId.get("e-rejected")?.status).toBe("failed");
  });

  it("scales: 50+ executions across 5 tasks all get unique positions", () => {
    const tasks = [
      makeTask({ id: "root" }),
      makeTask({ id: "a", parent_id: "root" }),
      makeTask({ id: "b", parent_id: "root" }),
      makeTask({ id: "c", parent_id: "a" }),
      makeTask({ id: "d", parent_id: "b" }),
    ];
    const taskIds = ["root", "a", "b", "c", "d"] as const;
    const executions: StepExecution[] = [];
    let t = 0;
    for (const taskId of taskIds) {
      for (let i = 0; i < 11; i += 1) {
        t += 1000;
        executions.push(
          makeExec({
            id: `e-${taskId}-${i}`,
            task_id: taskId,
            started_at: new Date(t).toISOString(),
          })
        );
      }
    }

    const layout = computeCorridorLayout("root", executions, tasks);
    expect(layout.nodes).toHaveLength(55);

    // All node positions must be unique.
    const positions = new Set(
      layout.nodes.map((n) => `${n.x.toFixed(2)},${n.y.toFixed(2)}`)
    );
    expect(positions.size).toBe(layout.nodes.length);
  });

  it("returns an empty layout when there are no executions", () => {
    const layout = computeCorridorLayout("root", [], [makeTask({ id: "root" })]);
    expect(layout.nodes).toEqual([]);
    expect(layout.edges).toEqual([]);
    expect(layout.lanes).toEqual([]);
  });
});

describe("computeCorridorLayoutFromProjection", () => {
  it("orders lanes by TaskRun lineage and groups executions under their owning run", () => {
    const tasks = [
      makeTask({ id: "t-root" }),
      makeTask({ id: "t-child" }),
    ];
    const runs = [
      makeRun({
        id: "r-root",
        task_id: "t-root",
        started_at: "2024-01-01T00:00:00Z",
      }),
      makeRun({
        id: "r-child",
        task_id: "t-child",
        parent_task_run_id: "r-root",
        triggered_by_step_execution_id: "p2",
        started_at: "2024-01-01T00:00:25Z",
      }),
    ];
    const executions = [
      makeExec({
        id: "p1",
        task_id: "t-root",
        task_run_id: "r-root",
        started_at: "2024-01-01T00:00:00Z",
      }),
      makeExec({
        id: "p2",
        task_id: "t-root",
        task_run_id: "r-root",
        started_at: "2024-01-01T00:00:20Z",
      }),
      makeExec({
        id: "c1",
        task_id: "t-child",
        task_run_id: "r-child",
        started_at: "2024-01-01T00:00:30Z",
      }),
    ];

    const layout = computeCorridorLayoutFromProjection(
      projectTaskRunTrace(runs, executions, tasks)
    );

    expect(layout.lanes.map((l) => l.laneId)).toEqual(["r-root", "r-child"]);
    expect(layout.lanes.map((l) => l.taskRunId)).toEqual([
      "r-root",
      "r-child",
    ]);

    const p1 = layout.nodes.find((n) => n.executionId === "p1");
    const p2 = layout.nodes.find((n) => n.executionId === "p2");
    const c1 = layout.nodes.find((n) => n.executionId === "c1");
    expect(p1?.column).toBe(0);
    expect(p2?.column).toBe(0);
    expect(c1?.column).toBe(1);
    expect(p1?.taskRunId).toBe("r-root");
    expect(c1?.taskRunId).toBe("r-child");

    const delegations = layout.edges.filter((e) => e.kind === "delegation");
    expect(delegations).toHaveLength(1);
    expect(delegations[0]).toMatchObject({
      kind: "delegation",
      fromNodeId: "n-p2",
      toNodeId: "n-c1",
    });
  });

  it("draws the delegation edge from the explicit triggering execution even when it is not the most recent", () => {
    const tasks = [
      makeTask({ id: "t-root" }),
      makeTask({ id: "t-child" }),
    ];
    const runs = [
      makeRun({
        id: "r-root",
        task_id: "t-root",
        started_at: "2024-01-01T00:00:00Z",
      }),
      makeRun({
        id: "r-child",
        task_id: "t-child",
        parent_task_run_id: "r-root",
        triggered_by_step_execution_id: "p1",
        started_at: "2024-01-01T00:00:25Z",
      }),
    ];
    const executions = [
      makeExec({
        id: "p1",
        task_id: "t-root",
        task_run_id: "r-root",
        started_at: "2024-01-01T00:00:00Z",
      }),
      makeExec({
        id: "p2",
        task_id: "t-root",
        task_run_id: "r-root",
        started_at: "2024-01-01T00:00:20Z",
      }),
      makeExec({
        id: "c1",
        task_id: "t-child",
        task_run_id: "r-child",
        started_at: "2024-01-01T00:00:30Z",
      }),
    ];

    const layout = computeCorridorLayoutFromProjection(
      projectTaskRunTrace(runs, executions, tasks)
    );
    const delegations = layout.edges.filter((e) => e.kind === "delegation");
    // p1 is the explicit trigger even though p2 is more recent — explicit
    // lineage wins over chronological inference.
    expect(delegations[0]).toMatchObject({ fromNodeId: "n-p1", toNodeId: "n-c1" });
  });

  it("places run-aware lanes/nodes at exact pixel positions and computes width/height", () => {
    const tasks = [
      makeTask({ id: "t-root" }),
      makeTask({ id: "t-child" }),
    ];
    const runs = [
      makeRun({
        id: "r-root",
        task_id: "t-root",
        started_at: "2024-01-01T00:00:00Z",
      }),
      makeRun({
        id: "r-child",
        task_id: "t-child",
        parent_task_run_id: "r-root",
        started_at: "2024-01-01T00:00:25Z",
      }),
    ];
    const executions = [
      makeExec({
        id: "p1",
        task_id: "t-root",
        task_run_id: "r-root",
        started_at: "2024-01-01T00:00:00Z",
      }),
      makeExec({
        id: "p2",
        task_id: "t-root",
        task_run_id: "r-root",
        started_at: "2024-01-01T00:00:10Z",
      }),
      makeExec({
        id: "p3",
        task_id: "t-root",
        task_run_id: "r-root",
        started_at: "2024-01-01T00:00:20Z",
      }),
      makeExec({
        id: "c1",
        task_id: "t-child",
        task_run_id: "r-child",
        started_at: "2024-01-01T00:00:30Z",
      }),
    ];
    const layout = computeCorridorLayoutFromProjection(
      projectTaskRunTrace(runs, executions, tasks)
    );
    const { columnSpacing, rowSpacing, padding } = DEFAULT_CORRIDOR_LAYOUT;

    // Lane x = padding + column * columnSpacing; per-lane node count tracked.
    expect(layout.lanes[0]).toMatchObject({
      column: 0,
      x: padding,
      nodeCount: 3,
    });
    expect(layout.lanes[1]).toMatchObject({
      column: 1,
      x: padding + columnSpacing,
      nodeCount: 1,
    });

    const byId = new Map(layout.nodes.map((n) => [n.executionId, n]));
    // Within r-root, rows are 0..2 with y stepping by rowSpacing.
    expect(byId.get("p1")).toMatchObject({
      column: 0,
      row: 0,
      x: padding,
      y: padding,
    });
    expect(byId.get("p2")).toMatchObject({
      column: 0,
      row: 1,
      x: padding,
      y: padding + rowSpacing,
    });
    expect(byId.get("p3")).toMatchObject({
      column: 0,
      row: 2,
      x: padding,
      y: padding + 2 * rowSpacing,
    });
    // r-child first row resets to row 0 in a new column.
    expect(byId.get("c1")).toMatchObject({
      column: 1,
      row: 0,
      x: padding + columnSpacing,
      y: padding,
    });

    // width spans (lanes-1) gaps + 2*padding; height accommodates max row.
    expect(layout.width).toBe(padding * 2 + columnSpacing);
    expect(layout.height).toBe(padding * 2 + 2 * rowSpacing);
  });

  it("returns empty lanes/nodes/edges and minimal canvas when the projection has no runs", () => {
    const layout = computeCorridorLayoutFromProjection(
      projectTaskRunTrace([], [], [])
    );
    expect(layout.lanes).toEqual([]);
    expect(layout.nodes).toEqual([]);
    expect(layout.edges).toEqual([]);
    expect(layout.width).toBe(DEFAULT_CORRIDOR_LAYOUT.padding * 2);
    expect(layout.height).toBe(DEFAULT_CORRIDOR_LAYOUT.padding * 2);
  });

  it("emits transition edges between consecutive executions within the same run lane", () => {
    const tasks = [makeTask({ id: "t-root" })];
    const runs = [
      makeRun({
        id: "r-root",
        task_id: "t-root",
        started_at: "2024-01-01T00:00:00Z",
      }),
    ];
    const executions = [
      makeExec({
        id: "a",
        task_id: "t-root",
        task_run_id: "r-root",
        started_at: "2024-01-01T00:00:00Z",
      }),
      makeExec({
        id: "b",
        task_id: "t-root",
        task_run_id: "r-root",
        started_at: "2024-01-01T00:00:10Z",
      }),
      makeExec({
        id: "c",
        task_id: "t-root",
        task_run_id: "r-root",
        started_at: "2024-01-01T00:00:20Z",
      }),
    ];
    const layout = computeCorridorLayoutFromProjection(
      projectTaskRunTrace(runs, executions, tasks)
    );
    const transitions = layout.edges.filter((e) => e.kind === "transition");
    expect(transitions).toEqual([
      { id: "e-tr-a-b", kind: "transition", fromNodeId: "n-a", toNodeId: "n-b" },
      { id: "e-tr-b-c", kind: "transition", fromNodeId: "n-b", toNodeId: "n-c" },
    ]);
  });

  it("a failed StepExecution does not change the owning TaskRun lane: per-node failed status is independent of the run", () => {
    const tasks = [makeTask({ id: "t-root" })];
    const runs = [
      makeRun({
        id: "r-root",
        task_id: "t-root",
        status: "executing",
        started_at: "2024-01-01T00:00:00Z",
      }),
    ];
    const executions = [
      makeExec({
        id: "e-fail",
        task_id: "t-root",
        task_run_id: "r-root",
        status: "failed",
        started_at: "2024-01-01T00:00:00Z",
      }),
      makeExec({
        id: "e-retry",
        task_id: "t-root",
        task_run_id: "r-root",
        status: "in_progress",
        started_at: "2024-01-01T00:00:10Z",
      }),
    ];
    const layout = computeCorridorLayoutFromProjection(
      projectTaskRunTrace(runs, executions, tasks)
    );
    // Both nodes belong to the same lane (one run); their per-node statuses
    // remain independent — a failed step alongside an active retry must not
    // collapse the trace into a single failed lane.
    expect(layout.lanes).toHaveLength(1);
    const fail = layout.nodes.find((n) => n.executionId === "e-fail");
    const retry = layout.nodes.find((n) => n.executionId === "e-retry");
    expect(fail?.status).toBe("failed");
    expect(retry?.status).toBe("active");
    expect(fail?.taskRunId).toBe("r-root");
    expect(retry?.taskRunId).toBe("r-root");
  });
});

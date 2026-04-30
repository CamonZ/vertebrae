import { describe, it, expect } from "vitest";
import { computeCorridorLayout, DEFAULT_CORRIDOR_LAYOUT } from "./corridor";
import type { StepExecution, Task } from "../../bindings";

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

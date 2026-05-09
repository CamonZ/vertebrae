import { describe, it, expect } from "vitest";
import {
  projectTaskRunTrace,
  resolveParentExecution,
} from "./taskRunTrace";
import type {
  StepExecution,
  Task,
  TaskRun,
  TaskRunStatus,
} from "../../bindings";

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
  inserted_at: overrides.inserted_at ?? "2024-01-01T00:00:00.000Z",
  updated_at: overrides.updated_at ?? "2024-01-01T00:00:00.000Z",
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

describe("projectTaskRunTrace", () => {
  it("orders runs DFS from root using parent_task_run_id", () => {
    const tasks = [
      makeTask({ id: "t-root" }),
      makeTask({ id: "t-child" }),
      makeTask({ id: "t-grand" }),
    ];
    const runs = [
      makeRun({
        id: "r-grand",
        task_id: "t-grand",
        parent_task_run_id: "r-child",
        started_at: "2024-01-01T00:02:00Z",
      }),
      makeRun({
        id: "r-child",
        task_id: "t-child",
        parent_task_run_id: "r-root",
        started_at: "2024-01-01T00:01:00Z",
      }),
      makeRun({
        id: "r-root",
        task_id: "t-root",
        started_at: "2024-01-01T00:00:00Z",
      }),
    ];
    const proj = projectTaskRunTrace(runs, [], tasks);

    expect(proj.orderedRuns.map((n) => n.run.id)).toEqual([
      "r-root",
      "r-child",
      "r-grand",
    ]);
    expect(proj.orderedRuns.map((n) => n.depth)).toEqual([0, 1, 2]);
    expect(proj.runsById.get("r-root")?.childRunIds).toEqual(["r-child"]);
    expect(proj.runsById.get("r-child")?.childRunIds).toEqual(["r-grand"]);
    expect(proj.hasRuns).toBe(true);
  });

  it("buckets executions by task_run_id and lists orphans", () => {
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
        id: "e1",
        task_id: "t-root",
        task_run_id: "r-root",
        started_at: "2024-01-01T00:00:30Z",
      }),
      makeExec({
        id: "e2",
        task_id: "t-root",
        task_run_id: "r-root",
        started_at: "2024-01-01T00:00:10Z",
      }),
      makeExec({
        id: "e-orphan",
        task_id: "t-root",
        task_run_id: null,
        started_at: "2024-01-01T00:00:05Z",
      }),
      makeExec({
        id: "e-unknown-run",
        task_id: "t-root",
        task_run_id: "r-missing",
        started_at: "2024-01-01T00:00:07Z",
      }),
    ];

    const proj = projectTaskRunTrace(runs, executions, tasks);
    const rootNode = proj.runsById.get("r-root")!;

    // Executions sorted by started_at ascending.
    expect(rootNode.executions.map((e) => e.id)).toEqual(["e2", "e1"]);
    // Orphans include both the null and unknown-run cases, also sorted.
    expect(proj.orphanExecutions.map((e) => e.id)).toEqual([
      "e-orphan",
      "e-unknown-run",
    ]);
  });

  it("emits a delegation edge per child run resolving the triggering execution", () => {
    const tasks = [
      makeTask({ id: "t-root" }),
      makeTask({ id: "t-child" }),
    ];
    const parentExecs = [
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
    ];
    const childExec = makeExec({
      id: "c1",
      task_id: "t-child",
      task_run_id: "r-child",
      started_at: "2024-01-01T00:00:30Z",
    });
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
    const proj = projectTaskRunTrace(
      runs,
      [...parentExecs, childExec],
      tasks
    );

    expect(proj.delegationEdges).toHaveLength(1);
    const edge = proj.delegationEdges[0];
    expect(edge.parentRunId).toBe("r-root");
    expect(edge.childRunId).toBe("r-child");
    expect(edge.triggeringExecutionId).toBe("p2");
    const parent = resolveParentExecution(proj, edge);
    expect(parent?.id).toBe("p2");
  });

  it("falls back to the latest parent execution before the child started when the trigger is unknown", () => {
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
        triggered_by_step_execution_id: "p-missing",
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
        id: "p-after",
        task_id: "t-root",
        task_run_id: "r-root",
        started_at: "2024-01-01T00:01:00Z",
      }),
      makeExec({
        id: "c1",
        task_id: "t-child",
        task_run_id: "r-child",
        started_at: "2024-01-01T00:00:30Z",
      }),
    ];
    const proj = projectTaskRunTrace(runs, executions, tasks);
    const edge = proj.delegationEdges[0];
    expect(edge.triggeringExecutionId).toBeNull();
    // p2 started before c1 (00:00:20 vs 00:00:30) and is the most recent
    // such execution. p-after started after c1 and must not be picked.
    const parent = resolveParentExecution(proj, edge);
    expect(parent?.id).toBe("p2");
  });

  it("nulls triggeringExecutionId when the trigger execution belongs to a different run than the parent", () => {
    const tasks = [
      makeTask({ id: "t-root" }),
      makeTask({ id: "t-sibling" }),
      makeTask({ id: "t-child" }),
    ];
    const runs = [
      makeRun({
        id: "r-root",
        task_id: "t-root",
        started_at: "2024-01-01T00:00:00Z",
      }),
      makeRun({
        id: "r-sibling",
        task_id: "t-sibling",
        started_at: "2024-01-01T00:00:05Z",
      }),
      makeRun({
        id: "r-child",
        task_id: "t-child",
        parent_task_run_id: "r-root",
        // Trigger id resolves to an execution owned by a *different* run.
        triggered_by_step_execution_id: "x-sibling",
        started_at: "2024-01-01T00:00:30Z",
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
        id: "x-sibling",
        task_id: "t-sibling",
        task_run_id: "r-sibling",
        started_at: "2024-01-01T00:00:10Z",
      }),
    ];
    const proj = projectTaskRunTrace(runs, executions, tasks);
    const edge = proj.delegationEdges.find((e) => e.childRunId === "r-child")!;
    expect(edge.parentRunId).toBe("r-root");
    expect(edge.triggeringExecutionId).toBeNull();
  });

  it("returns hasRuns=false and surfaces every execution as orphan when no runs are provided", () => {
    const tasks = [makeTask({ id: "t-root" })];
    const executions = [
      makeExec({
        id: "e1",
        task_id: "t-root",
        task_run_id: "r-root",
        started_at: "2024-01-01T00:00:00Z",
      }),
    ];
    const proj = projectTaskRunTrace([], executions, tasks);
    expect(proj.hasRuns).toBe(false);
    expect(proj.orderedRuns).toHaveLength(0);
    expect(proj.delegationEdges).toHaveLength(0);
    expect(proj.orphanExecutions.map((e) => e.id)).toEqual(["e1"]);
  });
});

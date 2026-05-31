import { describe, it, expect } from "vitest";
import type { Task } from "../bindings";
import type { TaskTreeNode } from "../types/ui";
import { computeVisibleChildren, isDoneLeaf } from "./computeVisibleChildren";

function task(overrides?: Partial<Task>): Task {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    title: "Task",
    description: null,
    level: "task",
    priority: null,
    tags: [],
    workflow_id: null,
    current_step_id: null,
    workflow_name: null,
    step_name: null,
    archived: false,
    worktree: null,
    rejection_reason: null,
    parent_id: null,
    dependency_ids: [],
    sections: [],
    code_refs: [],
    run_controls: null,
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
    started_at: null,
    completed_at: null,
    ...overrides,
  };
}

function node(t: Task, children: TaskTreeNode[] = []): TaskTreeNode {
  return { task: t, has_blockers: false, blocker_count: 0, children };
}

const doneLeaf = (id: string) =>
  node(task({ id, completed_at: "2025-01-02T00:00:00Z" }));
const openLeaf = (id: string) => node(task({ id }));

const opts = (
  over?: Partial<Parameters<typeof computeVisibleChildren>[1]>
) => ({
  hideCompleted: false,
  filtering: false,
  ...over,
});

describe("isDoneLeaf", () => {
  it("is true for a completed task with no children", () => {
    expect(
      isDoneLeaf(node(task({ completed_at: "2025-01-02T00:00:00Z" })))
    ).toBe(true);
  });

  it("is true when the run finished completed", () => {
    const t = task({
      run_controls: {
        runnable: false,
        stoppable: false,
        disabled_reason_code: null,
        disabled_reason: null,
        active_run: {
          id: "r",
          task_id: "t",
          project_id: "p",
          user_id: null,
          status: "completed",
          started_at: null,
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
        },
      },
    });
    expect(isDoneLeaf(node(t))).toBe(true);
  });

  it("is false for a completed PARENT (has children)", () => {
    const parent = node(task({ completed_at: "2025-01-02T00:00:00Z" }), [
      openLeaf("c1"),
    ]);
    expect(isDoneLeaf(parent)).toBe(false);
  });

  it("is false for an incomplete leaf", () => {
    expect(isDoneLeaf(openLeaf("x"))).toBe(false);
  });
});

describe("computeVisibleChildren", () => {
  it("returns children unchanged while filtering", () => {
    const parent = node(task({ id: "p" }), [
      doneLeaf("a"),
      doneLeaf("b"),
      doneLeaf("c"),
      doneLeaf("d"),
    ]);
    const out = computeVisibleChildren(parent, opts({ filtering: true }));
    expect(out).toHaveLength(4);
    expect(out.every((c) => c.kind === "node")).toBe(true);
  });

  it("omits done leaves (only) when hideCompleted is on", () => {
    const doneParent = node(
      task({ id: "dp", completed_at: "2025-01-02T00:00:00Z" }),
      [openLeaf("gc")]
    );
    const parent = node(task({ id: "p" }), [
      openLeaf("open"),
      doneLeaf("done1"),
      doneParent,
    ]);
    const out = computeVisibleChildren(parent, opts({ hideCompleted: true }));
    const ids = out
      .filter(
        (c): c is { kind: "node"; node: TaskTreeNode } => c.kind === "node"
      )
      .map((c) => c.node.task.id);
    // open leaf and the completed PARENT survive; the done leaf is gone.
    expect(ids).toEqual(["open", "dp"]);
  });
});

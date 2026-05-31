import { describe, it, expect } from "vitest";
import type { Task } from "../bindings";
import type { TaskTreeNode } from "../types/ui";
import {
  COLLAPSE_THRESHOLD,
  computeVisibleChildren,
  computeVisibleRoots,
  isFullyComplete,
  ROOT_SUMMARY_KEY,
} from "./computeVisibleChildren";

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
  summaryExpanded: new Set<string>(),
  ...over,
});

describe("isFullyComplete", () => {
  it("is true for a completed task with no children", () => {
    expect(
      isFullyComplete(node(task({ completed_at: "2025-01-02T00:00:00Z" })))
    ).toBe(true);
  });

  it("is false when the run finished completed but completed_at is unset", () => {
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
    expect(isFullyComplete(node(t))).toBe(false);
  });

  it("is true for a completed PARENT whose children are all complete", () => {
    const parent = node(task({ completed_at: "2025-01-02T00:00:00Z" }), [
      doneLeaf("c1"),
      doneLeaf("c2"),
    ]);
    expect(isFullyComplete(parent)).toBe(true);
  });

  it("is false for a completed PARENT with an open child", () => {
    const parent = node(task({ completed_at: "2025-01-02T00:00:00Z" }), [
      openLeaf("c1"),
    ]);
    expect(isFullyComplete(parent)).toBe(false);
  });

  it("is false for an incomplete leaf", () => {
    expect(isFullyComplete(openLeaf("x"))).toBe(false);
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

  it("omits fully-complete children when hideCompleted is on, keeping ones with open work", () => {
    const partlyDoneParent = node(
      task({ id: "dp", completed_at: "2025-01-02T00:00:00Z" }),
      [openLeaf("gc")]
    );
    const parent = node(task({ id: "p" }), [
      openLeaf("open"),
      doneLeaf("done1"),
      partlyDoneParent,
    ]);
    const out = computeVisibleChildren(parent, opts({ hideCompleted: true }));
    const ids = out
      .filter(
        (c): c is { kind: "node"; node: TaskTreeNode } => c.kind === "node"
      )
      .map((c) => c.node.task.id);
    // The open leaf and the completed-but-not-fully-done parent (it has an open
    // child) survive; the fully-complete done leaf is gone.
    expect(ids).toEqual(["open", "dp"]);
  });

  it("collapses >= threshold done leaves into one summary when hide is off", () => {
    const leaves = Array.from({ length: COLLAPSE_THRESHOLD }, (_, i) =>
      doneLeaf(`d${i}`)
    );
    const parent = node(task({ id: "p" }), [openLeaf("open"), ...leaves]);
    const out = computeVisibleChildren(parent, opts());
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ kind: "node", node: parent.children[0] });
    expect(out[1]).toEqual({
      kind: "summary",
      parentId: "p",
      count: COLLAPSE_THRESHOLD,
    });
  });

  it("folds fully-complete PARENTS into the summary, not just leaves", () => {
    // Three completed tickets, each with a completed child task — every one is
    // fully complete, so all three fold even though none is a leaf.
    const completedParent = (id: string) =>
      node(task({ id, completed_at: "2025-01-02T00:00:00Z" }), [
        doneLeaf(`${id}-child`),
      ]);
    const parent = node(task({ id: "epic" }), [
      openLeaf("open"),
      completedParent("t0"),
      completedParent("t1"),
      completedParent("t2"),
    ]);
    const out = computeVisibleChildren(parent, opts());
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ kind: "node", node: parent.children[0] });
    expect(out[1]).toEqual({ kind: "summary", parentId: "epic", count: 3 });
  });

  it("does NOT collapse fewer than threshold done leaves", () => {
    const parent = node(task({ id: "p" }), [doneLeaf("d0"), doneLeaf("d1")]);
    const out = computeVisibleChildren(parent, opts());
    expect(out).toHaveLength(2);
    expect(out.every((c) => c.kind === "node")).toBe(true);
  });

  it("expands the folded leaves inline when the parent is in summaryExpanded", () => {
    const parent = node(task({ id: "p" }), [
      doneLeaf("d0"),
      doneLeaf("d1"),
      doneLeaf("d2"),
    ]);
    const out = computeVisibleChildren(
      parent,
      opts({ summaryExpanded: new Set(["p"]) })
    );
    expect(out[0]).toEqual({ kind: "summary", parentId: "p", count: 3 });
    expect(
      out.slice(1).map((c) => (c.kind === "node" ? c.node.task.id : c.kind))
    ).toEqual(["d0", "d1", "d2"]);
  });

  it("hideCompleted bypasses collapse (no summary, leaves gone)", () => {
    const parent = node(task({ id: "p" }), [
      doneLeaf("d0"),
      doneLeaf("d1"),
      doneLeaf("d2"),
    ]);
    const out = computeVisibleChildren(parent, opts({ hideCompleted: true }));
    expect(out).toHaveLength(0);
  });
});

describe("computeVisibleRoots", () => {
  it("folds >= threshold completed top-level siblings under the root key", () => {
    const roots = [
      openLeaf("open"),
      doneLeaf("r0"),
      doneLeaf("r1"),
      doneLeaf("r2"),
    ];
    const out = computeVisibleRoots(roots, opts());
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ kind: "node", node: roots[0] });
    expect(out[1]).toEqual({
      kind: "summary",
      parentId: ROOT_SUMMARY_KEY,
      count: 3,
    });
  });

  it("re-emits the folded roots inline when the root key is expanded", () => {
    const roots = [doneLeaf("r0"), doneLeaf("r1"), doneLeaf("r2")];
    const out = computeVisibleRoots(
      roots,
      opts({ summaryExpanded: new Set([ROOT_SUMMARY_KEY]) })
    );
    expect(out[0]).toEqual({
      kind: "summary",
      parentId: ROOT_SUMMARY_KEY,
      count: 3,
    });
    expect(
      out.slice(1).map((c) => (c.kind === "node" ? c.node.task.id : c.kind))
    ).toEqual(["r0", "r1", "r2"]);
  });

  it("does not fold fewer than threshold completed roots", () => {
    const roots = [doneLeaf("r0"), doneLeaf("r1")];
    const out = computeVisibleRoots(roots, opts());
    expect(out).toHaveLength(2);
    expect(out.every((c) => c.kind === "node")).toBe(true);
  });
});

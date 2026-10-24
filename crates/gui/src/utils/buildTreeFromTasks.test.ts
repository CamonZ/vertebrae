import { describe, expect, it } from "vitest";
import { createMockTask } from "../test/test-utils";
import { buildTreeFromTasks } from "./buildTreeFromTasks";

describe("buildTreeFromTasks blocker metadata", () => {
  it("uses server-derived blocked state rather than dependency ids", () => {
    const blocked = createMockTask({
      id: "blocked",
      dependency_ids: [],
      run_controls: {
        runnable: false,
        stoppable: false,
        disabled_reason_code: "blocked",
        disabled_reason: "Task has incomplete blockers",
        active_run: null,
      },
    });
    const completedDependencies = createMockTask({
      id: "completed-dependencies",
      dependency_ids: ["finished-blocker"],
      run_controls: {
        runnable: true,
        stoppable: false,
        disabled_reason_code: null,
        disabled_reason: null,
        active_run: null,
      },
    });
    const noDependencies = createMockTask({ id: "no-dependencies" });

    const nodes = buildTreeFromTasks([
      blocked,
      completedDependencies,
      noDependencies,
    ]);

    expect(nodes.find((node) => node.task.id === "blocked")).toMatchObject({
      has_blockers: true,
      blocker_count: 1,
    });
    expect(
      nodes.find((node) => node.task.id === "completed-dependencies")
    ).toMatchObject({ has_blockers: false, blocker_count: 0 });
    expect(
      nodes.find((node) => node.task.id === "no-dependencies")
    ).toMatchObject({
      has_blockers: false,
      blocker_count: 0,
    });
  });
});

describe("reusable task tree snapshots", () => {
  it("reuses unaffected siblings while refreshing the changed leaf and ancestors", () => {
    const parent = createMockTask({ id: "parent", parent_id: null });
    const a = createMockTask({ id: "a", parent_id: "parent" });
    const b = createMockTask({ id: "b", parent_id: "parent" });
    const other = createMockTask({ id: "other", parent_id: null });
    const cache = new WeakMap();
    const before = buildTreeFromTasks([parent, a, b, other], cache);
    const changed = {
      ...a,
      title: "Changed",
      completed_at: "2026-10-24T00:00:00Z",
    };
    const after = buildTreeFromTasks([parent, changed, b, other], cache);
    expect(after[0]).not.toBe(before[0]);
    expect(after[0].children[0].task).toBe(changed);
    expect(after[0].children[1]).toBe(before[0].children[1]);
    expect(after[1]).toBe(before[1]);
    expect(before[0].children[0].task).toBe(a);
  });

  it("refreshes membership and order when a cached parent is filtered or reordered", () => {
    const parent = createMockTask({ id: "parent", parent_id: null });
    const a = createMockTask({ id: "a", parent_id: "parent" });
    const b = createMockTask({ id: "b", parent_id: "parent" });
    const cache = new WeakMap();
    const original = buildTreeFromTasks([parent, a, b], cache);
    expect(
      buildTreeFromTasks([parent, b, a], cache)[0].children.map(
        (n) => n.task.id
      )
    ).toEqual(["b", "a"]);
    expect(
      buildTreeFromTasks([parent, b], cache)[0].children.map((n) => n.task.id)
    ).toEqual(["b"]);
    expect(
      buildTreeFromTasks([parent, a, b], cache)[0].children.map(
        (n) => n.task.id
      )
    ).toEqual(["a", "b"]);
    expect(original[0].children.map((n) => n.task.id)).toEqual(["a", "b"]);
  });
});

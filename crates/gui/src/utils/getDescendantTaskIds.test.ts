import { describe, expect, it } from "vitest";
import { getDescendantTaskIds } from "./getDescendantTaskIds";
import { createMockTask } from "../test/test-utils";

describe("getDescendantTaskIds", () => {
  it("returns just the root id when the root has no children", () => {
    const root = createMockTask({ id: "root", parent_id: null });
    const ids = getDescendantTaskIds("root", [root]);
    expect(ids).toEqual(["root"]);
  });

  it("returns root + every descendant across multiple levels", () => {
    const root = createMockTask({ id: "epic", parent_id: null });
    const t1 = createMockTask({ id: "ticket-1", parent_id: "epic" });
    const t2 = createMockTask({ id: "ticket-2", parent_id: "epic" });
    const task1 = createMockTask({ id: "task-1", parent_id: "ticket-1" });
    const task2 = createMockTask({ id: "task-2", parent_id: "ticket-1" });
    const unrelated = createMockTask({ id: "unrelated", parent_id: null });

    const ids = getDescendantTaskIds("epic", [root, t1, t2, task1, task2, unrelated]);

    expect(new Set(ids)).toEqual(
      new Set(["epic", "ticket-1", "ticket-2", "task-1", "task-2"])
    );
    expect(ids).toHaveLength(5);
    expect(ids).not.toContain("unrelated");
  });

  it("returns an empty array when the root id is not in the task set", () => {
    const t = createMockTask({ id: "x", parent_id: null });
    expect(getDescendantTaskIds("missing", [t])).toEqual([]);
  });

  it("does not include siblings of the root", () => {
    const root = createMockTask({ id: "r", parent_id: null });
    const sibling = createMockTask({ id: "s", parent_id: null });
    const child = createMockTask({ id: "c", parent_id: "r" });
    const ids = getDescendantTaskIds("r", [root, sibling, child]);
    expect(new Set(ids)).toEqual(new Set(["r", "c"]));
  });

  it("handles a cycle in parent_id without infinite-looping", () => {
    // Defensive: malformed parent chain a -> b -> a should still terminate.
    const a = createMockTask({ id: "a", parent_id: "b" });
    const b = createMockTask({ id: "b", parent_id: "a" });
    const c = createMockTask({ id: "c", parent_id: "a" });
    const ids = getDescendantTaskIds("a", [a, b, c]);
    expect(new Set(ids)).toEqual(new Set(["a", "b", "c"]));
  });
});

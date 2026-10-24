import { describe, it, expect } from "vitest";
import { replaceEqualDeep } from "@tanstack/react-query";
import { createMockTask } from "../test/test-utils";
import { shareTaskList } from "./taskListSharing";

describe("task list structural sharing", () => {
  it("matches generic sharing for snapshots, nested updates, no-ops and membership changes", () => {
    const a = createMockTask({ id: "a", tags: ["one"] });
    const b = createMockTask({ id: "b" });
    const before = [a, b];
    for (const next of [
      [a, b],
      [{ ...a, tags: ["one"] }, b],
      [{ ...a, tags: ["two"] }, b],
      [b],
      [b, a],
      [],
      [a, b, createMockTask({ id: "c" })],
    ]) {
      const actual = shareTaskList(before, next);
      expect(actual).toEqual(replaceEqualDeep(before, next));
      if (JSON.stringify(before) === JSON.stringify(next))
        expect(actual).toBe(before);
    }
    const changed = shareTaskList(before, [
      { ...a, title: "Changed" },
      b,
    ]) as typeof before;
    expect(changed[1]).toBe(b);
    expect(changed[0].tags).toBe(a.tags);
    expect(before[0].title).toBe(a.title);
    expect(shareTaskList(undefined, before)).toBe(before);
  });
});

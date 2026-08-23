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
    expect(nodes.find((node) => node.task.id === "no-dependencies")).toMatchObject({
      has_blockers: false,
      blocker_count: 0,
    });
  });
});

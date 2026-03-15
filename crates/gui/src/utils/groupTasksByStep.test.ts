import { describe, it, expect } from "vitest";
import { groupTasksByStep } from "./groupTasksByStep";
import type { Step, Task } from "../bindings";
import { createMockTask } from "../test/test-utils";

// Helper to create a Task with a specific current_step_id
function createTaskWithStep(id: string, currentStepId: string | null): Task {
  return createMockTask({ id, current_step_id: currentStepId });
}

// Helper to create a Step
function createStep(id: string, name: string, order: number): Step {
  return {
    id,
    name,
    workflow_id: "test_workflow",
    goal: null,
    prompt: null,
    eval_prompt: null,
    agent_config: {
      model: "haiku",
      fallback_model: null,
      system_prompt: null,
      append_system_prompt: null,
      agents: null,
      tools: [],
      allowed_tools: [],
      disallowed_tools: [],
      permission_mode: null,
      max_budget_usd: null,
      mcp_config: [],
      plugin_dirs: [],
      json_schema: null,
    },
    is_final: false,
    transitions_to: [],
    order,
    created_at: null,
    updated_at: null,
  };
}

describe("groupTasksByStep", () => {
  // Steps with random IDs (new format)
  const stepsWithRandomIds: Step[] = [
    createStep("abc123xyz", "todo", 0),
    createStep("def456uvw", "in_progress", 1),
    createStep("ghi789rst", "done", 2),
  ];

  // Steps with legacy IDs (workflow_id_step_name format)
  const stepsWithLegacyIds: Step[] = [
    createStep("x1cff77_todo", "todo", 0),
    createStep("x1cff77_in_progress", "in_progress", 1),
    createStep("x1cff77_done", "done", 2),
  ];

  it("groups tasks by direct step ID match (new format)", () => {
    const tasks: Task[] = [
      createTaskWithStep("task1", "abc123xyz"),
      createTaskWithStep("task2", "def456uvw"),
      createTaskWithStep("task3", "ghi789rst"),
    ];

    const groups = groupTasksByStep(tasks, stepsWithRandomIds);

    expect(groups.get("todo")?.length).toBe(1);
    expect(groups.get("todo")?.[0].id).toBe("task1");

    expect(groups.get("in_progress")?.length).toBe(1);
    expect(groups.get("in_progress")?.[0].id).toBe("task2");

    expect(groups.get("done")?.length).toBe(1);
    expect(groups.get("done")?.[0].id).toBe("task3");
  });

  it("groups tasks by matching step name as suffix (legacy format)", () => {
    const tasks: Task[] = [
      createTaskWithStep("task1", "default_todo"),
      createTaskWithStep("task2", "default_done"),
      createTaskWithStep("task3", "x1cff77_in_progress"),
    ];

    const groups = groupTasksByStep(tasks, stepsWithLegacyIds);

    expect(groups.get("todo")?.length).toBe(1);
    expect(groups.get("todo")?.[0].id).toBe("task1");

    expect(groups.get("done")?.length).toBe(1);
    expect(groups.get("done")?.[0].id).toBe("task2");

    expect(groups.get("in_progress")?.length).toBe(1);
    expect(groups.get("in_progress")?.[0].id).toBe("task3");
  });

  it("handles multi-word step names like in_progress", () => {
    const tasks: Task[] = [
      createTaskWithStep("task1", "default_in_progress"),
      createTaskWithStep("task2", "workflow123_in_progress"),
    ];

    const groups = groupTasksByStep(tasks, stepsWithLegacyIds);

    expect(groups.get("in_progress")?.length).toBe(2);
    expect(groups.get("in_progress")?.[0].id).toBe("task1");
    expect(groups.get("in_progress")?.[1].id).toBe("task2");
  });

  it("falls back to first step when current_step_id is null", () => {
    const tasks: Task[] = [createTaskWithStep("task1", null)];

    const groups = groupTasksByStep(tasks, stepsWithLegacyIds);

    expect(groups.get("todo")?.length).toBe(1);
    expect(groups.get("todo")?.[0].id).toBe("task1");
  });

  it("falls back to first step when step ID does not match", () => {
    const tasks: Task[] = [
      createTaskWithStep("task1", "unknown_random_id"),
    ];

    const groups = groupTasksByStep(tasks, stepsWithRandomIds);

    expect(groups.get("todo")?.length).toBe(1);
    expect(groups.get("todo")?.[0].id).toBe("task1");
  });

  it("initializes empty arrays for all steps", () => {
    const groups = groupTasksByStep([], stepsWithLegacyIds);

    expect(groups.get("todo")).toEqual([]);
    expect(groups.get("in_progress")).toEqual([]);
    expect(groups.get("done")).toEqual([]);
  });

  it("sorts steps by order before grouping", () => {
    const unorderedSteps: Step[] = [
      createStep("s3", "done", 2),
      createStep("s1", "todo", 0),
      createStep("s2", "in_progress", 1),
    ];

    const tasks: Task[] = [
      createTaskWithStep("task1", null), // Should go to first step by order
    ];

    const groups = groupTasksByStep(tasks, unorderedSteps);

    // Should fall back to "todo" (order 0), not "done" (first in array)
    expect(groups.get("todo")?.length).toBe(1);
  });

  it("handles case-insensitive step ID matching", () => {
    const tasks: Task[] = [
      createTaskWithStep("task1", "ABC123XYZ"),
      createTaskWithStep("task2", "GHI789RST"),
    ];

    const groups = groupTasksByStep(tasks, stepsWithRandomIds);

    expect(groups.get("todo")?.length).toBe(1);
    expect(groups.get("done")?.length).toBe(1);
  });

  it("handles case-insensitive legacy step matching", () => {
    const tasks: Task[] = [
      createTaskWithStep("task1", "DEFAULT_TODO"),
      createTaskWithStep("task2", "x1cff77_DONE"),
    ];

    const groups = groupTasksByStep(tasks, stepsWithLegacyIds);

    expect(groups.get("todo")?.length).toBe(1);
    expect(groups.get("done")?.length).toBe(1);
  });

  it("handles steps from different workflows pointing to same step name", () => {
    const tasks: Task[] = [
      createTaskWithStep("task1", "default_done"),
      createTaskWithStep("task2", "x1cff77_done"),
      createTaskWithStep("task3", "other_workflow_done"),
    ];

    const groups = groupTasksByStep(tasks, stepsWithLegacyIds);

    expect(groups.get("done")?.length).toBe(3);
  });

  it("matches longer step names first to avoid partial matches", () => {
    const stepsWithSimilarNames: Step[] = [
      createStep("s1", "review", 0),
      createStep("s2", "pending_review", 1),
    ];

    const tasks: Task[] = [
      createTaskWithStep("task1", "default_pending_review"),
      createTaskWithStep("task2", "default_review"),
    ];

    const groups = groupTasksByStep(tasks, stepsWithSimilarNames);

    expect(groups.get("pending_review")?.length).toBe(1);
    expect(groups.get("pending_review")?.[0].id).toBe("task1");

    expect(groups.get("review")?.length).toBe(1);
    expect(groups.get("review")?.[0].id).toBe("task2");
  });

  it("matches exact step name when current_step_id equals step name", () => {
    const tasks: Task[] = [
      createTaskWithStep("task1", "done"),
      createTaskWithStep("task2", "todo"),
    ];

    const groups = groupTasksByStep(tasks, stepsWithLegacyIds);

    expect(groups.get("done")?.length).toBe(1);
    expect(groups.get("todo")?.length).toBe(1);
  });

  it("prefers direct ID match over suffix match", () => {
    const tasks: Task[] = [
      createTaskWithStep("task1", "abc123xyz"),
    ];

    const groups = groupTasksByStep(tasks, stepsWithRandomIds);

    expect(groups.get("todo")?.length).toBe(1);
    expect(groups.get("todo")?.[0].id).toBe("task1");
  });
});

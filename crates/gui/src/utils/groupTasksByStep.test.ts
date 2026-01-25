import { describe, it, expect } from "vitest";
import { groupTasksByStep } from "./groupTasksByStep";
import type { Step, Task, TaskWithRelations } from "../bindings";

// Helper to create a minimal Task
function createTask(id: string, currentStepId: string | null): Task {
  return {
    id,
    title: `Task ${id}`,
    description: null,
    level: "task",
    status: "backlog",
    priority: null,
    tags: [],
    created_at: null,
    updated_at: null,
    started_at: null,
    completed_at: null,
    sections: [],
    code_refs: [],
    needs_human_review: null,
    revision_feedback: null,
    rejection_reason: null,
    workflow_id: null,
    current_step: null,
    current_step_id: currentStepId,
  };
}

// Helper to create a TaskWithRelations
function createTaskWithRelations(
  id: string,
  currentStepId: string | null
): TaskWithRelations {
  return {
    task: createTask(id, currentStepId),
    parent: null,
    children: [],
    dependencies: [],
    dependents: [],
  };
}

// Helper to create a Step
function createStep(id: string, name: string, order: number): Step {
  return {
    id,
    name,
    workflow_id: "test_workflow",
    agent_config: {
      model: "haiku",
      tools: [],
      temperature: null,
      max_tokens: null,
      system_prompt: null,
    },
    is_final: false,
    order,
    validation_gates: [],
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
    const tasks: TaskWithRelations[] = [
      createTaskWithRelations("task1", "abc123xyz"),
      createTaskWithRelations("task2", "def456uvw"),
      createTaskWithRelations("task3", "ghi789rst"),
    ];

    const groups = groupTasksByStep(tasks, stepsWithRandomIds);

    expect(groups.get("todo")?.length).toBe(1);
    expect(groups.get("todo")?.[0].task.id).toBe("task1");

    expect(groups.get("in_progress")?.length).toBe(1);
    expect(groups.get("in_progress")?.[0].task.id).toBe("task2");

    expect(groups.get("done")?.length).toBe(1);
    expect(groups.get("done")?.[0].task.id).toBe("task3");
  });

  it("groups tasks by matching step name as suffix (legacy format)", () => {
    const tasks: TaskWithRelations[] = [
      createTaskWithRelations("task1", "default_todo"),
      createTaskWithRelations("task2", "default_done"),
      createTaskWithRelations("task3", "x1cff77_in_progress"),
    ];

    const groups = groupTasksByStep(tasks, stepsWithLegacyIds);

    expect(groups.get("todo")?.length).toBe(1);
    expect(groups.get("todo")?.[0].task.id).toBe("task1");

    expect(groups.get("done")?.length).toBe(1);
    expect(groups.get("done")?.[0].task.id).toBe("task2");

    expect(groups.get("in_progress")?.length).toBe(1);
    expect(groups.get("in_progress")?.[0].task.id).toBe("task3");
  });

  it("handles multi-word step names like in_progress", () => {
    const tasks: TaskWithRelations[] = [
      createTaskWithRelations("task1", "default_in_progress"),
      createTaskWithRelations("task2", "workflow123_in_progress"),
    ];

    const groups = groupTasksByStep(tasks, stepsWithLegacyIds);

    expect(groups.get("in_progress")?.length).toBe(2);
    expect(groups.get("in_progress")?.[0].task.id).toBe("task1");
    expect(groups.get("in_progress")?.[1].task.id).toBe("task2");
  });

  it("falls back to first step when current_step_id is null", () => {
    const tasks: TaskWithRelations[] = [createTaskWithRelations("task1", null)];

    const groups = groupTasksByStep(tasks, stepsWithLegacyIds);

    expect(groups.get("todo")?.length).toBe(1);
    expect(groups.get("todo")?.[0].task.id).toBe("task1");
  });

  it("falls back to first step when step ID does not match", () => {
    const tasks: TaskWithRelations[] = [
      createTaskWithRelations("task1", "unknown_random_id"),
    ];

    const groups = groupTasksByStep(tasks, stepsWithRandomIds);

    expect(groups.get("todo")?.length).toBe(1);
    expect(groups.get("todo")?.[0].task.id).toBe("task1");
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

    const tasks: TaskWithRelations[] = [
      createTaskWithRelations("task1", null), // Should go to first step by order
    ];

    const groups = groupTasksByStep(tasks, unorderedSteps);

    // Should fall back to "todo" (order 0), not "done" (first in array)
    expect(groups.get("todo")?.length).toBe(1);
  });

  it("handles case-insensitive step ID matching", () => {
    const tasks: TaskWithRelations[] = [
      createTaskWithRelations("task1", "ABC123XYZ"),
      createTaskWithRelations("task2", "GHI789RST"),
    ];

    const groups = groupTasksByStep(tasks, stepsWithRandomIds);

    expect(groups.get("todo")?.length).toBe(1);
    expect(groups.get("done")?.length).toBe(1);
  });

  it("handles case-insensitive legacy step matching", () => {
    const tasks: TaskWithRelations[] = [
      createTaskWithRelations("task1", "DEFAULT_TODO"),
      createTaskWithRelations("task2", "x1cff77_DONE"),
    ];

    const groups = groupTasksByStep(tasks, stepsWithLegacyIds);

    expect(groups.get("todo")?.length).toBe(1);
    expect(groups.get("done")?.length).toBe(1);
  });

  it("handles steps from different workflows pointing to same step name", () => {
    const tasks: TaskWithRelations[] = [
      createTaskWithRelations("task1", "default_done"),
      createTaskWithRelations("task2", "x1cff77_done"),
      createTaskWithRelations("task3", "other_workflow_done"),
    ];

    const groups = groupTasksByStep(tasks, stepsWithLegacyIds);

    expect(groups.get("done")?.length).toBe(3);
  });

  it("matches longer step names first to avoid partial matches", () => {
    // If we have steps "review" and "pending_review", "default_pending_review"
    // should match "pending_review", not "review"
    const stepsWithSimilarNames: Step[] = [
      createStep("s1", "review", 0),
      createStep("s2", "pending_review", 1),
    ];

    const tasks: TaskWithRelations[] = [
      createTaskWithRelations("task1", "default_pending_review"),
      createTaskWithRelations("task2", "default_review"),
    ];

    const groups = groupTasksByStep(tasks, stepsWithSimilarNames);

    expect(groups.get("pending_review")?.length).toBe(1);
    expect(groups.get("pending_review")?.[0].task.id).toBe("task1");

    expect(groups.get("review")?.length).toBe(1);
    expect(groups.get("review")?.[0].task.id).toBe("task2");
  });

  it("matches exact step name when current_step_id equals step name", () => {
    const tasks: TaskWithRelations[] = [
      createTaskWithRelations("task1", "done"),
      createTaskWithRelations("task2", "todo"),
    ];

    const groups = groupTasksByStep(tasks, stepsWithLegacyIds);

    expect(groups.get("done")?.length).toBe(1);
    expect(groups.get("todo")?.length).toBe(1);
  });

  it("prefers direct ID match over suffix match", () => {
    // If a step ID happens to match both directly and as a suffix
    // (e.g., task has ID "abc123xyz" and there's a step with that ID),
    // direct match should win
    const tasks: TaskWithRelations[] = [
      createTaskWithRelations("task1", "abc123xyz"),
    ];

    const groups = groupTasksByStep(tasks, stepsWithRandomIds);

    expect(groups.get("todo")?.length).toBe(1);
    expect(groups.get("todo")?.[0].task.id).toBe("task1");
  });
});

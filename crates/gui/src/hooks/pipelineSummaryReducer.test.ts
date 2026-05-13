import { describe, expect, it } from "vitest";
import type {
  PipelineStep,
  PipelineSummary,
  PipelineWorkflow,
  Step,
  TaskChangedEvent,
  TaskLevel,
  TaskRunStatus,
  Workflow,
} from "../bindings";
import {
  applyStepCreated,
  applyStepDeleted,
  applyStepTransitionCreated,
  applyStepTransitionDeleted,
  applyStepUpdated,
  applyTaskCreated,
  applyTaskDeleted,
  applyTaskRunStepChanged,
  applyTaskStepChanged,
  applyTaskUpdated,
  applyWorkflowCreated,
  applyWorkflowDeleted,
  applyWorkflowTransitionCreated,
  applyWorkflowTransitionDeleted,
  applyWorkflowUpdated,
} from "./pipelineSummaryReducer";

function makeStep(
  id: string,
  workflowId: string,
  name: string,
  order: number,
  taskCounts: { epic: number; ticket: number; task: number } = {
    epic: 0,
    ticket: 0,
    task: 0,
  },
  activeCount = 0,
): PipelineStep {
  return {
    id,
    name,
    workflow_id: workflowId,
    goal: null,
    step_order: order,
    step_type: "execute",
    is_final: false,
    transitions_to: [],
    task_counts: taskCounts,
    pipeline_counts: { ...taskCounts, active: activeCount },
    active_count: activeCount,
  };
}

function makeWorkflow(id: string, steps: PipelineStep[]): PipelineWorkflow {
  return {
    id,
    name: id,
    description: null,
    initial_step_id: steps[0]?.id ?? null,
    kanban_column: null,
    is_default: false,
    is_final: false,
    display_order: 0,
    workflow_steps: steps,
    transitions: [],
  };
}

function makeSummary(workflows: PipelineWorkflow[]): PipelineSummary {
  return { workflows };
}

function findStep(summary: PipelineSummary, stepId: string): PipelineStep {
  for (const wf of summary.workflows) {
    for (const step of wf.workflow_steps) {
      if (step.id === stepId) return step;
    }
  }
  throw new Error(`step ${stepId} not found`);
}

function deletedEvent(
  taskId: string,
  current_step_id: string | null,
  level: TaskLevel | null,
  archived: boolean | null = false,
): TaskChangedEvent {
  return {
    task_id: taskId,
    change_type: "Deleted",
    task: null,
    current_step_id,
    workflow_id: null,
    level,
    archived,
  };
}

describe("applyTaskCreated", () => {
  it("bumps the destination bucket by +1", () => {
    const summary = makeSummary([
      makeWorkflow("wf-1", [makeStep("s1", "wf-1", "todo", 0)]),
    ]);

    const next = applyTaskCreated(summary, {
      current_step_id: "s1",
      level: "ticket",
      archived: false,
    });

    expect(findStep(next, "s1").task_counts.ticket).toBe(1);
    expect(findStep(next, "s1").pipeline_counts.ticket).toBe(1);
  });

  it("no-ops when archived", () => {
    const summary = makeSummary([
      makeWorkflow("wf-1", [makeStep("s1", "wf-1", "todo", 0)]),
    ]);

    const next = applyTaskCreated(summary, {
      current_step_id: "s1",
      level: "ticket",
      archived: true,
    });

    expect(next).toBe(summary);
  });

  it("no-ops when step_id is null", () => {
    const summary = makeSummary([
      makeWorkflow("wf-1", [makeStep("s1", "wf-1", "todo", 0)]),
    ]);

    const next = applyTaskCreated(summary, {
      current_step_id: null,
      level: "ticket",
      archived: false,
    });

    expect(next).toBe(summary);
  });

  it("no-ops when level is null", () => {
    const summary = makeSummary([
      makeWorkflow("wf-1", [makeStep("s1", "wf-1", "todo", 0)]),
    ]);

    const next = applyTaskCreated(summary, {
      current_step_id: "s1",
      level: null,
      archived: false,
    });

    expect(next).toBe(summary);
  });
});

describe("applyTaskUpdated", () => {
  it("is a no-op (moves and archive flips are not the reducer's concern)", () => {
    const summary = makeSummary([
      makeWorkflow("wf-1", [
        makeStep("s1", "wf-1", "todo", 0, { epic: 0, ticket: 5, task: 0 }),
      ]),
    ]);

    const next = applyTaskUpdated(summary);

    expect(next).toBe(summary);
  });
});

describe("applyTaskDeleted", () => {
  it("decrements the step bucket from the event's before-image", () => {
    const summary = makeSummary([
      makeWorkflow("wf-1", [
        makeStep("s1", "wf-1", "todo", 0, { epic: 0, ticket: 3, task: 0 }),
      ]),
    ]);

    const next = applyTaskDeleted(summary, deletedEvent("t-1", "s1", "ticket"));

    expect(findStep(next, "s1").task_counts.ticket).toBe(2);
  });

  it("no-ops when the deleted task was archived", () => {
    const summary = makeSummary([
      makeWorkflow("wf-1", [
        makeStep("s1", "wf-1", "todo", 0, { epic: 0, ticket: 3, task: 0 }),
      ]),
    ]);

    const next = applyTaskDeleted(
      summary,
      deletedEvent("t-1", "s1", "ticket", true),
    );

    expect(next).toBe(summary);
  });

  it("no-ops when step_id is null", () => {
    const summary = makeSummary([
      makeWorkflow("wf-1", [
        makeStep("s1", "wf-1", "todo", 0, { epic: 0, ticket: 3, task: 0 }),
      ]),
    ]);

    const next = applyTaskDeleted(summary, deletedEvent("t-1", null, "ticket"));

    expect(next).toBe(summary);
  });

  it("clamps at zero rather than going negative", () => {
    const summary = makeSummary([
      makeWorkflow("wf-1", [
        makeStep("s1", "wf-1", "todo", 0, { epic: 0, ticket: 0, task: 0 }),
      ]),
    ]);

    const next = applyTaskDeleted(summary, deletedEvent("t-1", "s1", "ticket"));

    expect(findStep(next, "s1").task_counts.ticket).toBe(0);
  });
});

describe("applyTaskStepChanged", () => {
  it("moves a ticket from one step to another", () => {
    const summary = makeSummary([
      makeWorkflow("wf-1", [
        makeStep("s1", "wf-1", "todo", 0, { epic: 0, ticket: 2, task: 0 }),
        makeStep("s2", "wf-1", "doing", 1, { epic: 0, ticket: 0, task: 0 }),
      ]),
    ]);

    const next = applyTaskStepChanged(summary, {
      task_id: "t-1",
      from_step_id: "s1",
      to_step_id: "s2",
      workflow_id: "wf-1",
      level: "ticket",
    });

    expect(findStep(next, "s1").task_counts.ticket).toBe(1);
    expect(findStep(next, "s2").task_counts.ticket).toBe(1);
  });

  it("does not touch active count", () => {
    const summary = makeSummary([
      makeWorkflow("wf-1", [
        makeStep("s1", "wf-1", "todo", 0, { epic: 0, ticket: 1, task: 0 }, 1),
        makeStep("s2", "wf-1", "doing", 1, { epic: 0, ticket: 0, task: 0 }, 0),
      ]),
    ]);

    const next = applyTaskStepChanged(summary, {
      task_id: "t-1",
      from_step_id: "s1",
      to_step_id: "s2",
      workflow_id: "wf-1",
      level: "ticket",
    });

    expect(findStep(next, "s1").active_count).toBe(1);
    expect(findStep(next, "s2").active_count).toBe(0);
  });
});

describe("applyTaskRunStepChanged", () => {
  it("moves task and active count for an active status", () => {
    const summary = makeSummary([
      makeWorkflow("wf-1", [
        makeStep("s1", "wf-1", "todo", 0, { epic: 0, ticket: 1, task: 0 }, 1),
        makeStep("s2", "wf-1", "doing", 1, { epic: 0, ticket: 0, task: 0 }, 0),
      ]),
    ]);

    const next = applyTaskRunStepChanged(summary, {
      task_run_id: "r-1",
      task_id: "t-1",
      from_step_id: "s1",
      to_step_id: "s2",
      status: "executing" as TaskRunStatus,
      level: "ticket",
    });

    expect(findStep(next, "s1").task_counts.ticket).toBe(0);
    expect(findStep(next, "s1").active_count).toBe(0);
    expect(findStep(next, "s2").task_counts.ticket).toBe(1);
    expect(findStep(next, "s2").active_count).toBe(1);
  });

  it("on run-end (to=null) decrements only active count, not task count", () => {
    const summary = makeSummary([
      makeWorkflow("wf-1", [
        makeStep("s1", "wf-1", "todo", 0, { epic: 0, ticket: 1, task: 0 }, 1),
      ]),
    ]);

    const next = applyTaskRunStepChanged(summary, {
      task_run_id: "r-1",
      task_id: "t-1",
      from_step_id: "s1",
      to_step_id: null,
      status: "completed" as TaskRunStatus,
      level: "ticket",
    });

    expect(findStep(next, "s1").task_counts.ticket).toBe(1);
    expect(findStep(next, "s1").active_count).toBe(0);
  });

  it("non-active status moves task but does not bump destination active", () => {
    const summary = makeSummary([
      makeWorkflow("wf-1", [
        makeStep("s1", "wf-1", "todo", 0, { epic: 0, ticket: 1, task: 0 }, 1),
        makeStep("s2", "wf-1", "doing", 1, { epic: 0, ticket: 0, task: 0 }, 0),
      ]),
    ]);

    const next = applyTaskRunStepChanged(summary, {
      task_run_id: "r-1",
      task_id: "t-1",
      from_step_id: "s1",
      to_step_id: "s2",
      status: "completed" as TaskRunStatus,
      level: "ticket",
    });

    expect(findStep(next, "s2").task_counts.ticket).toBe(1);
    expect(findStep(next, "s2").active_count).toBe(0);
  });
});

describe("structural sharing", () => {
  it("reuses workflow object refs for untouched workflows", () => {
    const summary = makeSummary([
      makeWorkflow("wf-1", [
        makeStep("s1", "wf-1", "todo", 0, { epic: 0, ticket: 1, task: 0 }),
      ]),
      makeWorkflow("wf-2", [makeStep("s2", "wf-2", "todo", 0)]),
    ]);

    const next = applyTaskDeleted(summary, deletedEvent("t-1", "s1", "ticket"));

    expect(next.workflows[1]).toBe(summary.workflows[1]);
    expect(next.workflows[0]).not.toBe(summary.workflows[0]);
  });
});

// ---------------------------------------------------------------------------
// Topology
// ---------------------------------------------------------------------------

function fakeWorkflow(
  id: string,
  display_order: number,
  overrides: Partial<Workflow> = {},
): Workflow {
  return {
    id,
    name: id,
    description: null,
    initial_step: null,
    kanban_column: null,
    is_default: false,
    is_final: false,
    display_order,
    created_at: null,
    updated_at: null,
    ...overrides,
  };
}

function fakeStep(
  id: string,
  workflow_id: string,
  order: number,
  overrides: Partial<Step> = {},
): Step {
  return {
    id,
    name: id,
    workflow_id,
    goal: null,
    prompt: null,
    is_final: false,
    transitions_to: [],
    order,
    created_at: null,
    updated_at: null,
    ...overrides,
  };
}

describe("applyWorkflowCreated", () => {
  it("inserts a new workflow sorted by display_order", () => {
    const summary = makeSummary([
      { ...makeWorkflow("wf-1", []), display_order: 0 },
      { ...makeWorkflow("wf-3", []), display_order: 2 },
    ]);

    const next = applyWorkflowCreated(summary, fakeWorkflow("wf-2", 1));

    expect(next.workflows.map((wf) => wf.id)).toEqual(["wf-1", "wf-2", "wf-3"]);
    expect(next.workflows[1].workflow_steps).toEqual([]);
    expect(next.workflows[1].transitions).toEqual([]);
  });

  it("ignores duplicate workflow ids", () => {
    const summary = makeSummary([makeWorkflow("wf-1", [])]);

    const next = applyWorkflowCreated(summary, fakeWorkflow("wf-1", 5));

    expect(next).toBe(summary);
  });

  it("skips when the workflow has no id", () => {
    const summary = makeSummary([]);

    const next = applyWorkflowCreated(summary, fakeWorkflow("", 0, { id: null }));

    expect(next).toBe(summary);
  });
});

describe("applyWorkflowUpdated", () => {
  it("patches workflow-level fields while preserving children", () => {
    const summary = makeSummary([
      makeWorkflow("wf-1", [makeStep("s1", "wf-1", "todo", 0)]),
    ]);

    const next = applyWorkflowUpdated(
      summary,
      fakeWorkflow("wf-1", 0, { name: "renamed", kanban_column: "Doing" }),
    );

    expect(next.workflows[0].name).toBe("renamed");
    expect(next.workflows[0].kanban_column).toBe("Doing");
    expect(next.workflows[0].workflow_steps).toBe(
      summary.workflows[0].workflow_steps,
    );
  });

  it("re-sorts when display_order changes", () => {
    const summary = makeSummary([
      { ...makeWorkflow("wf-1", []), display_order: 0 },
      { ...makeWorkflow("wf-2", []), display_order: 1 },
    ]);

    const next = applyWorkflowUpdated(summary, fakeWorkflow("wf-1", 5));

    expect(next.workflows.map((wf) => wf.id)).toEqual(["wf-2", "wf-1"]);
  });

  it("inserts when the workflow is unknown (treats as create)", () => {
    const summary = makeSummary([makeWorkflow("wf-1", [])]);

    const next = applyWorkflowUpdated(summary, fakeWorkflow("wf-2", 2));

    expect(next.workflows.map((wf) => wf.id)).toEqual(["wf-1", "wf-2"]);
  });
});

describe("applyWorkflowDeleted", () => {
  it("removes the workflow", () => {
    const summary = makeSummary([
      makeWorkflow("wf-1", []),
      makeWorkflow("wf-2", []),
    ]);

    const next = applyWorkflowDeleted(summary, "wf-1");

    expect(next.workflows.map((wf) => wf.id)).toEqual(["wf-2"]);
  });

  it("no-ops when the workflow is unknown", () => {
    const summary = makeSummary([makeWorkflow("wf-1", [])]);

    const next = applyWorkflowDeleted(summary, "wf-missing");

    expect(next).toBe(summary);
  });
});

describe("applyStepCreated", () => {
  it("inserts a new step sorted by step_order with zero counts", () => {
    const summary = makeSummary([
      makeWorkflow("wf-1", [
        makeStep("s1", "wf-1", "todo", 0),
        makeStep("s3", "wf-1", "doing", 2),
      ]),
    ]);

    const next = applyStepCreated(summary, fakeStep("s2", "wf-1", 1));

    const wf = next.workflows[0];
    expect(wf.workflow_steps.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    expect(wf.workflow_steps[1].task_counts).toEqual({
      epic: 0,
      ticket: 0,
      task: 0,
    });
    expect(wf.workflow_steps[1].pipeline_counts.active).toBe(0);
  });

  it("no-ops when workflow_id is unknown", () => {
    const summary = makeSummary([makeWorkflow("wf-1", [])]);

    const next = applyStepCreated(summary, fakeStep("s1", "wf-missing", 0));

    expect(next).toBe(summary);
  });

  it("ignores duplicate step ids", () => {
    const summary = makeSummary([
      makeWorkflow("wf-1", [makeStep("s1", "wf-1", "todo", 0)]),
    ]);

    const next = applyStepCreated(summary, fakeStep("s1", "wf-1", 5));

    expect(next).toBe(summary);
  });
});

describe("applyStepUpdated", () => {
  it("patches step fields while preserving counts", () => {
    const summary = makeSummary([
      makeWorkflow("wf-1", [
        makeStep("s1", "wf-1", "todo", 0, { epic: 0, ticket: 3, task: 0 }, 1),
      ]),
    ]);

    const next = applyStepUpdated(
      summary,
      fakeStep("s1", "wf-1", 0, { name: "Renamed", goal: "Reviewed" }),
    );

    const step = next.workflows[0].workflow_steps[0];
    expect(step.name).toBe("Renamed");
    expect(step.goal).toBe("Reviewed");
    expect(step.task_counts.ticket).toBe(3);
    expect(step.active_count).toBe(1);
  });

  it("re-sorts when step_order changes", () => {
    const summary = makeSummary([
      makeWorkflow("wf-1", [
        makeStep("s1", "wf-1", "todo", 0),
        makeStep("s2", "wf-1", "doing", 1),
      ]),
    ]);

    const next = applyStepUpdated(summary, fakeStep("s1", "wf-1", 5));

    expect(next.workflows[0].workflow_steps.map((s) => s.id)).toEqual([
      "s2",
      "s1",
    ]);
  });
});

describe("applyStepDeleted", () => {
  it("removes the step", () => {
    const summary = makeSummary([
      makeWorkflow("wf-1", [
        makeStep("s1", "wf-1", "todo", 0),
        makeStep("s2", "wf-1", "doing", 1),
      ]),
    ]);

    const next = applyStepDeleted(summary, "s1", "wf-1");

    expect(next.workflows[0].workflow_steps.map((s) => s.id)).toEqual(["s2"]);
  });

  it("strips the deleted step id from other steps' transitions_to", () => {
    const stepWithTransition: PipelineStep = {
      ...makeStep("s1", "wf-1", "todo", 0),
      transitions_to: ["s2", "s3"],
    };
    const summary = makeSummary([
      makeWorkflow("wf-1", [
        stepWithTransition,
        makeStep("s2", "wf-1", "doing", 1),
        makeStep("s3", "wf-1", "done", 2),
      ]),
    ]);

    const next = applyStepDeleted(summary, "s2", "wf-1");

    expect(next.workflows[0].workflow_steps[0].transitions_to).toEqual(["s3"]);
  });

  it("no-ops when the step is unknown", () => {
    const summary = makeSummary([makeWorkflow("wf-1", [])]);

    const next = applyStepDeleted(summary, "s-missing", "wf-1");

    expect(next).toBe(summary);
  });
});

describe("applyStepTransitionCreated", () => {
  it("adds to_step_id to from_step's transitions_to", () => {
    const summary = makeSummary([
      makeWorkflow("wf-1", [
        makeStep("s1", "wf-1", "todo", 0),
        makeStep("s2", "wf-1", "doing", 1),
      ]),
    ]);

    const next = applyStepTransitionCreated(summary, {
      transition_id: "tr-1",
      from_step_id: "s1",
      to_step_id: "s2",
      change_type: "Created",
    });

    expect(next.workflows[0].workflow_steps[0].transitions_to).toEqual(["s2"]);
  });

  it("is idempotent on duplicate transitions_to", () => {
    const step: PipelineStep = {
      ...makeStep("s1", "wf-1", "todo", 0),
      transitions_to: ["s2"],
    };
    const summary = makeSummary([makeWorkflow("wf-1", [step])]);

    const next = applyStepTransitionCreated(summary, {
      transition_id: "tr-1",
      from_step_id: "s1",
      to_step_id: "s2",
      change_type: "Created",
    });

    expect(next.workflows[0].workflow_steps[0].transitions_to).toEqual(["s2"]);
  });
});

describe("applyStepTransitionDeleted", () => {
  it("removes the transition using event endpoints", () => {
    const step: PipelineStep = {
      ...makeStep("s1", "wf-1", "todo", 0),
      transitions_to: ["s2", "s3"],
    };
    const summary = makeSummary([makeWorkflow("wf-1", [step])]);

    const next = applyStepTransitionDeleted(summary, {
      transition_id: "tr-1",
      from_step_id: "s1",
      to_step_id: "s2",
      change_type: "Deleted",
    });

    expect(next.workflows[0].workflow_steps[0].transitions_to).toEqual(["s3"]);
  });

  it("no-ops when endpoints are missing", () => {
    const summary = makeSummary([
      makeWorkflow("wf-1", [makeStep("s1", "wf-1", "todo", 0)]),
    ]);

    const next = applyStepTransitionDeleted(summary, {
      transition_id: "tr-unknown",
      from_step_id: null,
      to_step_id: null,
      change_type: "Deleted",
    });

    expect(next).toBe(summary);
  });
});

describe("applyWorkflowTransitionCreated", () => {
  it("appends a workflow transition with the carried fields", () => {
    const summary = makeSummary([
      makeWorkflow("wf-1", []),
      makeWorkflow("wf-2", []),
    ]);

    const next = applyWorkflowTransitionCreated(summary, {
      transition_id: "wt-1",
      from_workflow_id: "wf-1",
      to_workflow_id: "wf-2",
      target_step_id: "s-2a",
      label: "Done",
      change_type: "Created",
    });

    expect(next.workflows[0].transitions).toEqual([
      {
        id: "wt-1",
        from_workflow_id: "wf-1",
        to_workflow_id: "wf-2",
        target_step_id: "s-2a",
        label: "Done",
      },
    ]);
  });

  it("no-ops when from_workflow_id is missing", () => {
    const summary = makeSummary([makeWorkflow("wf-1", [])]);

    const next = applyWorkflowTransitionCreated(summary, {
      transition_id: "wt-1",
      from_workflow_id: null,
      to_workflow_id: "wf-2",
      target_step_id: null,
      label: null,
      change_type: "Created",
    });

    expect(next).toBe(summary);
  });
});

describe("applyWorkflowTransitionDeleted", () => {
  it("removes the transition from from_workflow_id", () => {
    const wf1: PipelineWorkflow = {
      ...makeWorkflow("wf-1", []),
      transitions: [
        {
          id: "wt-1",
          from_workflow_id: "wf-1",
          to_workflow_id: "wf-2",
          target_step_id: null,
          label: "Done",
        },
      ],
    };
    const summary = makeSummary([wf1, makeWorkflow("wf-2", [])]);

    const next = applyWorkflowTransitionDeleted(summary, {
      transition_id: "wt-1",
      from_workflow_id: "wf-1",
      to_workflow_id: null,
      target_step_id: null,
      label: null,
      change_type: "Deleted",
    });

    expect(next.workflows[0].transitions).toEqual([]);
  });

  it("falls back to scanning when from_workflow_id is missing", () => {
    const wf1: PipelineWorkflow = {
      ...makeWorkflow("wf-1", []),
      transitions: [
        {
          id: "wt-1",
          from_workflow_id: "wf-1",
          to_workflow_id: "wf-2",
          target_step_id: null,
          label: "Done",
        },
      ],
    };
    const summary = makeSummary([wf1]);

    const next = applyWorkflowTransitionDeleted(summary, {
      transition_id: "wt-1",
      from_workflow_id: null,
      to_workflow_id: null,
      target_step_id: null,
      label: null,
      change_type: "Deleted",
    });

    expect(next.workflows[0].transitions).toEqual([]);
  });
});

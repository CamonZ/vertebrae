import { describe, expect, it } from "vitest";
import {
  createMockStep,
  createMockTask,
  createMockWorkflow,
} from "../test/test-utils";
import {
  resolveTaskLocation,
  taskLocationStepLabel,
  taskLocationWorkflowLabel,
} from "./taskLocation";

describe("resolveTaskLocation", () => {
  const step = createMockStep({
    id: "step-1",
    workflow_id: "workflow-from-step",
    name: "Renamed step",
    step_type: "evaluate",
  });
  const workflow = createMockWorkflow({
    id: "workflow-from-step",
    name: "Renamed workflow",
  });

  it("derives the workflow from Step.workflow_id when Task.workflow_id is null", () => {
    const location = resolveTaskLocation(
      createMockTask({ workflow_id: null, current_step_id: "step-1" }),
      step,
      workflow
    );

    expect(location).toMatchObject({
      status: "assigned",
      workflowId: "workflow-from-step",
      workflowName: "Renamed workflow",
      stepName: "Renamed step",
      stepType: "evaluate",
    });
  });

  it("never falls back to embedded task labels when cache records are missing", () => {
    const location = resolveTaskLocation(
      createMockTask({
        workflow_id: "workflow-old",
        current_step_id: "step-old",
        workflow_name: "Old workflow",
        step_name: "Old step",
        step_type: "execute",
      }),
      undefined,
      undefined
    );

    expect(location.status).toBe("unavailable");
    expect(taskLocationWorkflowLabel(location)).toBe("Unavailable");
    expect(taskLocationStepLabel(location)).toBe("Unavailable");
  });

  it("returns an explicit unassigned result when no location IDs exist", () => {
    const location = resolveTaskLocation(
      createMockTask({ workflow_id: null, current_step_id: null }),
      undefined,
      undefined
    );

    expect(location).toMatchObject({
      status: "unassigned",
      workflowId: null,
      stepId: null,
    });
    expect(taskLocationWorkflowLabel(location)).toBe("Unassigned");
    expect(taskLocationStepLabel(location)).toBe("Unassigned");
  });

  it("keeps a known workflow name when the task has no current step", () => {
    const location = resolveTaskLocation(
      createMockTask({ workflow_id: workflow.id, current_step_id: null }),
      undefined,
      workflow
    );

    expect(location).toMatchObject({
      status: "unavailable",
      workflowName: "Renamed workflow",
      stepName: null,
    });
  });

  it("preserves finish as the task location step type", () => {
    const finish = createMockStep({
      id: "finish-1",
      workflow_id: workflow.id,
      name: "Finish",
      step_type: "finish",
    });
    const location = resolveTaskLocation(
      createMockTask({ workflow_id: workflow.id, current_step_id: finish.id }),
      finish,
      workflow
    );

    expect(location).toMatchObject({ status: "assigned", stepType: "finish" });
  });
});

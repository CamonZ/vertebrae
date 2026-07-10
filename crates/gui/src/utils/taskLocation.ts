import type { Step, StepType, Task, Workflow } from "../bindings";

export type TaskLocationStatus = "assigned" | "unassigned" | "unavailable";

export interface TaskLocation {
  status: TaskLocationStatus;
  workflowId: string | null;
  workflowName: string | null;
  stepId: string | null;
  stepName: string | null;
  stepType: StepType | null;
}

/**
 * Resolve the canonical task location from persisted IDs and server-state
 * entities. Embedded Task location labels are deliberately not accepted here:
 * they are compatibility fields and can be stale after a rename.
 */
export function resolveTaskLocation(
  task: Pick<Task, "workflow_id" | "current_step_id">,
  step: Step | null | undefined,
  workflow: Workflow | null | undefined
): TaskLocation {
  const stepId = task.current_step_id ?? null;
  const workflowId = task.workflow_id ?? step?.workflow_id ?? null;

  if (!stepId && !workflowId) {
    return {
      status: "unassigned",
      workflowId: null,
      workflowName: null,
      stepId: null,
      stepName: null,
      stepType: null,
    };
  }

  if (!stepId || !step) {
    return {
      status: "unavailable",
      workflowId,
      workflowName: workflow?.name ?? null,
      stepId,
      stepName: null,
      stepType: null,
    };
  }

  if (!workflowId || !workflow) {
    return {
      status: "unavailable",
      workflowId,
      workflowName: workflow?.name ?? null,
      stepId,
      stepName: step.name,
      stepType: step.step_type ?? null,
    };
  }

  return {
    status: "assigned",
    workflowId,
    workflowName: workflow.name,
    stepId,
    stepName: step.name,
    stepType: step.step_type ?? null,
  };
}

export function taskLocationWorkflowLabel(location: TaskLocation): string {
  if (location.status === "unassigned") return "Unassigned";
  return location.workflowName ?? "Unavailable";
}

export function taskLocationStepLabel(location: TaskLocation): string {
  if (location.status === "unassigned") return "Unassigned";
  return location.stepName ?? "Unavailable";
}

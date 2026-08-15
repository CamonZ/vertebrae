/* ──────────────────────────────────────────────────────────────────
   Workflow Atlas — inspector selection model + kind-class helper.

   `AtlasSelection` is the single selection state the canvas and the inspector
   share. Clicking a workflow box opens `{type:'workflow'}`; clicking a step node
   opens `{type:'step'}`. The inspector's clickable transitions emit new
   selections through `onSelect`, so the panel walks the topology in place.
   ────────────────────────────────────────────────────────────────── */
import type { AtlasModel, Kind } from "../layout/types";

/** What the inspector is currently focused on. */
export type AtlasSelection =
  | { type: "workflow"; workflowId: string }
  | { type: "step"; workflowId: string; stepId: string };

export interface AtlasTargetIds {
  workflowId?: string | null;
  stepId?: string | null;
}

export function selectionFromWorkflowTarget(
  model: AtlasModel,
  target: AtlasTargetIds
): AtlasSelection | null {
  const workflowId = target.workflowId?.trim() ?? "";
  const stepId = target.stepId?.trim() ?? "";

  if (stepId) {
    const step = model.steps.find(
      (candidate) =>
        (workflowId ? candidate.workflowId === workflowId : true) &&
        (candidate.stepId === stepId || candidate.id === stepId)
    );
    if (step) {
      return {
        type: "step",
        workflowId: step.workflowId,
        stepId: step.stepId,
      };
    }
  }

  if (
    workflowId &&
    model.workflows.some((workflow) => workflow.id === workflowId)
  ) {
    return { type: "workflow", workflowId };
  }

  return null;
}

/**
 * Map an Atlas `Kind` to its `k-<kind>` carrier class (the trio --kc/--kf/--kw
 * lives in src/index.css). `final` carries the terminal/ok hue under `k-final`.
 */
export function kindClass(kind: Kind): string {
  return "k-" + kind;
}
